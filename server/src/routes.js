import { Hono } from 'hono';
import { config } from './config.js';
import { createSalesforce } from './salesforce.js';
import { createFs } from './fieldSquared.js';
import { FS_TO_SF, SF_TO_FS } from './statusMap.js';
import { runFsSync } from './fsSync.js';

const f = config.fields;
const o = config.objects;
const esc = (s) => String(s).replace(/'/g, "\\'");
const normTime = (v) => (v ? String(v).slice(0, 5) : null);
const toSfTime = (hhmm) => (hhmm ? `${hhmm}:00.000Z` : null);

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
    c.executionCtx.waitUntil(runFsSync(c.env));
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
      if ('status' in body) {
        previousSfStatus = cur?.[f.oppStatus] ?? null;
        fsTaskId = cur?.[f.oppFsTaskId] ?? null;
      }
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

    if ('status' in body && fsTaskId) {
      try {
        const task = await fs.getTask(fsTaskId);
        const fsStatus = SF_TO_FS[body.status];
        if (fsStatus) {
          await fs.updateStatus(fsTaskId, task.Name, task.TaskType, fsStatus);
          fsUpdated = true;
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

    return c.json({ assignmentId: createdId, assignment: assignmentRec });
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
    await sf.deleteRecord(o.assignment, c.req.param('id'));
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
    const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const tasks = await fs.listModified(since);

    const lower = q.toLowerCase();
    const matches = tasks
      .filter((t) => t.Name && t.Name.toLowerCase().includes(lower))
      .slice(0, 15)
      .map((t) => ({ externalId: t.ExternalId, name: t.Name, status: t.Status, taskType: t.TaskType }));

    return c.json({ matches });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Manually stamp an FS task ID onto a SF opportunity.
api.post('/jobs/:id/fs-link', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const id = c.req.param('id');
    const { fsTaskId } = await c.req.json();
    if (!fsTaskId) return c.json({ error: 'fsTaskId required' }, 400);

    await sf.updateRecord('Opportunity', id, { [f.oppFsTaskId]: fsTaskId });
    return c.json({ ok: true, fsTaskId });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});