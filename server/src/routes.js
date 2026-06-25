import { Hono } from 'hono';
import { config } from './config.js';
import { createSalesforce } from './salesforce.js';
import { createFs } from './fieldSquared.js';
import { FS_TO_SF, SF_TO_FS, reconcile, sfToFsStatus } from './statusMap.js';
import { runFsSync } from './fsSync.js';

const f = config.fields;
const o = config.objects;
const esc = (s) => String(s).replace(/'/g, "\\'");

// Reverse of config.fsTechUsers: SF tech name → FS user ObjectId
const fsUserByTechName = Object.fromEntries(
  Object.entries(config.fsTechUsers).map(([fsId, name]) => [name, fsId])
);
const normTime = (v) => (v ? String(v).slice(0, 5) : null);
const toSfTime = (hhmm) => (hhmm ? `${hhmm}:00.000Z` : null);

// US Eastern DST: second Sunday of March → first Sunday of November.
function nthSunday(year, month, n) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const day = first.getUTCDay();
  return new Date(Date.UTC(year, month - 1, (day === 0 ? 1 : 8 - day) + (n - 1) * 7));
}
function easternOffsetHours(dateStr) {
  const year = +dateStr.slice(0, 4);
  const d = new Date(`${dateStr}T12:00:00Z`);
  return d >= nthSunday(year, 3, 2) && d < nthSunday(year, 11, 1) ? 4 : 5;
}
// Convert SF date (YYYY-MM-DD) + Eastern local time ("HH:MM" or "HH:MM:SS.000Z") to UTC ISO.
function toFsDateTime(dateStr, localTime) {
  const [hh, mm] = localTime.split(':').map(Number);
  const h = hh + easternOffsetHours(dateStr);
  if (h < 24) return `${dateStr}T${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`;
  const next = new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + 86400000);
  return `${next.toISOString().slice(0, 10)}T${String(h - 24).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`;
}
// Build the Schedules array to POST to FS. Preserves existing entry metadata
// (ObjectId, Users, Teams, Data, TimeZone) so the server can match the record.
// Pass null/empty isoDate to return [] which unschedules the task.
function buildFsSchedules(task, isoDate, localTime = '08:00') {
  if (!isoDate) return null;
  const start = toFsDateTime(isoDate, localTime);
  const h = parseInt(start.slice(11, 13), 10);
  const end = start.slice(0, 11) + String((h + 1) % 24).padStart(2, '0') + start.slice(13);
  const existing = Array.isArray(task.Schedules) ? task.Schedules[0] : null;
  if (existing) {
    // Spread existing to preserve ObjectId and all FS metadata — only update times.
    return [{ ...existing, Start: start, End: end }];
  }
  // New schedule: no __type, no Workspace — just the fields FS accepts.
  return [{ Start: start, End: end, Users: [], Teams: [], Data: {}, TimeZone: '' }];
}

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
  const acct = r.Account || {};
  const address = [acct.ShippingStreet, acct.ShippingCity].filter(Boolean).join(', ');
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
  };
}

export const api = new Hono();

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
             ${f.oppFsTaskId}, CreatedDate, CloseDate,
             ${f.addrStreet}, ${f.addrCity},
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

    if ('scheduledDate' in body || 'status' in body) {
      const existing = await sf.query(
        `SELECT ${f.oppScheduledDate}, ${f.oppStatus}, ${f.oppFsTaskId}
         FROM Opportunity WHERE Id = '${esc(id)}' LIMIT 1`
      );
      const cur = existing?.[0];
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
        `SELECT Id FROM ${o.assignment}
         WHERE ${o.assignmentOppLookup} = '${esc(id)}' AND ${o.assignmentCompleted} = false`
      );
      await Promise.all(rows.map((r) =>
        sf.updateRecord(o.assignment, r.Id, { [o.assignmentDate]: null })
      ));
    }

    let fsUpdated = false;
    let fsError = null;

    // Build the FS patch (status + scheduled date) and write it in one call.
    const hasDateChange = 'scheduledDate' in body;
    if (fsTaskId && ('status' in body || hasDateChange)) {
      try {
        const fsPatch = {};

        if ('status' in body) {
          let hasAssignments = false;
          if (body.status === 'Scheduled') {
            const check = await sf.query(
              `SELECT Id FROM ${o.assignment} WHERE ${o.assignmentOppLookup} = '${esc(id)}' LIMIT 1`
            );
            hasAssignments = check.length > 0;
          }
          const fsStatus = sfToFsStatus(body.status, hasAssignments);
          if (fsStatus) fsPatch.Status = fsStatus;
        }

        // Fetch the full task once — needed for patchTask and schedule metadata.
        const task = await fs.getTask(fsTaskId);

        if (hasDateChange) {
          let assignTime = '08:00';
          if (body.scheduledDate) {
            try {
              const asgn = await sf.query(
                `SELECT ${o.assignmentStartTime} FROM ${o.assignment}
                 WHERE ${o.assignmentOppLookup} = '${esc(id)}' LIMIT 1`
              );
              if (asgn[0]?.[o.assignmentStartTime]) assignTime = asgn[0][o.assignmentStartTime];
            } catch (_) {}
          }
          const sched = buildFsSchedules(task, body.scheduledDate, assignTime);
          if (sched) fsPatch.Schedules = sched;
        }

        if (Object.keys(fsPatch).length > 0) {
          await fs.patchTask(fsTaskId, task, fsPatch);
          if (fsPatch.Status) fsUpdated = true;
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
    const sf = createSalesforce(c.env);
    const oppId = c.req.param('oppId');
    const { technicianId, workDate, startTime } = await c.req.json();
    if (!technicianId) return c.json({ error: 'technicianId required' }, 400);

    const fields = {
      [o.assignmentOppLookup]: oppId,
      [o.assignmentTechLookup]: technicianId,
      [o.assignmentStartTime]: toSfTime(startTime || '07:00'),
    };
    if (typeof workDate !== 'undefined') {
      fields[o.assignmentDate] = workDate === '' ? null : workDate;
    }

    const result = await sf.createRecord(o.assignment, fields);
    const createdId = result?.id;

    let assignmentRec = null;
    try {
      const recs = await sf.query(
        `SELECT Id, ${o.assignmentTechLookup}, ${o.assignmentDate}, ${o.assignmentStartTime},
                ${o.assignmentCompleted}, ${o.assignmentTechRelationship}.Name
         FROM ${o.assignment} WHERE Id='${esc(createdId)}'`
      );
      if (recs?.[0]) {
        const r = recs[0];
        assignmentRec = {
          assignmentId: r.Id,
          technicianId: r[o.assignmentTechLookup],
          technicianName: r[o.assignmentTechRelationship]?.Name ?? null,
          workDate: r[o.assignmentDate] ?? null,
          startTime: normTime(r[o.assignmentStartTime]) || '07:00',
          completed: r[o.assignmentCompleted] === true,
        };
      }
    } catch (e) {
      console.log('[API] Warning: could not fetch created assignment', e.message);
    }

    // Sync new assignment to FS if the job has a linked FS task
    const fsDebug = { techName: assignmentRec?.technicianName ?? null, fsUserId: null, fsTaskId: null, patch: null, error: null };
    if (assignmentRec?.technicianName) {
      const fsUserId = fsUserByTechName[assignmentRec.technicianName];
      fsDebug.fsUserId = fsUserId ?? `NOT IN MAP (name="${assignmentRec.technicianName}")`;
      if (fsUserId) {
        let fsTaskId = null;
        try {
          const fs = createFs(c.env);
          const opps = await sf.query(
            `SELECT ${f.oppFsTaskId}, ${f.oppScheduledDate}
             FROM Opportunity WHERE Id = '${esc(oppId)}' LIMIT 1`
          );
          fsTaskId = opps[0]?.[f.oppFsTaskId];
          fsDebug.fsTaskId = fsTaskId ?? 'NULL (not linked)';
          if (fsTaskId) {
            const task = await fs.getTask(fsTaskId);
            const toId = (u) => (typeof u === 'string' ? u : u?.ObjectId ?? null);
            const currentUserIds = (Array.isArray(task.Users) ? task.Users : []).map(toId).filter(Boolean);
            const patch = {};
            if (!currentUserIds.includes(fsUserId)) {
              // Keep original Users format (may be objects) — /Task endpoint handles mixed arrays.
              patch.Users = [...(task.Users ?? []), fsUserId];
            }
            const assignDate = workDate || opps[0]?.[f.oppScheduledDate];
            if (assignDate) {
              const sched = buildFsSchedules(task, assignDate, startTime || '08:00');
              if (sched) patch.Schedules = sched;
            }
            fsDebug.patch = Object.keys(patch);
            if (Object.keys(patch).length > 0) {
              await fs.patchTask(fsTaskId, task, patch);
            }
          }
        } catch (fsErr) {
          console.error('[routes] FS assign failed (SF kept):', fsErr.message, { fsTaskId });
          fsDebug.error = fsErr.message;
        }
      }
    }

    return c.json({ assignmentId: createdId, assignment: assignmentRec, fsDebug });
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
    if (Object.keys(fields).length === 0) return c.json({ error: 'Nothing to update' }, 400);

    await sf.updateRecord(o.assignment, id, fields);
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
    let oppId = null;
    try {
      const rows = await sf.query(
        `SELECT ${o.assignmentOppLookup}, ${o.assignmentTechRelationship}.Name
         FROM ${o.assignment} WHERE Id = '${esc(id)}' LIMIT 1`
      );
      if (rows[0]) {
        techName = rows[0][o.assignmentTechRelationship]?.Name ?? null;
        oppId = rows[0][o.assignmentOppLookup] ?? null;
      }
    } catch (e) {
      console.warn('[routes] Could not pre-fetch assignment for FS sync:', e.message);
    }

    await sf.deleteRecord(o.assignment, id);

    // Remove the user from the FS task if they're a syncable tech
    const fsUserId = techName ? fsUserByTechName[techName] : null;
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
          // Filter by normalized ID but keep original format (objects/strings) for /Task endpoint.
          const updatedUsers = (Array.isArray(task.Users) ? task.Users : []).filter(u => toId(u) !== fsUserId);
          await fs.patchTask(fsTaskId, task, { Users: updatedUsers });
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
      // Fetch opp, full FS task, and existing SF assignments all in parallel so
      // assignment count is available before we decide the FS status to write.
      const [oppRows, fullTask, existingAssignments] = await Promise.all([
        sf.query(
          `SELECT ${f.oppStatus}, ${f.oppScheduledDate}, LastModifiedDate
           FROM Opportunity WHERE Id = '${esc(id)}' LIMIT 1`
        ),
        fs.getTask(fsTaskId),
        sf.query(`SELECT ${o.assignmentTechRelationship}.Name, ${o.assignmentStartTime} FROM ${o.assignment} WHERE ${o.assignmentOppLookup} = '${esc(id)}'`),
      ]);
      const sfOpp = oppRows[0];
      if (!sfOpp) throw new Error('Opp not found');

      // Sync users: FS → SF — find techs in FS not yet in SF.
      const syncableUserIds = (Array.isArray(fullTask.Users) ? fullTask.Users : [])
        .filter(uid => uid in config.fsTechUsers);

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
        const sfTechs = await sf.query(
          `SELECT Id, Name FROM ${o.technician} WHERE ${o.technicianActive} = true`
        );
        const sfTechIdByName = Object.fromEntries(sfTechs.map(t => [t.Name, t.Id]));

        for (const fsUserId of syncableUserIds) {
          const techName = config.fsTechUsers[fsUserId];
          if (assignedNames.has(techName)) continue;
          const sfTechId = sfTechIdByName[techName];
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