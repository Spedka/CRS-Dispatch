import { createFs } from './fieldSquared.js';
import { createSalesforce } from './salesforce.js';
import { config } from './config.js';

const f = config.fields;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_UNLINKED_PER_RUN = 30;

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
  // Zero per-task subrequests for already-linked tasks.
  let linkedOpps;
  try {
    linkedOpps = await sf.query(
      `SELECT ${f.oppFsTaskId} FROM Opportunity WHERE ${f.oppFsTaskId} != null LIMIT 2000`
    );
  } catch (e) {
    console.error('[fs-sync] bulk linked-opps query failed:', e.message);
    return;
  }

  const linkedIds = new Set(linkedOpps.map(o => o[f.oppFsTaskId]));
  console.log(`[fs-sync] ${linkedIds.size} already linked, ${linkable.filter(t => !linkedIds.has(t.ExternalId)).length} unlinked`);

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

  console.log(`[fs-sync] done — ${linked} linked, ${noMatch} no SF match`);
}
