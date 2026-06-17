import express from 'express';
import { config } from './config.js';
import { query, createRecord, deleteRecord, updateRecord } from './salesforce.js';

export const router = express.Router();
const f = config.fields;
const o = config.objects;

const esc = (s) => String(s).replace(/'/g, "\\'");

// Turn one Salesforce Opportunity record into a clean shape for the UI.
function shapeJob(r) {
  const child = r[o.assignmentChildRelationship];
  const assignments = child
    ? child.records.map((a) => ({
        assignmentId: a.Id,
        technicianId: a[o.assignmentTechLookup],
        technicianName: a[o.assignmentTechRelationship]?.Name ?? null,
        workDate: a[o.assignmentDate] ?? null,
      }))
    : [];

  const acct = r.Account || {};
  const address = [acct.ShippingStreet, acct.ShippingCity].filter(Boolean).join(', ');

  return {
    id: r.Id,
    name: r[f.oppName],
    status: r[f.oppStatus],
    scheduledDate: r[f.oppScheduledDate] ?? null,
    address,
    assignments,
  };
}

// GET /api/jobs            -> all field-ready jobs
// GET /api/jobs?status=... -> just that status
router.get('/jobs', async (req, res) => {
  try {
    const statuses = req.query.status ? [req.query.status] : config.jobStatusValues;
    const inList = statuses.map((s) => `'${esc(s)}'`).join(',');

    const soql = `
      SELECT Id, ${f.oppName}, ${f.oppStatus}, ${f.oppScheduledDate},
             ${f.addrStreet}, ${f.addrCity},
             (SELECT Id, ${o.assignmentTechLookup}, ${o.assignmentTechRelationship}.Name, ${o.assignmentDate}
              FROM ${o.assignmentChildRelationship})
      FROM Opportunity
      WHERE ${f.oppStatus} IN (${inList})
      ORDER BY ${f.oppScheduledDate} ASC NULLS LAST`;

    const records = await query(soql);
    res.json(records.map(shapeJob));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/technicians -> active techs for the assign dropdown
router.get('/technicians', async (req, res) => {
  try {
    const soql = `SELECT Id, Name FROM ${o.technician}
                  WHERE ${o.technicianActive} = true ORDER BY Name`;
    const recs = await query(soql);
    res.json(recs.map((t) => ({ id: t.Id, name: t.Name })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/jobs/:id  { scheduledDate?, status? }
// Writes an Opportunity change straight back. Only whitelisted fields are
// allowed, mapped to your real API names from config — no arbitrary writes.
router.patch('/jobs/:id', async (req, res) => {
  try {
    const allowed = {
      scheduledDate: f.oppScheduledDate,
      status: f.oppStatus,
    };
    const payload = {};
    for (const [key, value] of Object.entries(req.body)) {
      // Empty string from a cleared date input -> null, not '' (SF rejects '').
      if (allowed[key]) payload[allowed[key]] = value === '' ? null : value;
    }
    if (Object.keys(payload).length === 0) {
      return res.status(400).json({ error: 'No writable fields in request' });
    }
    await updateRecord('Opportunity', req.params.id, payload);

    // A job's assignments must always sit on its scheduled date. If the date
    // changed, move every assignment row for this Opportunity to match.
    if ('scheduledDate' in req.body) {
      const date = req.body.scheduledDate === '' ? null : req.body.scheduledDate;
      const rows = await query(
        `SELECT Id FROM ${o.assignment} WHERE ${o.assignmentOppLookup} = '${esc(req.params.id)}'`
      );
      await Promise.all(rows.map((r) =>
        updateRecord(o.assignment, r.Id, { [o.assignmentDate]: date })
      ));
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/jobs/:oppId/assignments  { technicianId, workDate? }
// Adds one tech to one job (dynamic count = more of these rows).
router.post('/jobs/:oppId/assignments', async (req, res) => {
  try {
    const { technicianId, workDate } = req.body;
    if (!technicianId) return res.status(400).json({ error: 'technicianId required' });

    const fields = {
      [o.assignmentOppLookup]: req.params.oppId,
      [o.assignmentTechLookup]: technicianId,
    };
    if (workDate) fields[o.assignmentDate] = workDate;

    const result = await createRecord(o.assignment, fields);
    res.json({ assignmentId: result.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/assignments/:id -> remove a tech from a job
router.delete('/assignments/:id', async (req, res) => {
  try {
    await deleteRecord(o.assignment, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});