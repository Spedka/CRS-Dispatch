import { Hono } from 'hono';
import { config } from './config.js';
import { createSalesforce } from './salesforce.js';
import { createFs } from './fieldSquared.js';
import { FS_TO_SF, SF_TO_FS, reconcile, sfToFsStatus } from './statusMap.js';
import { runFsSync } from './fsSync.js';
import { createAssignment, esc, normTime, toSfTime, buildFsSchedules, getTechDirectory, invalidateTechDirectory } from './assignments.js';
import { scheduleRequests } from './scheduleRequests.js';
import { mintMagicLink } from './authLink.js';
import { notifyTech } from './notifyBoard.js';

const f = config.fields;
const o = config.objects;
const FS_TASK_TYPE = 'CCTV Job/Work Order'; // only task type currently synced;

function shapeJob(r) {
  const child = r[o.assignmentChildRelationship];
  const assignments = child
    ? child.records.map((a) => ({
        assignmentId: a.Id,
        technicianId: a[o.assignmentTechLookup],
        technicianName: a[o.assignmentTechRelationship]?.Name ?? null,
        workDate: a[o.assignmentDate] ?? null,
        startTime: normTime(a[o.assignmentStartTime]) || '07:00',
        completed: a[o.assignmentCompleted] === true,
      }))
    : [];
  const address = [r[f.addrStreet], r[f.addrCity], r[f.addrState], r[f.addrZip]].filter(Boolean).join(', ');
  return {
    id: r.Id,
    name: r[f.oppName],
    lid: r[f.oppLid] ?? null,
    status: r[f.oppStatus],
    scheduledDate: r[f.oppScheduledDate] ?? null,
    createdDate: r.CreatedDate ?? null,
    closeDate: r.CloseDate ?? null,
    address,
    assignments,
    // FS integration fields
    fsTaskId: r[f.oppFsTaskId] ?? null,
    // Raw FS status snapshot — written only by the FS sync path (fsSync.js,
    // fs-link). Never normalized, never touched by the dispatch-status write
    // path. Used purely for the drift badge, not for board filtering/logic.
    fsStatus: r[f.oppFsStatus] ?? null,
    fsLastModified: r[f.oppFsLastModified] ?? null,
    opportunityType: r[f.oppType] ?? null,
  };
}

export const api = new Hono();
api.route('/', scheduleRequests);

api.get('/jobs', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const statusParam = c.req.query('status');
    const statuses = statusParam ? [statusParam] : config.jobStatusValues;
    const inList = statuses.map((s) => `'${esc(s)}'`).join(',');
    const sinceClause = statusParam  ? '' : `AND (CloseDate >= LAST_N_DAYS:365 OR CloseDate > TODAY)`;

    const excludeClause = `AND (${f.oppType} != 'Monitoring' OR ${f.oppType} = null)`;

    const soql = `
      SELECT Id, ${f.oppName}, ${f.oppLid}, ${f.oppStatus}, ${f.oppScheduledDate},
             ${f.oppFsTaskId}, ${f.oppFsStatus}, ${f.oppFsLastModified}, ${f.oppType}, CreatedDate, CloseDate,
             ${f.addrStreet}, ${f.addrCity}, ${f.addrState}, ${f.addrZip},
             (SELECT Id, ${o.assignmentTechLookup}, ${o.assignmentTechRelationship}.Name,
                     ${o.assignmentDate}, ${o.assignmentStartTime}, ${o.assignmentCompleted}
              FROM ${o.assignmentChildRelationship})
      FROM Opportunity
      WHERE ${f.oppStatus} IN (${inList})
      ${sinceClause}
      ${excludeClause}
      ORDER BY ${f.oppScheduledDate} ASC NULLS LAST`;

    const records = await sf.query(soql);
    return c.json(records.map(shapeJob));
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

api.get('/technicians', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const soql = `SELECT Id, Name FROM ${o.technician}
                  WHERE ${o.technicianActive} = true ORDER BY Name`;
    const recs = await sf.query(soql);
    return c.json(recs.map((t) => ({ id: t.Id, name: t.Name })));
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Add a technician from the board UI — Name is required, FS user ID is
// optional (a tech with no FS ID just doesn't sync to Field Squared).
api.post('/technicians', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const { name, fsUserId } = await c.req.json();
    if (!name || !name.trim()) return c.json({ error: 'name required' }, 400);

    const fields = { Name: name.trim(), [o.technicianActive]: true };
    if (fsUserId && fsUserId.trim()) fields[o.technicianFsUserId] = fsUserId.trim();

    const result = await sf.createRecord(o.technician, fields);
    invalidateTechDirectory();
    return c.json({ id: result?.id, name: name.trim() });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Mints a chalkboard magic link for a technician (15 min TTL, stateless —
// nothing is stored, so there's nothing to list/revoke; re-minting is the
// only "management" action). Resolves the name server-side from technicianId
// rather than trusting client-supplied text, since the name is the entire
// identity embedded in the signed token.
api.post('/tech-link', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const { technicianId } = await c.req.json();
    if (!technicianId) return c.json({ error: 'technicianId required' }, 400);

    const rows = await sf.query(`SELECT Name FROM ${o.technician} WHERE Id = '${esc(technicianId)}' LIMIT 1`);
    const name = rows[0]?.Name;
    if (!name) return c.json({ error: 'Technician not found' }, 404);

    const { link, expiresAt } = await mintMagicLink(c.env, name);
    return c.json({ link, expiresAt });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Approved time off lives as Job_Assignment__c rows against the hidden
// TIME_OFF_OPPORTUNITY_ID sentinel — invisible to GET /jobs (that query filters
// Opportunity by Project_Status__c and pulls assignments as a child subquery, so
// the sentinel itself is never selected). This overlays those rows for the board.
api.get('/time-off', async (c) => {
  try {
    const start = c.req.query('start');
    const end = c.req.query('end');
    const isoDate = /^\d{4}-\d{2}-\d{2}$/;
    // Work_Date__c is a Date field — SOQL date literals are unquoted, so esc()'s
    // quote-escaping doesn't apply here. Validate the shape instead of quoting.
    if (!start || !end || !isoDate.test(start) || !isoDate.test(end)) {
      return c.json({ error: 'start and end are required, as YYYY-MM-DD' }, 400);
    }

    const sf = createSalesforce(c.env);
    const soql = `
      SELECT Id, ${o.assignmentTechLookup}, ${o.assignmentTechRelationship}.Name,
             ${o.assignmentDate}, ${o.assignmentStartTime}, ${o.assignmentEndTime}
      FROM ${o.assignment}
      WHERE ${o.assignmentOppLookup} = '${esc(c.env.TIME_OFF_OPPORTUNITY_ID)}'
        AND ${o.assignmentDate} >= ${start} AND ${o.assignmentDate} <= ${end}`;
    const records = await sf.query(soql);
    return c.json(records.map((r) => ({
      id: r.Id,
      technicianId: r[o.assignmentTechLookup],
      technicianName: r[o.assignmentTechRelationship]?.Name ?? null,
      workDate: r[o.assignmentDate] ?? null,
      startTime: normTime(r[o.assignmentStartTime]),
      endTime: normTime(r[o.assignmentEndTime]),
    })));
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// The office adding time off directly (not via a technician's schedule
// request). A dedicated route rather than reusing POST /jobs/:oppId/assignments
// — TIME_OFF_OPPORTUNITY_ID is a server-only env var, deliberately never sent
// to the client, so the client can't name it as a path param either way.
api.post('/time-off', async (c) => {
  try {
    const { technicianId, workDate, startTime, endTime } = await c.req.json();
    if (!technicianId) return c.json({ error: 'technicianId required' }, 400);
    if (!workDate) return c.json({ error: 'workDate required' }, 400);

    const result = await createAssignment(c.env, c.env.TIME_OFF_OPPORTUNITY_ID, {
      technicianId, workDate, startTime, endTime,
    });
    return c.json(result);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

api.patch('/jobs/:id', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const fs = createFs(c.env);
    const id = c.req.param('id');
    const body = await c.req.json();
    const suppressRelease = !!body._suppressRelease;

    const allowed = { scheduledDate: f.oppScheduledDate, status: f.oppStatus };
    const payload = {};
    for (const [key, value] of Object.entries(body)) {
      if (allowed[key]) payload[allowed[key]] = value === '' ? null : value;
    }
    if (Object.keys(payload).length === 0) {
      return c.json({ error: 'No writable fields in request' }, 400);
    }

    // Pre-fetch current opp when we need scheduledDate crew-release check or FS write-through.
    let previousSfStatus = null;
    let fsTaskId = null;
    let shouldReleaseCrew = false;

    let oppName = '';
    if ('scheduledDate' in body || 'status' in body) {
      const existing = await sf.query(
        `SELECT ${f.oppName}, ${f.oppScheduledDate}, ${f.oppStatus}, ${f.oppFsTaskId}
         FROM Opportunity WHERE Id = '${esc(id)}' LIMIT 1`
      );
      const cur = existing?.[0];
      oppName = cur?.[f.oppName] ?? '';
      if ('scheduledDate' in body) {
        const curVal = cur?.[f.oppScheduledDate] ?? null;
        const newVal = body.scheduledDate === '' ? null : body.scheduledDate;
        if (curVal !== newVal) shouldReleaseCrew = true;
      }
      if ('status' in body) previousSfStatus = cur?.[f.oppStatus] ?? null;
      fsTaskId = cur?.[f.oppFsTaskId] ?? null;
    }

    await sf.updateRecord('Opportunity', id, payload);

    if (shouldReleaseCrew && !suppressRelease) {
      const rows = await sf.query(
        `SELECT Id, ${o.assignmentTechRelationship}.Name FROM ${o.assignment}
         WHERE ${o.assignmentOppLookup} = '${esc(id)}' AND ${o.assignmentCompleted} = false`
      );
      await Promise.all(rows.map((r) =>
        sf.updateRecord(o.assignment, r.Id, { [o.assignmentDate]: null })
      ));
      await Promise.all(rows.map((r) =>
        notifyTech(c.env, r[o.assignmentTechRelationship]?.Name, 'assignment-released')
      ));
    }

    let fsUpdated = false;
    let fsError = null;

    const hasDateChange = 'scheduledDate' in body;
    if (fsTaskId && ('status' in body || hasDateChange)) {
      try {
        let fsStatus = null;
        if ('status' in body) {
          let hasAssignments = false;
          if (body.status === 'Scheduled') {
            const check = await sf.query(
              `SELECT Id FROM ${o.assignment} WHERE ${o.assignmentOppLookup} = '${esc(id)}' LIMIT 1`
            );
            hasAssignments = check.length > 0;
          }
          fsStatus = sfToFsStatus(body.status, hasAssignments);
        }

        if (!hasDateChange && fsStatus) {
          // Status-only: light /api/task endpoint — no 27KB getTask round-trip needed.
          await fs.updateStatus(fsTaskId, oppName, FS_TASK_TYPE, fsStatus);
          fsUpdated = true;
        } else if (hasDateChange) {
          // Date change (± status): one getTask for Schedules ObjectId, then one patch.
          let assignTime = '08:00';
          if (body.scheduledDate) {
            try {
              const asgn = await sf.query(
                `SELECT ${o.assignmentStartTime} FROM ${o.assignment}
                 WHERE ${o.assignmentOppLookup} = '${esc(id)}'
                   AND ${o.assignmentCompleted} = false
                   AND ${o.assignmentDate} != null
                 ORDER BY ${o.assignmentDate} ASC NULLS LAST LIMIT 1`
              );
              if (asgn[0]?.[o.assignmentStartTime]) assignTime = asgn[0][o.assignmentStartTime];
            } catch (_) {}
          }
          const task = await fs.getTask(fsTaskId);
          const sched = body.scheduledDate
            ? buildFsSchedules(task, body.scheduledDate, assignTime)
            : [];
          const fsPatch = {};
          if (fsStatus) fsPatch.Status = fsStatus;
          fsPatch.Schedules = sched;
          await fs.patchTask(fsTaskId, task, fsPatch);
          if (fsStatus) fsUpdated = true;
        }

        // Re-stamp the cached FS_Status__c/FS_Last_Modified__c snapshot
        // immediately after a successful push -- otherwise the board's FS
        // badge shows the OLD status until the next fs-sync cron tick (up
        // to 5 min later), and per investigation that cron tick isn't even
        // a reliable backstop: its own backfill only catches an EMPTY
        // snapshot, never a stale-but-present one, so a snapshot could stay
        // wrong indefinitely if FS's own "recently modified" list endpoint
        // doesn't report an API-pushed change. Mirrors the same two fields
        // the fs-link endpoint stamps elsewhere in this file.
        if (fsUpdated && fsStatus) {
          await sf.updateRecord('Opportunity', id, {
            [f.oppFsStatus]: fsStatus,
            [f.oppFsLastModified]: new Date().toISOString(),
          });
        }
      } catch (fsErr) {
        console.error('[routes] FS write failed (SF kept):', fsErr.message);
        fsError = fsErr.message;
      }
    }

    return c.json({ ok: true, fsUpdated, fsError });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

api.post('/jobs/:oppId/assignments', async (c) => {
  try {
    const oppId = c.req.param('oppId');
    const { technicianId, workDate, startTime, status, scheduledDate, deriveScheduledDate } = await c.req.json();
    if (!technicianId) return c.json({ error: 'technicianId required' }, 400);

    const result = await createAssignment(c.env, oppId, {
      technicianId, workDate, startTime, status, scheduledDate, deriveScheduledDate,
    });
    return c.json(result);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

api.patch('/assignments/:id', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const id = c.req.param('id');
    const body = await c.req.json();

    const fields = {};
    if (typeof body.completed === 'boolean') fields[o.assignmentCompleted] = body.completed;
    if ('workDate' in body) fields[o.assignmentDate] = body.workDate === '' ? null : body.workDate;
    if ('startTime' in body) fields[o.assignmentStartTime] = toSfTime(body.startTime || '07:00');
    // End_Time__c isn't part of the FS-facing job flow (FS's own Schedules always
    // derive their end as start+1hr) — only time off actually uses it.
    if ('endTime' in body) fields[o.assignmentEndTime] = toSfTime(body.endTime || null);
    if (Object.keys(fields).length === 0) return c.json({ error: 'Nothing to update' }, 400);

    // Pre-fetch assignment context before updating so we have the parent opp + current values
    // needed to sync schedule changes to FS, plus the tech name for the live-push notify below.
    let oppId = null;
    let workDateForFs = null;
    let startTimeForFs = null;
    let techName = null;
    const needsFsSync = 'workDate' in body || 'startTime' in body;
    try {
      const rows = await sf.query(
        `SELECT ${o.assignmentOppLookup}, ${o.assignmentDate}, ${o.assignmentStartTime}, ${o.assignmentTechRelationship}.Name
         FROM ${o.assignment} WHERE Id = '${esc(id)}' LIMIT 1`
      );
      if (rows[0]) {
        techName = rows[0][o.assignmentTechRelationship]?.Name ?? null;
        if (needsFsSync) {
          oppId = rows[0][o.assignmentOppLookup];
          workDateForFs = 'workDate' in body
            ? (body.workDate || null)
            : (rows[0][o.assignmentDate] ?? null);
          startTimeForFs = 'startTime' in body
            ? (body.startTime || '07:00')
            : normTime(rows[0][o.assignmentStartTime]) || '07:00';
        }
      }
    } catch (e) {
      console.warn('[routes] Could not pre-fetch assignment for FS sync:', e.message);
    }

    await sf.updateRecord(o.assignment, id, fields);
    await notifyTech(c.env, techName, 'assignment-updated');

    if (oppId && needsFsSync) {
      try {
        const fs = createFs(c.env);
        const opps = await sf.query(
          `SELECT ${f.oppFsTaskId} FROM Opportunity WHERE Id = '${esc(oppId)}' LIMIT 1`
        );
        const fsTaskId = opps[0]?.[f.oppFsTaskId];
        if (fsTaskId) {
          const task = await fs.getTask(fsTaskId);
          let sched;
          if (workDateForFs) {
            sched = buildFsSchedules(task, workDateForFs, startTimeForFs);
          } else {
            // workDate was cleared — SF update already committed (null date), so just
            // query all assignments; the date filter below drops this one naturally.
            const remaining = await sf.query(
              `SELECT ${o.assignmentDate}, ${o.assignmentStartTime}, ${o.assignmentCompleted}
               FROM ${o.assignment} WHERE ${o.assignmentOppLookup} = '${esc(oppId)}'`
            );
            const next = remaining
              .filter(a => a[o.assignmentDate] && !a[o.assignmentCompleted])
              .sort((a, b) => {
                const d = String(a[o.assignmentDate]).localeCompare(String(b[o.assignmentDate]));
                return d !== 0 ? d : (normTime(a[o.assignmentStartTime]) || '').localeCompare(normTime(b[o.assignmentStartTime]) || '');
              })[0];
            sched = next
              ? buildFsSchedules(task, next[o.assignmentDate], normTime(next[o.assignmentStartTime]) || '08:00')
              : [];
          }
          if (sched !== null) await fs.patchTask(fsTaskId, task, { Schedules: sched });
        }
      } catch (fsErr) {
        console.error('[routes] FS schedule patch failed (SF kept):', fsErr.message);
      }
    }

    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

api.delete('/assignments/:id', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const id = c.req.param('id');

    // Pre-fetch tech name + opp ID before deleting so we can sync the removal to FS.
    let techName = null;
    let techId = null;
    let oppId = null;
    try {
      const rows = await sf.query(
        `SELECT ${o.assignmentOppLookup}, ${o.assignmentTechLookup}, ${o.assignmentTechRelationship}.Name
         FROM ${o.assignment} WHERE Id = '${esc(id)}' LIMIT 1`
      );
      if (rows[0]) {
        techName = rows[0][o.assignmentTechRelationship]?.Name ?? null;
        techId   = rows[0][o.assignmentTechLookup] ?? null;
        oppId    = rows[0][o.assignmentOppLookup] ?? null;
      }
    } catch (e) {
      console.warn('[routes] Could not pre-fetch assignment for FS sync:', e.message);
    }

    await sf.deleteRecord(o.assignment, id);
    await notifyTech(c.env, techName, 'assignment-cancelled');

    // Remove the user from the FS task if they're a syncable tech
    const techDir = await getTechDirectory(sf);
    const fsUserId = techName ? techDir.byName[techName]?.fsUserId : null;
    if (fsUserId && oppId) {
      try {
        const fs = createFs(c.env);
        const opps = await sf.query(
          `SELECT ${f.oppFsTaskId} FROM Opportunity WHERE Id = '${esc(oppId)}' LIMIT 1`
        );
        const fsTaskId = opps[0]?.[f.oppFsTaskId];
        if (fsTaskId) {
          const task = await fs.getTask(fsTaskId);
          const toId = (u) => (typeof u === 'string' ? u : u?.ObjectId ?? null);

          // Query runs after sf.deleteRecord so the removed assignment is gone.
          // Include tech ID so we can check whether this tech still has other assignments.
          const remaining = await sf.query(
            `SELECT ${o.assignmentDate}, ${o.assignmentStartTime}, ${o.assignmentCompleted},
                    ${o.assignmentTechLookup}
             FROM ${o.assignment} WHERE ${o.assignmentOppLookup} = '${esc(oppId)}'`
          );

          // Only remove the FS user if they have no remaining assignments on this job.
          const techStillAssigned = remaining.some(a => a[o.assignmentTechLookup] === techId);
          const updatedUsers = (Array.isArray(task.Users) ? task.Users : [])
            .map(toId).filter(uid => uid && (uid !== fsUserId || techStillAssigned));
          const next = remaining
            .filter(a => a[o.assignmentDate] && !a[o.assignmentCompleted])
            .sort((a, b) => {
              const d = String(a[o.assignmentDate]).localeCompare(String(b[o.assignmentDate]));
              return d !== 0 ? d : (normTime(a[o.assignmentStartTime]) || '').localeCompare(normTime(b[o.assignmentStartTime]) || '');
            })[0];

          const patch = { Users: updatedUsers };
          if (next) {
            const time = normTime(next[o.assignmentStartTime]) || '08:00';
            patch.Schedules = buildFsSchedules(task, next[o.assignmentDate], time);
          } else {
            patch.Schedules = [];   // no dated assignments remain — clear FS schedule
          }
          await fs.patchTask(fsTaskId, task, patch);
        }
      } catch (fsErr) {
        console.error('[routes] FS unassign failed (SF kept):', fsErr.message);
      }
    }

    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Search FS tasks by name fragment — used by the manual-link UI on the board.
api.get('/fs-search', async (c) => {
  try {
    const q = c.req.query('q')?.trim();
    if (!q || q.length < 3) return c.json({ error: 'Query must be at least 3 characters' }, 400);

    const fs = createFs(c.env);
    const KV = c.env.SF_TOKENS;
    const CACHE_KEY = 'fs_task_list_v2';
    const CACHE_TTL = 600; // 10 minutes
    const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();

    const lower = q.toLowerCase();
    const filterTasks = (tasks) =>
      tasks
        .filter((t) => t.Name && t.Name.toLowerCase().includes(lower))
        .slice(0, 15)
        .map((t) => ({ externalId: t.ExternalId, name: t.Name, status: t.Status, taskType: t.TaskType }));

    async function fetchAndCache() {
      const tasks = await fs.listModified(since);
      if (KV) await KV.put(CACHE_KEY, JSON.stringify(tasks), { expirationTtl: CACHE_TTL });
      return tasks;
    }

    // Try cache first.
    let fromCache = false;
    let tasks = null;
    if (KV) {
      const cached = await KV.get(CACHE_KEY, 'json');
      if (cached) { tasks = cached; fromCache = true; }
    }
    if (!tasks) tasks = await fetchAndCache();

    let matches = filterTasks(tasks);

    // No matches from cache — could be a brand-new task. Fetch just today's tasks and retry.
    if (matches.length === 0 && fromCache) {
      const todaySince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const recent = await fs.listModified(todaySince);
      matches = filterTasks(recent);
    }

    return c.json({ matches });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// FS's active user roster — feeds the "Add Tech" picklist so the office picks
// the FS account instead of hand-typing an opaque ObjectId.
api.get('/fs-users', async (c) => {
  try {
    const fs = createFs(c.env);
    const KV = c.env.SF_TOKENS;
    const CACHE_KEY = 'fs_user_list_v1';
    const CACHE_TTL = 1800; // 30 minutes — the user roster barely changes
    const since = new Date(Date.now() - 10 * 365 * 24 * 60 * 60 * 1000).toISOString();

    let users = KV ? await KV.get(CACHE_KEY, 'json') : null;
    if (!users) {
      users = await fs.listUsers(since);
      if (KV) await KV.put(CACHE_KEY, JSON.stringify(users), { expirationTtl: CACHE_TTL });
    }

    const active = users
      .filter((u) => u.Enabled)
      .map((u) => ({ externalId: u.ExternalId, name: u.Name, userType: u.UserType }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return c.json({ users: active });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Returns every field on Account with its API name, label, and type.
// Hit this once to know what you can query.
api.get('/test/account-fields', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const describe = await sf.raw('/sobjects/Account/describe');
    const fields = describe.fields.map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      custom: f.custom,
    }));
    return c.json({ total: fields.length, fields });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Returns 5 raw Account records with nested Contacts so you can see
// the actual data shape and figure out which fields to use.
// Also attempts AccountContactRelation to detect multi-account contacts.
api.get('/test/accounts', async (c) => {
  try {
    const sf = createSalesforce(c.env);

    const accounts = await sf.query(`
      SELECT Id, Name, LID__c, Property_Contact_Name__c, Phone, Website, Type, Industry,
             ShippingStreet, ShippingCity, ShippingState, ShippingPostalCode,
             (SELECT Id, Name, FirstName, LastName, Email, Phone, Title FROM Contacts LIMIT 10)
      FROM Account
      LIMIT 5
    `);

    // Check if AccountContactRelation exists (Contacts to Multiple Accounts feature).
    let multiAccountSample = null;
    try {
      multiAccountSample = await sf.query(
        `SELECT Id, AccountId, ContactId, Contact.Name, Account.Name, Account.LID__c
         FROM AccountContactRelation
         LIMIT 5`
      );
    } catch (_) {
      multiAccountSample = 'AccountContactRelation not available in this org';
    }

    return c.json({ accounts, multiAccountSample });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

api.patch('/accounts/:id/contact', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const id = c.req.param('id');
    const { contactId } = await c.req.json();
    if (!contactId) return c.json({ error: 'contactId required' }, 400);

    await sf.updateRecord('Account', id, {
      Property_Contact_Name__c: contactId,
    });

    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

api.patch('/contacts/:id', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const id = c.req.param('id');
    const body = await c.req.json();

    const fields = {};
    if ('name' in body) {
      const parts = String(body.name || '').trim().split(/\s+/);
      fields.LastName = parts.length > 1 ? parts.slice(1).join(' ') : parts[0];
      if (parts.length > 1) fields.FirstName = parts[0];
    }
    if ('email' in body) fields.Email = body.email || null;
    if ('phone' in body) fields.Phone = body.phone || null;

    if (Object.keys(fields).length === 0) return c.json({ error: 'Nothing to update' }, 400);
    await sf.updateRecord('Contact', id, fields);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

api.get('/contacts', async (c) => {
  try {
    const sf = createSalesforce(c.env);

    // Pull contacts and accounts that name a property contact in parallel.
    // Property_Contact_Name__c on Account is a Contact lookup — one person can be
    // the property contact for many buildings, so we group accounts by that field.
    const [contactRecords, accountRecords] = await Promise.all([
      sf.query(`SELECT Id, FirstName, LastName, Name, Email, Phone, Title,
                       AccountId, Account.Name, LastModifiedDate
                FROM Contact ORDER BY LastName, FirstName`),
      sf.query(`SELECT Id, Name, LID__c, Property_Contact_Name__c, ParentId, Parent.Name
                FROM Account WHERE Property_Contact_Name__c != null`),
    ]);

    // contactId → [{ id, name, lid }]
    const accountsByContact = new Map();
    for (const a of accountRecords) {
      const contactId = a.Property_Contact_Name__c;
      const arr = accountsByContact.get(contactId) ?? [];
      arr.push({ id: a.Id, name: a.Name, lid: a.LID__c ?? null, parentId: a.ParentId ?? null, parentName: a.Parent?.Name ?? null });
      accountsByContact.set(contactId, arr);
    }

    return c.json(contactRecords.map((r) => ({
      id: r.Id,
      firstName: r.FirstName ?? null,
      lastName: r.LastName ?? null,
      name: r.Name,
      email: r.Email ?? null,
      phone: r.Phone ?? null,
      title: r.Title ?? null,
      company: r.Account?.Name ?? null,
      accounts: accountsByContact.get(r.Id) ?? [],
      lastModifiedDate: r.LastModifiedDate ?? null,
    })));
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Manually stamp an FS task ID onto a SF opportunity, then immediately reconcile
// status and user assignments from the FS task so the board reflects reality.
api.post('/jobs/:id/fs-link', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const fs = createFs(c.env);
    const id = c.req.param('id');
    const { fsTaskId } = await c.req.json();
    if (!fsTaskId) return c.json({ error: 'fsTaskId required' }, 400);

    // Stamp the link first — if anything below fails, the link is still saved.
    await sf.updateRecord('Opportunity', id, { [f.oppFsTaskId]: fsTaskId });

    const result = { sfStatus: null, assignmentsAdded: 0 };

    try {
      // Fetch opp, full FS task, existing SF assignments, and the FS↔SF tech
      // directory all in parallel so assignment count is available before we
      // decide the FS status to write.
      const [oppRows, fullTask, existingAssignments, techDir] = await Promise.all([
        sf.query(
          `SELECT ${f.oppStatus}, ${f.oppScheduledDate}, LastModifiedDate
           FROM Opportunity WHERE Id = '${esc(id)}' LIMIT 1`
        ),
        fs.getTask(fsTaskId),
        sf.query(`SELECT ${o.assignmentTechRelationship}.Name, ${o.assignmentStartTime} FROM ${o.assignment} WHERE ${o.assignmentOppLookup} = '${esc(id)}'`),
        getTechDirectory(sf),
      ]);
      const sfOpp = oppRows[0];
      if (!sfOpp) throw new Error('Opp not found');

      // Stamp the raw FS status snapshot now that we have the full task —
      // same fields fsSync.js's cron writes, kept isolated from the reconcile
      // write below so the badge reflects FS's actual state either way.
      await sf.updateRecord('Opportunity', id, {
        [f.oppFsStatus]: fullTask.Status ?? null,
        [f.oppFsLastModified]: fullTask.LastUpdated ?? null,
      });

      // Sync users: FS → SF — find techs in FS not yet in SF.
      const syncableUserIds = (Array.isArray(fullTask.Users) ? fullTask.Users : [])
        .filter(uid => uid in techDir.byFsId);

      const assignedNames = new Set(
        existingAssignments.map(a => a[o.assignmentTechRelationship]?.Name).filter(Boolean)
      );
      // "has assignments" = existing SF assignments + any we're about to add from FS
      const willHaveAssignments = existingAssignments.length > 0 || syncableUserIds.length > 0;

      // Reconcile status — "Scheduled" on SF side writes "Assigned" to FS if
      // the job has (or will have) techs assigned.
      const rec = reconcile(fullTask.Status, sfOpp[f.oppStatus], fullTask.LastUpdated, sfOpp.LastModifiedDate);
      let targetFsStatus = null;
      if (rec.action === 'write') {
        if (rec.target === 'sf') {
          await sf.updateRecord('Opportunity', id, { [f.oppStatus]: rec.value });
          result.sfStatus = rec.value;
        } else {
          targetFsStatus = sfToFsStatus(sfOpp[f.oppStatus], willHaveAssignments);
        }
      }

      // Scheduled + users → bump FS to "Assigned" regardless of reconcile outcome.
      if (fullTask.Status === 'Scheduled' && willHaveAssignments) {
        targetFsStatus = 'Assigned';
      }

      // Single FS write: status (if needed) + scheduled date from SF board.
      const fsPatch = {};
      if (targetFsStatus) fsPatch.Status = targetFsStatus;
      if (sfOpp[f.oppScheduledDate]) {
        const firstTime = existingAssignments[0]?.[o.assignmentStartTime] ?? '08:00';
        const sched = buildFsSchedules(fullTask, sfOpp[f.oppScheduledDate], firstTime);
        if (sched) fsPatch.Schedules = sched;
      }
      if (Object.keys(fsPatch).length > 0) {
        await fs.patchTask(fsTaskId, fullTask, fsPatch);
      }

      // Add missing SF assignments from FS.
      if (syncableUserIds.length > 0) {
        for (const fsUserId of syncableUserIds) {
          const techName = techDir.byFsId[fsUserId]?.name;
          if (assignedNames.has(techName)) continue;
          const sfTechId = techDir.byName[techName]?.sfId;
          if (sfTechId) {
            await sf.createRecord(o.assignment, {
              [o.assignmentOppLookup]: id,
              [o.assignmentTechLookup]: sfTechId,
              [o.assignmentStartTime]: '07:00:00.000Z',
            });
            result.assignmentsAdded++;
          }
        }
      }
    } catch (recErr) {
      console.error('[routes] fs-link reconcile failed (link still saved):', recErr.message);
    }

    return c.json({ ok: true, fsTaskId, ...result });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// ============================================================================
// TEMPORARY — Field Squared Documents API exploration. REMOVE THIS ROUTE
// once the investigation is done. No persistence, no SF writes, no UI wiring.
// Uses createFs(c.env) / getToken() from fieldSquared.js — never calls
// /Authentication directly.
//
// Usage:
//   GET /api/debug/documents                     — step 1: enumerate types
//   GET /api/debug/documents?externalId=<id>      — also runs step 2 for that doc
//   GET /api/debug/documents?raw=<query string>   — passthrough for experimenting
//                                                    with /api/document filter params
//                                                    without redeploying, e.g.
//                                                    ?raw=modifiedsince%3D2026-01-01
// ============================================================================
api.get('/debug/documents', async (c) => {
  try {
    const fs = createFs(c.env);
    const externalId = c.req.query('externalId');
    const raw = c.req.query('raw');

    const asJson = (r) => {
      let body = r.body;
      try { body = JSON.parse(r.body); } catch (_) { /* leave as raw text */ }
      return { status: r.status, ok: r.ok, errHeader: r.errHeader ?? null, body };
    };

    // Raw passthrough mode — skip steps 1/2 entirely.
    if (raw !== undefined) {
      return c.json({ raw: asJson(await fs.rawDocumentQuery(raw)) });
    }

    // Step 1 — enumerate document types. Try no filter plus each of the
    // four CRS-configured types; raw error bodies are returned as-is if FS
    // rejects a type name/casing.
    const candidateTypes = [null, 'Service Acknowledgement', 'Work Order', 'Test & Inspection', 'Work Order Email - 1'];
    const types = {};
    for (const t of candidateTypes) {
      types[t ?? '(no filter)'] = asJson(await fs.listDocuments(t));
    }

    const result = { types };

    // Step 2 — pull a known document's full record, if provided.
    if (externalId) {
      result.document = asJson(await fs.getDocument(externalId));
    }

    return c.json(result);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
// ============================================================================
// END TEMPORARY DEBUG ROUTE
// ============================================================================