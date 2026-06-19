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

    // Default board: cap to the last 365 days (by Close Date) so we don't
    // blow past the 2000-row first page. A specific ?status= request is an
    // on-demand history pull and must NOT be capped.
    const sinceClause = statusParam ? '' : `AND CloseDate >= LAST_N_DAYS:365`;
    const excludeClause = `AND (${f.oppType} != 'Monitoring' OR ${f.oppType} = null)`;

    const soql = `
      SELECT Id, ${f.oppName}, ${f.oppLid}, ${f.oppStatus}, ${f.oppScheduledDate}, CreatedDate, CloseDate,
             ${f.addrStreet}, ${f.addrCity},
             (SELECT Id, ${o.assignmentTechLookup}, ${o.assignmentTechRelationship}.Name, ${o.assignmentDate}, ${o.assignmentCompleted}
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

    if (shouldReleaseCrew && !suppressRelease) {
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

    // Only set the assignment date when the caller explicitly provides it.
    // If `workDate` is present and is an empty string, store null (clear).
    // If `workDate` is absent, leave the field off the payload so it remains unset.
    if (typeof workDate !== 'undefined') {
      fields[o.assignmentDate] = workDate === '' ? null : workDate;
    }

    const result = await sf.createRecord(o.assignment, fields);
    const createdId = result && result.id;
    console.log('[API] Created assignment', { oppId, technicianId, fields, resultId: createdId });

    // Fetch the created assignment record so the client can receive the
    // server-side stored values (Work_Date__c, Completed__c, Technician__r.Name).
    let assignmentRec = null;
    try {
      const recs = await sf.query(
        `SELECT Id, ${o.assignmentTechLookup}, ${o.assignmentDate}, ${o.assignmentCompleted}, ${o.assignmentTechRelationship}.Name FROM ${o.assignment} WHERE Id='${esc(createdId)}'`
      );
      if (recs && recs[0]) {
        const r = recs[0];
        assignmentRec = {
          assignmentId: r.Id,
          technicianId: r[o.assignmentTechLookup],
          technicianName: r[o.assignmentTechRelationship]?.Name ?? null,
          workDate: r[o.assignmentDate] ?? null,
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
    if (Object.keys(fields).length === 0) return c.json({ error: 'Nothing to update' }, 400);

    await sf.updateRecord(o.assignment, id, fields);
    console.log('[API] Updated assignment', { id, fields });
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