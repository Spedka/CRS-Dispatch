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
    closeDate: r.CloseDate ?? null,
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
      SELECT Id, ${f.oppName}, ${f.oppLid}, ${f.oppStatus}, ${f.oppScheduledDate}, CloseDate,
             ${f.addrStreet}, ${f.addrCity},
             (SELECT Id, ${o.assignmentTechLookup}, ${o.assignmentTechRelationship}.Name, ${o.assignmentDate}, ${o.assignmentCompleted}
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
    // If the caller provided a scheduledDate, check whether it actually
    // changed before we go clear non-completed assignment dates. Clearing
    // is destructive and should only run when the Opportunity's scheduled
    // date is being updated to a different value.
    let shouldReleaseCrew = false;
    if ('scheduledDate' in req.body) {
      const existing = await query(
        `SELECT ${f.oppScheduledDate} FROM Opportunity WHERE Id='${esc(req.params.id)}'`
      );
      const currentVal = existing && existing[0] ? existing[0][f.oppScheduledDate] ?? null : null;
      const incomingVal = req.body.scheduledDate === '' ? null : req.body.scheduledDate;
      if (currentVal !== incomingVal) shouldReleaseCrew = true;
    }

    await updateRecord('Opportunity', req.params.id, payload);

    // Only release planned crew (clear non-completed assignment dates) when
    // the scheduled date actually changed.
    if (shouldReleaseCrew) {
      const rows = await query(
        `SELECT Id FROM ${o.assignment}
         WHERE ${o.assignmentOppLookup} = '${esc(req.params.id)}' AND ${o.assignmentCompleted} = false`
      );
      await Promise.all(rows.map((r) =>
        updateRecord(o.assignment, r.Id, { [o.assignmentDate]: null })
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

// PATCH /api/assignments/:id  { completed?, workDate? }
// Edit a single assignment: mark it done/undone, and/or set its own date.
router.patch('/assignments/:id', async (req, res) => {
  try {
    const fields = {};
    if (typeof req.body.completed === 'boolean') {
      fields[o.assignmentCompleted] = req.body.completed;
    }
    if ('workDate' in req.body) {
      fields[o.assignmentDate] = req.body.workDate === '' ? null : req.body.workDate;
    }
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    await updateRecord(o.assignment, req.params.id, fields);
    res.json({ ok: true });
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