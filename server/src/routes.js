import express from 'express';
import { config } from './config.js';
import { query, createRecord, deleteRecord } from './salesforce.js';

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
