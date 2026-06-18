import { Hono } from 'hono';
import { config } from './config.js';
import { createSalesforce } from './salesforce.js';

const f = config.fields;
const o = config.objects;
const esc = (s) => String(s).replace(/'/g, "\\'");

// --- shapeJob is identical to your current version ---
function shapeJob(r) {
  const child = r[o.assignmentChildRelationship];
  const assignments = child
    ? child.records.map((a) => ({
        assignmentId: a.Id,
        technicianId: a[o.assignmentTechLookup],
        technicianName: a[o.assignmentTechRelationship]?.Name ?? null,
        workDate: a[o.assignmentDate] ?? null,
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
  };
}

export const api = new Hono();

api.get('/jobs', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const statusParam = c.req.query('status');
    const statuses = statusParam ? [statusParam] : config.jobStatusValues;
    const inList = statuses.map((s) => `'${esc(s)}'`).join(',');

    const soql = `
      SELECT Id, ${f.oppName}, ${f.oppLid}, ${f.oppStatus}, ${f.oppScheduledDate}, CreatedDate, CloseDate,
             ${f.addrStreet}, ${f.addrCity},
             (SELECT Id, ${o.assignmentTechLookup}, ${o.assignmentTechRelationship}.Name, ${o.assignmentDate}, ${o.assignmentCompleted}
              FROM ${o.assignmentChildRelationship})
      FROM Opportunity
      WHERE ${f.oppStatus} IN (${inList})
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
    const id = c.req.param('id');
    const body = await c.req.json();

    const allowed = { scheduledDate: f.oppScheduledDate, status: f.oppStatus };
    const payload = {};
    for (const [key, value] of Object.entries(body)) {
      if (allowed[key]) payload[allowed[key]] = value === '' ? null : value;
    }
    if (Object.keys(payload).length === 0) {
      return c.json({ error: 'No writable fields in request' }, 400);
    }

    let shouldReleaseCrew = false;
    if ('scheduledDate' in body) {
      const existing = await sf.query(
        `SELECT ${f.oppScheduledDate} FROM Opportunity WHERE Id='${esc(id)}'`
      );
      const currentVal = existing && existing[0] ? existing[0][f.oppScheduledDate] ?? null : null;
      const incomingVal = body.scheduledDate === '' ? null : body.scheduledDate;
      if (currentVal !== incomingVal) shouldReleaseCrew = true;
    }

    await sf.updateRecord('Opportunity', id, payload);

    if (shouldReleaseCrew) {
      const rows = await sf.query(
        `SELECT Id FROM ${o.assignment}
         WHERE ${o.assignmentOppLookup} = '${esc(id)}' AND ${o.assignmentCompleted} = false`
      );
      await Promise.all(rows.map((r) =>
        sf.updateRecord(o.assignment, r.Id, { [o.assignmentDate]: null })
      ));
    }

    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

api.post('/jobs/:oppId/assignments', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const oppId = c.req.param('oppId');
    const { technicianId, workDate } = await c.req.json();
    if (!technicianId) return c.json({ error: 'technicianId required' }, 400);

    const fields = {
      [o.assignmentOppLookup]: oppId,
      [o.assignmentTechLookup]: technicianId,
    };
    if (workDate) fields[o.assignmentDate] = workDate;

    const result = await sf.createRecord(o.assignment, fields);
    return c.json({ assignmentId: result.id });
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