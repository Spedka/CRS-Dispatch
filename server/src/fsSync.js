import { createFs } from './fieldSquared.js';
import { createSalesforce } from './salesforce.js';
import { config, statusFieldForType, allStatusFields } from './config.js';
import { getTechDirectory } from './assignments.js';
import { notifyTech } from './notifyBoard.js';
import { isFsStatusCompatible } from './statusMap.js';

const f = config.fields;
const o = config.objects;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const OVERLAP_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_UNLINKED_PER_RUN = 30;
// A task modified within this window is "fresh" - never skip-listed on a no-match,
// so a WO created just before its SF opp keeps retrying every tick instead of
// being stranded for the 24h skip-list TTL.
const RECENT_NO_SKIP_MS = 2 * 24 * 60 * 60 * 1000;
// Safety cap on the drift-verification pass below - the suspect set should
// normally be small (only jobs the drift badge would actually flag), but
// this bounds worst-case FS API calls in one tick if a status-list change
// ever caused mass false-flagging.
const MAX_DRIFT_CHECK_PER_RUN = 30;
// Window for assignment reconciliation - slightly larger than the cron interval
// to avoid gaps if a run starts a few seconds late.
const RECONCILE_WINDOW_MS = 10 * 60 * 1000;

function parseWoNum(name) {
  const m = name && name.match(/^WO\s+(\d+)/i);
  return m ? m[1] : null;
}

// Skip tasks that haven't been fully filled in yet (no name or not verified).
function isLinkable(task) {
  return task.Name && task.Name.trim().length > 3;
}

function findInSf(sfByName, sfByWoNum, task) {
  const byName = sfByName.get(task.Name);
  if (byName) return byName;
  const wo = parseWoNum(task.Name);
  return wo ? (sfByWoNum.get(wo) ?? null) : null;
}

// ---- Tier-3 LID match (Test & Inspection only) ----------------------------
// FS T&I task names and the SF Opp for the same job rarely share an exact name
// or WO number (different WO#, "Test & Inspection" vs "T&I" vs "Annual", SF opps
// named by site/LOCATION_NAME). But the FS task's Data.LID_NUMBER is the site's
// LID, matching SF Opportunity.LID__c. A site gets a new T&I Opp every year, so
// LID alone is NOT unique - the safe key is LID + the year in the name + "is a
// T&I" + matching discrepancy-flag, and only when it resolves to exactly one Opp.
// Scoped to recent inspection years the office still needs on record.
const TI_YEARS = new Set(['2024', '2025', '2026']);
const tiRe = /\bt\s*&\s*i\b|test\s*(?:&|and|\/|\+)?\s*inspection/i;
const isTI = (s) => tiRe.test(s || '');
const yearInName = (s) => (String(s).match(/\b(20\d{2})\b/) || [])[1] || null;
const isDiscrep = (s) => /discrep/i.test(s || '');
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// A task is worth a (per-task) LID SOQL only if it's a T&I with a LID and an
// in-scope year - a small slice of any batch, so the tier stays within budget.
function isLidEligible(task) {
  const lid = task.Data && task.Data.LID_NUMBER;
  return !!lid && (isTI(task.Name) || isTI(task.TaskType)) && TI_YEARS.has(yearInName(task.Name));
}

// Returns the single gated Opp for this task's LID, or null (no match / ambiguous).
async function findByLid(sf, task) {
  const raw = String(task.Data.LID_NUMBER).trim();
  const stripped = raw.replace(/^0+/, ''); // SF LID__c may or may not be zero-padded
  const fy = yearInName(task.Name);
  const fd = isDiscrep(task.Name);
  const rows = await sf.query(
    `SELECT Id, ${f.oppName}, ${f.oppLid} FROM Opportunity
     WHERE (${f.oppLid} = '${esc(raw)}' OR ${f.oppLid} = '${esc(stripped)}')
       AND ${f.oppFsTaskId} = null LIMIT 100`
  );
  const hits = rows.filter((r) => {
    const nm = r[f.oppName] || '';
    return isTI(nm) && yearInName(nm) === fy && isDiscrep(nm) === fd;
  });
  return hits.length === 1 ? hits[0] : null;
}

async function stampLink(sf, oppId, task) {
  await sf.updateRecord('Opportunity', oppId, {
    [f.oppFsTaskId]: task.ExternalId,
    [f.oppFsStatus]: task.Status ?? null,
    [f.oppFsLastModified]: task.LastUpdated ?? null,
  });
}

export async function runFsSync(env) {
  const KV = env.SF_TOKENS;
  const fs = createFs(env);
  const sf = createSalesforce(env);

  const lastRunKey = 'fs_sync_last_run';
  const stored = await KV.get(lastRunKey);
  if (stored && Date.now() - new Date(stored).getTime() < MIN_INTERVAL_MS) return;
  await KV.put(lastRunKey, new Date().toISOString());

  // Use lastRun as the since window so steady-state runs only fetch recently
  // modified tasks. Fall back to ONE_YEAR_MS on the very first run (no stored value).
  const since = stored
    ? new Date(new Date(stored).getTime() - OVERLAP_MS).toISOString()
    : new Date(Date.now() - ONE_YEAR_MS).toISOString();

  // Narrow window - tasks FS reports modified since the last run. Drives the
  // status-snapshot / assignment reconcile pass, which only cares about
  // recently-touched tasks.
  let recentTasks;
  try {
    recentTasks = await fs.listModified(since);
  } catch (e) {
    console.error('[fs-sync] listModified failed:', e.message);
    return;
  }
  const linkableRecent = recentTasks.filter(isLinkable);

  // Wide window - the full past-year task list, cached in KV so we don't refetch
  // ~2k tasks every 5-min tick. This is what lets the linking pass chew through
  // the whole UNLINKED BACKLOG a batch at a time, instead of only ever seeing
  // tasks modified in the last few minutes (which left older unlinked tasks
  // stranded indefinitely). Refreshed every 30 min.
  const SCAN_CACHE_KEY = 'fs_link_scan_list';
  let scanTasks = await KV.get(SCAN_CACHE_KEY, 'json');
  if (!scanTasks) {
    try {
      scanTasks = await fs.listModified(new Date(Date.now() - ONE_YEAR_MS).toISOString());
      await KV.put(SCAN_CACHE_KEY, JSON.stringify(scanTasks), { expirationTtl: 1800 });
    } catch (e) {
      console.error('[fs-sync] scan-list fetch failed, falling back to narrow window:', e.message);
      scanTasks = recentTasks;
    }
  }

  // Linking candidates = anything just modified (recent list) FIRST, then the
  // backlog (scan list), deduped by ExternalId. Recent-first matters: toMatch is
  // capped at MAX_UNLINKED_PER_RUN and sliced from the front, so putting the
  // backlog first would starve brand-new tasks (a freshly-created WO would wait
  // behind the whole backlog drain). Recent tasks go in the first slots and link
  // on the very next tick once their SF opp exists.
  const linkCandidates = new Map();
  for (const t of recentTasks) if (isLinkable(t)) linkCandidates.set(t.ExternalId, t);
  for (const t of scanTasks) if (isLinkable(t)) linkCandidates.set(t.ExternalId, t);
  const linkable = [...linkCandidates.values()];
  console.log(`[fs-sync] ${recentTasks.length} recent / ${scanTasks.length} scanned FS tasks, ${linkable.length} linkable candidates`);

  // ONE bulk query - all SF opps that already have an FS link.
  // Includes Id so we can create/delete child assignment records without extra queries.
  let linkedOpps;
  try {
    linkedOpps = await sf.query(
      `SELECT Id, ${f.oppFsTaskId}, ${f.oppFsStatus}, RecordType.DeveloperName,
              ${allStatusFields().join(', ')}
       FROM Opportunity WHERE ${f.oppFsTaskId} != null LIMIT 2000`
    );
  } catch (e) {
    console.error('[fs-sync] bulk linked-opps query failed:', e.message);
    return;
  }

  const linkedMap = new Map(linkedOpps.map(row => [row[f.oppFsTaskId], row]));
  const linkedIds = new Set(linkedMap.keys());
  console.log(`[fs-sync] ${linkedMap.size} already linked`);

  // ---- Linking pass (unlinked tasks only, capped per run) ----
  // Skip IDs that had no SF match on a previous run - persisted in KV for 24 hours
  // so each run advances to fresh tasks rather than retrying the same hopeless batch.
  const NO_MATCH_KEY = 'fs_no_match_ids';
  const skipRaw = await KV.get(NO_MATCH_KEY, 'json');
  const skipIds = new Set(Array.isArray(skipRaw) ? skipRaw : []);

  const unlinked = linkable.filter(t => !linkedIds.has(t.ExternalId) && !skipIds.has(t.ExternalId));
  const toMatch = unlinked.slice(0, MAX_UNLINKED_PER_RUN);

  if (unlinked.length > MAX_UNLINKED_PER_RUN) {
    console.log(`[fs-sync] processing ${MAX_UNLINKED_PER_RUN} of ${unlinked.length} unlinked this run (${skipIds.size} previously skipped)`);
  }

  // One targeted SOQL per batch: filter by exact names + WO-number LIKE clauses.
  // This avoids per-task queries while also avoiding the LIMIT-2000 cutoff that
  // a catch-all "WHERE FS_Task_Id__c = null" scan would hit on the full opp backlog.
  //
  // Deliberately does NOT filter candidate Opps by status. Matching a task to
  // its Opportunity has nothing to do with the Opp's board status, and the old
  // `Project_Status__c IN (jobStatusValues)` filter silently dropped every match
  // whose Opp sat at a blank or completed status - the bulk of the backlog.
  // Scoped to the past year via CreatedDate instead (same window as the scan list).
  let sfByName = new Map();
  let sfByWoNum = new Map();
  if (toMatch.length > 0) {
    try {
      const nameList = toMatch.map(t => `'${t.Name.replace(/'/g, "\\'")}'`).join(',');
      const woNums = [...new Set(toMatch.map(t => parseWoNum(t.Name)).filter(Boolean))];
      const woLikes = woNums.map(n => `${f.oppName} LIKE 'WO ${n}%'`);
      const nameFilter = `${f.oppName} IN (${nameList})`;
      const nameOrWo = woLikes.length ? `(${nameFilter} OR ${woLikes.join(' OR ')})` : nameFilter;
      const scanSince = new Date(Date.now() - ONE_YEAR_MS).toISOString();
      const matchOpps = await sf.query(
        `SELECT Id, ${f.oppName}
         FROM Opportunity
         WHERE ${f.oppFsTaskId} = null
           AND CreatedDate >= ${scanSince}
           AND ${nameOrWo}`
      );

      // Uniqueness gate (mis-assign guard): only keep a name/WO key that resolves
      // to EXACTLY ONE candidate Opp. If a name or WO number maps to multiple
      // Opps, refuse to guess - the task stays unlinked for a human to resolve
      // via the manual fs-link endpoint rather than risk a wrong auto-link.
      const nameCount = new Map();
      const woCount = new Map();
      for (const opp of matchOpps) {
        const nm = opp[f.oppName];
        nameCount.set(nm, (nameCount.get(nm) || 0) + 1);
        const wo = parseWoNum(nm);
        if (wo) woCount.set(wo, (woCount.get(wo) || 0) + 1);
      }
      for (const opp of matchOpps) {
        const nm = opp[f.oppName];
        if (nameCount.get(nm) === 1) sfByName.set(nm, opp);
        const wo = parseWoNum(nm);
        if (wo && woCount.get(wo) === 1) sfByWoNum.set(wo, opp);
      }
    } catch (e) {
      console.error('[fs-sync] batch match query failed:', e.message);
    }
  }

  let linked = 0;
  const noMatchIds = [];

  // Tiers 1–2 (exact name / WO number) resolve entirely from the batched query
  // above - no per-task SOQL. Tasks that miss both AND are T&I-with-LID fall
  // through to the tier-3 LID pass below (one SOQL each, only for that slice).
  const lidCandidates = [];
  for (const task of toMatch) {
    try {
      const sfOpp = findInSf(sfByName, sfByWoNum, task);
      if (sfOpp) {
        await stampLink(sf, sfOpp.Id, task);
        console.log(`[fs-sync] linked (name/WO): "${task.Name}" → SF ${sfOpp.Id}`);
        linked++;
      } else if (isLidEligible(task)) {
        lidCandidates.push(task);
      } else {
        noMatchIds.push(task.ExternalId);
      }
    } catch (e) {
      console.error(`[fs-sync] error on "${task.Name}" (${task.ExternalId}):`, e.message);
    }
  }

  // ---- Tier 3: LID match for T&I tasks (one SOQL per candidate) ----
  // First collect each candidate's single gated Opp, THEN dedupe: if two tasks
  // both resolve to the same Opp (a multi-building campus with several FS work
  // orders under one SF T&I Opp), link neither - same refuse-to-guess rule as
  // the uniqueness gate above. Candidate count is bounded by the 30/run batch.
  if (lidCandidates.length > 0) {
    const claims = new Map(); // oppId -> [task, ...]
    for (const task of lidCandidates) {
      try {
        const opp = await findByLid(sf, task);
        if (opp) {
          if (!claims.has(opp.Id)) claims.set(opp.Id, []);
          claims.get(opp.Id).push(task);
        } else {
          noMatchIds.push(task.ExternalId);
        }
      } catch (e) {
        console.error(`[fs-sync] LID match error on "${task.Name}":`, e.message);
        noMatchIds.push(task.ExternalId);
      }
    }
    for (const [oppId, tasks] of claims) {
      if (tasks.length !== 1) {
        for (const t of tasks) noMatchIds.push(t.ExternalId); // ambiguous - skip all
        continue;
      }
      const task = tasks[0];
      try {
        await stampLink(sf, oppId, task);
        console.log(`[fs-sync] linked (LID): "${task.Name}" → SF ${oppId}`);
        linked++;
      } catch (e) {
        console.error(`[fs-sync] error linking (LID) "${task.Name}":`, e.message);
      }
    }
  }

  console.log(`[fs-sync] done linking - ${linked} linked, ${noMatchIds.length} no SF match`);

  // Persist no-match IDs so next runs skip them. TTL of 24h means they'll be
  // retried daily in case a matching SF opp is created later. EXCEPTION: a task
  // modified within RECENT_NO_SKIP_MS is left off the skip-list, so a WO whose
  // SF opp is created minutes/hours later still auto-links on the next tick
  // instead of being stranded for 24h.
  const toMatchById = new Map(toMatch.map(t => [t.ExternalId, t]));
  const isFresh = (id) => {
    const t = toMatchById.get(id);
    return t && t.LastUpdated && (Date.now() - new Date(t.LastUpdated).getTime()) < RECENT_NO_SKIP_MS;
  };
  const skipToPersist = noMatchIds.filter(id => !isFresh(id));
  if (skipToPersist.length > 0) {
    const updated = [...skipIds, ...skipToPersist];
    await KV.put(NO_MATCH_KEY, JSON.stringify(updated), { expirationTtl: 86400 });
  }

  // ---- Drift verification (stale FS_Status__c snapshot, not a real
  // disagreement) ----
  // Pure SOQL-based check, no FS API calls yet: flag linked opps whose
  // Project_Status__c and cached FS_Status__c look incompatible per the
  // same table the board's drift badge uses. Most flagged jobs are a real,
  // human-visible disagreement that should stay untouched - this pass
  // never writes Project_Status__c. But the flag might instead mean the
  // cached FS_Status__c snapshot itself is simply stale (this cron's other
  // refresh triggers below only catch "FS reports it modified" or "no
  // snapshot yet", never "snapshot present but wrong"). So each suspect
  // gets one live FS re-check, and FS_Status__c/FS_Last_Modified__c are
  // corrected ONLY if that live value actually differs from what's cached.
  const suspectOpps = linkedOpps
    .filter(opp => {
      if (!opp[f.oppFsStatus]) return false;
      const rt = opp.RecordType?.DeveloperName ?? null;
      const sfStatus = opp[statusFieldForType(rt)];
      return !isFsStatusCompatible(rt, sfStatus, opp[f.oppFsStatus]);
    })
    .slice(0, MAX_DRIFT_CHECK_PER_RUN);

  if (suspectOpps.length > 0) {
    console.log(`[fs-sync] ${suspectOpps.length} linked opp(s) flagged by status drift check - verifying live FS status`);
  }

  for (const opp of suspectOpps) {
    try {
      const fullTask = await fs.getTask(opp[f.oppFsTaskId]);
      const liveStatus = fullTask.Status ?? null;
      if (liveStatus !== opp[f.oppFsStatus]) {
        await sf.updateRecord('Opportunity', opp.Id, {
          [f.oppFsStatus]: liveStatus,
          [f.oppFsLastModified]: fullTask.LastUpdated ?? null,
        });
        console.log(`[fs-sync] corrected stale FS_Status__c snapshot for ${opp.Id}: "${opp[f.oppFsStatus]}" → "${liveStatus}"`);
      }
    } catch (e) {
      console.error(`[fs-sync] drift-check getTask failed for ${opp.Id}:`, e.message);
    }
  }

  // ---- Status snapshot + assignment sync (recently-modified linked tasks) ----
  // Only tasks modified in the last RECONCILE_WINDOW_MS are processed here.
  // The cron runs every 5 min, so this typically covers 0–5 tasks per run.
  const recentCutoff = new Date(Date.now() - RECONCILE_WINDOW_MS).toISOString();
  const toReconcile = linkableRecent.filter(
    t => linkedMap.has(t.ExternalId) && (t.LastUpdated || '') >= recentCutoff
  );

  // Backfill: already-linked opps with no FS_Status__c snapshot yet - e.g. jobs
  // linked before the fields existed, or ones FS hasn't touched since. These
  // won't show up in `linkable` (FS hasn't reported them modified), so pull
  // them straight from the bulk linked-opps query instead. Capped per run,
  // same pattern as MAX_UNLINKED_PER_RUN, so a large backlog backfills over
  // several cron ticks rather than spiking FS API calls in one run.
  const queued = new Set(toReconcile.map(t => t.ExternalId));
  const backfillIds = linkedOpps
    .filter(o => !o[f.oppFsStatus] && !queued.has(o[f.oppFsTaskId]))
    .map(o => o[f.oppFsTaskId])
    .slice(0, MAX_UNLINKED_PER_RUN);
  for (const externalId of backfillIds) toReconcile.push({ ExternalId: externalId });

  if (toReconcile.length === 0) return;

  console.log(`[fs-sync] refreshing status snapshot + assignments for ${toReconcile.length} tasks (${backfillIds.length} snapshot backfill)`);

  const techDir = await getTechDirectory(sf);

  for (const task of toReconcile) {
    try {
      const sfOpp = linkedMap.get(task.ExternalId);

      // Fetch FS task + SF assignments in parallel.
      const [fullTask, sfAssignments] = await Promise.all([
        fs.getTask(task.ExternalId),
        sf.query(
          `SELECT Id, ${o.assignmentTechLookup}, ${o.assignmentTechRelationship}.Name
           FROM ${o.assignment}
           WHERE ${o.assignmentOppLookup} = '${sfOpp.Id}'`
        ),
      ]);

      // ---- Status snapshot only - deliberately NOT reconciled/written either
      // direction anymore. This used to compare timestamps and auto-push a
      // status to whichever side looked stale, but that could silently
      // overwrite a status a human had just set. Now it's display-only: the
      // board's drift badge compares job.status vs job.fsStatus client-side
      // (see FS_STATUS_COMPATIBLE in App.jsx) and a person decides what, if
      // anything, to do about a mismatch.
      await sf.updateRecord('Opportunity', sfOpp.Id, {
        [f.oppFsStatus]: fullTask.Status ?? null,
        [f.oppFsLastModified]: fullTask.LastUpdated ?? null,
      });

      // FS users filtered to syncable techs only.
      // getTask() may return Users as objects {ObjectId, Name, ...} or plain strings -
      // normalize to string IDs before comparing.
      const toFsId = (u) => (typeof u === 'string' ? u : u?.ObjectId ?? null);
      const fsUserIds = new Set(
        (Array.isArray(fullTask.Users) ? fullTask.Users : [])
          .map(toFsId).filter(uid => uid && uid in techDir.byFsId)
      );

      const sfAssignedByName = new Map(
        sfAssignments
          .map(a => [a[o.assignmentTechRelationship]?.Name, a])
          .filter(([name]) => !!name)
      );

      // Add: FS has user, SF doesn't
      for (const fsUserId of fsUserIds) {
        const techName = techDir.byFsId[fsUserId]?.name;
        if (sfAssignedByName.has(techName)) continue;

        const sfTechId = techDir.byName[techName]?.sfId;
        if (sfTechId) {
          await sf.createRecord(o.assignment, {
            [o.assignmentOppLookup]: sfOpp.Id,
            [o.assignmentTechLookup]: sfTechId,
            [o.assignmentStartTime]: '07:00:00.000Z',
          });
          console.log(`[fs-sync] added assignment: ${techName} → ${sfOpp.Id}`);
          await notifyTech(env, techName, 'assignment');
        } else {
          console.warn(`[fs-sync] no SF tech ID for "${techName}" - skipping`);
        }
      }

      // Remove: SF has a syncable tech not present in FS Users
      for (const [techName, assignmentRec] of sfAssignedByName) {
        const fsUserId = techDir.byName[techName]?.fsUserId;
        if (!fsUserId) continue; // not a syncable tech - leave it alone
        if (!fsUserIds.has(fsUserId)) {
          await sf.deleteRecord(o.assignment, assignmentRec.Id);
          console.log(`[fs-sync] removed assignment: ${techName} from ${sfOpp.Id}`);
          await notifyTech(env, techName, 'assignment-cancelled');
        }
      }
    } catch (e) {
      console.error(`[fs-sync] error syncing status/assignments for ${task.ExternalId}:`, e.message);
    }
  }
}
