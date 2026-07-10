import { createFs } from './fieldSquared.js';
import { createSalesforce } from './salesforce.js';
import { config } from './config.js';
import { reconcile, sfToFsStatus } from './statusMap.js';

const f = config.fields;
const o = config.objects;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const OVERLAP_MS = 5 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_UNLINKED_PER_RUN = 30;
// Window for assignment reconciliation — slightly larger than the cron interval
// to avoid gaps if a run starts a few seconds late.
const RECONCILE_WINDOW_MS = 10 * 60 * 1000;

const fsTechUsers = config.fsTechUsers; // FS ObjectId → tech name
const techNameToFsId = Object.fromEntries(
  Object.entries(fsTechUsers).map(([fsId, name]) => [name, fsId])
);

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

  let tasks;
  try {
    tasks = await fs.listModified(since);
  } catch (e) {
    console.error('[fs-sync] listModified failed:', e.message);
    return;
  }

  const linkable = tasks.filter(isLinkable);
  console.log(`[fs-sync] ${tasks.length} FS tasks, ${linkable.length} linkable`);

  // ONE bulk query — all SF opps that already have an FS link.
  // Includes Id so we can create/delete child assignment records without extra queries.
  let linkedOpps;
  try {
    linkedOpps = await sf.query(
      `SELECT Id, ${f.oppFsTaskId}, ${f.oppStatus}, ${f.oppFsStatus}, LastModifiedDate
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
  // Skip IDs that had no SF match on a previous run — persisted in KV for 24 hours
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
  let sfByName = new Map();
  let sfByWoNum = new Map();
  if (toMatch.length > 0) {
    try {
      const nameList = toMatch.map(t => `'${t.Name.replace(/'/g, "\\'")}'`).join(',');
      const woNums = [...new Set(toMatch.map(t => parseWoNum(t.Name)).filter(Boolean))];
      const woLikes = woNums.map(n => `${f.oppName} LIKE 'WO ${n}%'`);
      const nameFilter = `${f.oppName} IN (${nameList})`;
      const nameOrWo = woLikes.length ? `(${nameFilter} OR ${woLikes.join(' OR ')})` : nameFilter;
      const boardStatuses = config.jobStatusValues.map(s => `'${s}'`).join(',');
      const matchOpps = await sf.query(
        `SELECT Id, ${f.oppName}, ${f.oppStatus}
         FROM Opportunity
         WHERE ${f.oppFsTaskId} = null
           AND ${f.oppStatus} IN (${boardStatuses})
           AND ${nameOrWo}`
      );
      sfByName = new Map(matchOpps.map(o => [o[f.oppName], o]));
      for (const opp of matchOpps) {
        const wo = parseWoNum(opp[f.oppName]);
        if (wo && !sfByWoNum.has(wo)) sfByWoNum.set(wo, opp);
      }
    } catch (e) {
      console.error('[fs-sync] batch match query failed:', e.message);
    }
  }

  let linked = 0;
  const noMatchIds = [];

  for (const task of toMatch) {
    try {
      const sfOpp = findInSf(sfByName, sfByWoNum, task);
      if (!sfOpp) {
        noMatchIds.push(task.ExternalId);
        continue;
      }
      // Bundle the raw FS status snapshot into the same write — the list
      // endpoint's compact task shape already has Status + LastUpdated.
      await sf.updateRecord('Opportunity', sfOpp.Id, {
        [f.oppFsTaskId]: task.ExternalId,
        [f.oppFsStatus]: task.Status ?? null,
        [f.oppFsLastModified]: task.LastUpdated ?? null,
      });
      console.log(`[fs-sync] linked: "${task.Name}" → SF ${sfOpp.Id}`);
      linked++;
    } catch (e) {
      console.error(`[fs-sync] error on "${task.Name}" (${task.ExternalId}):`, e.message);
    }
  }

  console.log(`[fs-sync] done linking — ${linked} linked, ${noMatchIds.length} no SF match`);

  // Persist no-match IDs so next runs skip them. TTL of 24h means they'll be
  // retried daily in case a matching SF opp is created later.
  if (noMatchIds.length > 0) {
    const updated = [...skipIds, ...noMatchIds];
    await KV.put(NO_MATCH_KEY, JSON.stringify(updated), { expirationTtl: 86400 });
  }

  // ---- Assignment reconciliation (recently-modified linked tasks) ----
  // Only tasks modified in the last RECONCILE_WINDOW_MS are processed here.
  // The cron runs every 5 min, so this typically covers 0–5 tasks per run.
  const recentCutoff = new Date(Date.now() - RECONCILE_WINDOW_MS).toISOString();
  const toReconcile = linkable.filter(
    t => linkedMap.has(t.ExternalId) && (t.LastUpdated || '') >= recentCutoff
  );

  // Backfill: already-linked opps with no FS_Status__c snapshot yet — e.g. jobs
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

  console.log(`[fs-sync] reconciling status + assignments for ${toReconcile.length} tasks (${backfillIds.length} snapshot backfill)`);

  // SF tech IDs loaded lazily — one query on first task that needs them.
  let sfTechIdByName = null;

  for (const task of toReconcile) {
    try {
      const sfOpp = linkedMap.get(task.ExternalId);

      // Fetch FS task + SF assignments in parallel — we need assignment count
      // before deciding the FS status to write (Scheduled vs Assigned).
      const [fullTask, sfAssignments] = await Promise.all([
        fs.getTask(task.ExternalId),
        sf.query(
          `SELECT Id, ${o.assignmentTechLookup}, ${o.assignmentTechRelationship}.Name
           FROM ${o.assignment}
           WHERE ${o.assignmentOppLookup} = '${sfOpp.Id}'`
        ),
      ]);

      // ---- Status reconciliation ----
      const rec = reconcile(fullTask.Status, sfOpp[f.oppStatus], fullTask.LastUpdated, sfOpp.LastModifiedDate);

      // Raw FS status snapshot — written unconditionally on every reconcile pass,
      // independent of reconcile()'s write decision. The board's drift badge
      // reads this directly, so it must reflect FS's actual state even on a
      // 'noop'/'skip' reconcile outcome (e.g. FS drifted somewhere reconcile
      // intentionally won't touch).
      const fsSnapshot = { [f.oppFsStatus]: fullTask.Status ?? null, [f.oppFsLastModified]: fullTask.LastUpdated ?? null };

      if (rec.action === 'write' && rec.target === 'sf') {
        await sf.updateRecord('Opportunity', sfOpp.Id, { [f.oppStatus]: rec.value, ...fsSnapshot });
        console.log(`[fs-sync] status SF←FS: "${fullTask.Status}" → "${rec.value}" on ${sfOpp.Id}`);
      } else {
        await sf.updateRecord('Opportunity', sfOpp.Id, fsSnapshot);
        if (rec.action === 'write' && rec.target === 'fs') {
          // "Scheduled" on SF side → "Assigned" in FS when the job has techs.
          const fsTarget = sfToFsStatus(sfOpp[f.oppStatus], sfAssignments.length > 0);
          if (fsTarget) {
            await fs.updateStatus(task.ExternalId, fullTask.Name, fullTask.TaskType, fsTarget);
            console.log(`[fs-sync] status FS←SF: "${sfOpp[f.oppStatus]}" → "${fsTarget}" on ${task.ExternalId}`);
          }
        }
      }

      // FS users filtered to syncable techs only.
      // getTask() may return Users as objects {ObjectId, Name, ...} or plain strings —
      // normalize to string IDs before comparing.
      const toFsId = (u) => (typeof u === 'string' ? u : u?.ObjectId ?? null);
      const fsUserIds = new Set(
        (Array.isArray(fullTask.Users) ? fullTask.Users : [])
          .map(toFsId).filter(uid => uid && uid in fsTechUsers)
      );

      const sfAssignedByName = new Map(
        sfAssignments
          .map(a => [a[o.assignmentTechRelationship]?.Name, a])
          .filter(([name]) => !!name)
      );

      // Add: FS has user, SF doesn't
      for (const fsUserId of fsUserIds) {
        const techName = fsTechUsers[fsUserId];
        if (sfAssignedByName.has(techName)) continue;

        if (!sfTechIdByName) {
          const rows = await sf.query(
            `SELECT Id, Name FROM ${o.technician} WHERE ${o.technicianActive} = true`
          );
          sfTechIdByName = Object.fromEntries(rows.map(t => [t.Name, t.Id]));
        }

        const sfTechId = sfTechIdByName[techName];
        if (sfTechId) {
          await sf.createRecord(o.assignment, {
            [o.assignmentOppLookup]: sfOpp.Id,
            [o.assignmentTechLookup]: sfTechId,
            [o.assignmentStartTime]: '07:00:00.000Z',
          });
          console.log(`[fs-sync] added assignment: ${techName} → ${sfOpp.Id}`);
        } else {
          console.warn(`[fs-sync] no SF tech ID for "${techName}" — skipping`);
        }
      }

      // Remove: SF has a syncable tech not present in FS Users
      for (const [techName, assignmentRec] of sfAssignedByName) {
        const fsUserId = techNameToFsId[techName];
        if (!fsUserId) continue; // not a syncable tech — leave it alone
        if (!fsUserIds.has(fsUserId)) {
          await sf.deleteRecord(o.assignment, assignmentRec.Id);
          console.log(`[fs-sync] removed assignment: ${techName} from ${sfOpp.Id}`);
        }
      }
    } catch (e) {
      console.error(`[fs-sync] error reconciling assignments for ${task.ExternalId}:`, e.message);
    }
  }
}
