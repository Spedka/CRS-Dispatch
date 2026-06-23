import { createFs } from './fieldSquared.js';
import { createSalesforce } from './salesforce.js';
import { config } from './config.js';
import { reconcile, sfToFsStatus } from './statusMap.js';

const f = config.fields;
const o = config.objects;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
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

async function matchToSf(sf, task) {
  const escapedName = task.Name.replace(/'/g, "\\'");
  let records = await sf.query(
    `SELECT Id, ${f.oppName}, ${f.oppStatus}, ${f.oppFsTaskId}
     FROM Opportunity WHERE Name = '${escapedName}' LIMIT 1`
  );
  if (records.length) return records[0];

  const woNum = parseWoNum(task.Name);
  if (woNum) {
    records = await sf.query(
      `SELECT Id, ${f.oppName}, ${f.oppStatus}, ${f.oppFsTaskId}
       FROM Opportunity WHERE Name LIKE 'WO ${woNum}%' LIMIT 1`
    );
    if (records.length) return records[0];
  }

  return null;
}

export async function runFsSync(env) {
  const KV = env.SF_TOKENS;
  const fs = createFs(env);
  const sf = createSalesforce(env);

  const lastRunKey = 'fs_sync_last_run';
  const stored = await KV.get(lastRunKey);
  if (stored && Date.now() - new Date(stored).getTime() < MIN_INTERVAL_MS) return;
  await KV.put(lastRunKey, new Date().toISOString());

  const since = new Date(Date.now() - ONE_YEAR_MS).toISOString();

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
      `SELECT Id, ${f.oppFsTaskId}, ${f.oppStatus}, LastModifiedDate
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
  const unlinked = linkable.filter(t => !linkedIds.has(t.ExternalId));
  const toMatch = unlinked.slice(0, MAX_UNLINKED_PER_RUN);

  if (unlinked.length > MAX_UNLINKED_PER_RUN) {
    console.log(`[fs-sync] processing ${MAX_UNLINKED_PER_RUN} of ${unlinked.length} unlinked this run`);
  }

  let linked = 0;
  let noMatch = 0;

  for (const task of toMatch) {
    try {
      const sfOpp = await matchToSf(sf, task);
      if (!sfOpp) {
        noMatch++;
        continue;
      }
      if (!sfOpp[f.oppStatus]) {
        console.log(`[fs-sync] skipping ${task.ExternalId} — matched opp has no status`);
        continue;
      }
      await sf.updateRecord('Opportunity', sfOpp.Id, { [f.oppFsTaskId]: task.ExternalId });
      console.log(`[fs-sync] linked: "${task.Name}" → SF ${sfOpp.Id}`);
      linked++;
    } catch (e) {
      console.error(`[fs-sync] error on "${task.Name}" (${task.ExternalId}):`, e.message);
    }
  }

  console.log(`[fs-sync] done linking — ${linked} linked, ${noMatch} no SF match`);

  // ---- Assignment reconciliation (recently-modified linked tasks) ----
  // Only tasks modified in the last RECONCILE_WINDOW_MS are processed here.
  // The cron runs every 5 min, so this typically covers 0–5 tasks per run.
  const recentCutoff = new Date(Date.now() - RECONCILE_WINDOW_MS).toISOString();
  const toReconcile = linkable.filter(
    t => linkedMap.has(t.ExternalId) && (t.LastUpdated || '') >= recentCutoff
  );

  if (toReconcile.length === 0) return;

  console.log(`[fs-sync] reconciling status + assignments for ${toReconcile.length} recently-modified tasks`);

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
      if (rec.action === 'write') {
        if (rec.target === 'sf') {
          await sf.updateRecord('Opportunity', sfOpp.Id, { [f.oppStatus]: rec.value });
          console.log(`[fs-sync] status SF←FS: "${fullTask.Status}" → "${rec.value}" on ${sfOpp.Id}`);
        } else {
          // "Scheduled" on SF side → "Assigned" in FS when the job has techs.
          const fsTarget = sfToFsStatus(sfOpp[f.oppStatus], sfAssignments.length > 0);
          if (fsTarget) {
            await fs.updateStatus(task.ExternalId, fullTask.Name, fullTask.TaskType, fsTarget);
            console.log(`[fs-sync] status FS←SF: "${sfOpp[f.oppStatus]}" → "${fsTarget}" on ${task.ExternalId}`);
          }
        }
      }

      // FS users filtered to syncable techs only
      const fsUserIds = new Set(
        (Array.isArray(fullTask.Users) ? fullTask.Users : []).filter(uid => uid in fsTechUsers)
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
