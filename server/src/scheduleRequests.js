import { Hono } from 'hono';
import { config } from './config.js';
import { createSalesforce } from './salesforce.js';
import { createAssignment, esc, normTime, toSfTime } from './assignments.js';
import { notifyTech } from './notifyBoard.js';

const sr = config.scheduleRequest;
const OPEN_STATUSES = ['Requested', 'Countered'];
// Capped so a shop with years of history doesn't pull an unbounded resolved
// list into the "Previous requests" panel -- it's lazy-loaded on demand
// (see web/src/App.jsx's RequestsTab), not part of the default view, but
// still worth bounding.
const RESOLVED_LIMIT = 100;

const SELECT_FIELDS = `Id, ${sr.job}, ${sr.jobRelationship}.Name, ${sr.type},
  ${sr.tech}, ${sr.techRelationship}.Name,
  ${sr.requestedBy}, ${sr.requestedByRelationship}.Name,
  ${sr.proposedDate}, ${sr.proposedStart}, ${sr.proposedEnd},
  ${sr.status}, ${sr.lastOfferBy}, ${sr.note}, ${sr.officeNote}, ${sr.resolvedAt}, CreatedDate`;

function shapeRequest(r, env) {
  return {
    id: r.Id,
    jobId: r[sr.job] ?? null,
    jobName: r[sr.jobRelationship]?.Name ?? null,
    type: r[sr.type] ?? null,
    technicianId: r[sr.tech] ?? null,
    technicianName: r[sr.techRelationship]?.Name ?? null,
    requestedById: r[sr.requestedBy] ?? null,
    requestedByName: r[sr.requestedByRelationship]?.Name ?? null,
    proposedDate: r[sr.proposedDate] ?? null,
    proposedStart: normTime(r[sr.proposedStart]),
    proposedEnd: normTime(r[sr.proposedEnd]),
    status: r[sr.status],
    lastOfferBy: r[sr.lastOfferBy] ?? null,
    note: r[sr.note] ?? null,
    officeNote: r[sr.officeNote] ?? null,
    resolvedAt: r[sr.resolvedAt] ?? null,
    createdDate: r.CreatedDate ?? null,
    // Derived fields the requests panel needs.
    waitingOn: r[sr.lastOfferBy] === 'Office' ? 'tech' : 'office',
    isTimeOff: r[sr.type] === 'Time off',
    isNewWo: r[sr.job] === env.NEW_WO_OPPORTUNITY_ID,
    ageHours: r.CreatedDate ? (Date.now() - new Date(r.CreatedDate).getTime()) / 3600000 : null,
  };
}

export const scheduleRequests = new Hono();

// ?resolved=1 returns the resolved (Approved/Denied/Withdrawn) history
// instead of the default open (Requested/Countered) queue -- a separate
// mode rather than a separate route so the frontend's existing
// getScheduleRequests() call shape barely changes.
scheduleRequests.get('/schedule-requests', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const resolved = c.req.query('resolved') === '1';
    const soql = resolved
      ? `SELECT ${SELECT_FIELDS} FROM ${sr.sobject}
         WHERE ${sr.status} NOT IN ('${OPEN_STATUSES.join("','")}') AND ${sr.resolvedAt} != null
         ORDER BY ${sr.resolvedAt} DESC
         LIMIT ${RESOLVED_LIMIT}`
      : `SELECT ${SELECT_FIELDS} FROM ${sr.sobject}
         WHERE ${sr.status} IN ('${OPEN_STATUSES.join("','")}')
         ORDER BY CreatedDate ASC`;
    const records = await sf.query(soql);
    return c.json(records.map((r) => shapeRequest(r, c.env)));
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

scheduleRequests.post('/schedule-requests/:id/approve', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const id = c.req.param('id');
    const { opportunityId } = await c.req.json().catch(() => ({}));

    const rows = await sf.query(
      `SELECT Id, ${sr.job}, ${sr.type}, ${sr.tech}, ${sr.proposedDate}, ${sr.proposedStart}, ${sr.proposedEnd},
              ${sr.status}, ${sr.lastOfferBy}
       FROM ${sr.sobject} WHERE Id = '${esc(id)}' LIMIT 1`
    );
    const reqRec = rows[0];
    if (!reqRec) return c.json({ error: 'Schedule request not found' }, 404);

    if (!OPEN_STATUSES.includes(reqRec[sr.status])) {
      return c.json({ error: `Cannot approve a request in status "${reqRec[sr.status]}"` }, 409);
    }
    // The office cannot accept its own live offer — the turn belongs to the technician.
    if (reqRec[sr.lastOfferBy] === 'Office') {
      return c.json({ error: 'Cannot approve — waiting on technician response' }, 409);
    }

    // Time off isn't tied to a job — Job__c may be blank on these records — so
    // the target is derived from Type__c, not read off Job__c. Everything else
    // (job requests, "New WO Required") does use Job__c as the target.
    const isTimeOff = reqRec[sr.type] === 'Time off';
    let targetOppId = isTimeOff ? c.env.TIME_OFF_OPPORTUNITY_ID : reqRec[sr.job];

    if (!isTimeOff) {
      if (targetOppId === c.env.NEW_WO_OPPORTUNITY_ID && !opportunityId) {
        return c.json({ error: 'opportunityId required to approve a "New WO Required" request' }, 400);
      }
      if (opportunityId) {
        // Re-point first — preserves the trail from the original ask to the real job.
        await sf.updateRecord(sr.sobject, id, { [sr.job]: opportunityId });
        targetOppId = opportunityId;
      }
    }

    // status passed unconditionally — createAssignment's time-off sentinel guard
    // nulls it out when targetOppId is the time-off sentinel.
    const { assignmentId } = await createAssignment(c.env, targetOppId, {
      technicianId: reqRec[sr.tech],
      workDate: reqRec[sr.proposedDate],
      startTime: normTime(reqRec[sr.proposedStart]),
      endTime: normTime(reqRec[sr.proposedEnd]),
      status: 'Scheduled',
      deriveScheduledDate: true,
    });

    await sf.updateRecord(sr.sobject, id, {
      [sr.status]: 'Approved',
      [sr.resultingAssignment]: assignmentId,
      [sr.resolvedAt]: new Date().toISOString(),
    });

    return c.json({ ok: true, assignmentId, opportunityId: targetOppId });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

scheduleRequests.post('/schedule-requests/:id/counter', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const id = c.req.param('id');
    const { date, start, end, officeNote } = await c.req.json();

    const rows = await sf.query(
      `SELECT Id, ${sr.status}, ${sr.lastOfferBy}, ${sr.techRelationship}.Name FROM ${sr.sobject} WHERE Id = '${esc(id)}' LIMIT 1`
    );
    const reqRec = rows[0];
    if (!reqRec) return c.json({ error: 'Schedule request not found' }, 404);

    if (!OPEN_STATUSES.includes(reqRec[sr.status])) {
      return c.json({ error: `Cannot counter a request in status "${reqRec[sr.status]}"` }, 409);
    }
    // The office cannot counter its own live offer — not its turn.
    if (reqRec[sr.lastOfferBy] === 'Office') {
      return c.json({ error: 'Cannot counter — waiting on technician response' }, 409);
    }

    // Countering overwrites rather than appending — SF field history is the audit trail.
    const payload = {
      [sr.proposedDate]: date,
      [sr.proposedStart]: toSfTime(start),
      [sr.proposedEnd]: toSfTime(end),
      [sr.status]: 'Countered',
      [sr.lastOfferBy]: 'Office',
    };
    if (officeNote) payload[sr.officeNote] = officeNote;

    await sf.updateRecord(sr.sobject, id, payload);
    await notifyTech(c.env, reqRec[sr.techRelationship]?.Name, 'counter');
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

scheduleRequests.post('/schedule-requests/:id/deny', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const id = c.req.param('id');
    const { officeNote } = await c.req.json();
    if (!officeNote) return c.json({ error: 'officeNote required' }, 400);

    const rows = await sf.query(
      `SELECT Id, ${sr.status}, ${sr.techRelationship}.Name FROM ${sr.sobject} WHERE Id = '${esc(id)}' LIMIT 1`
    );
    const reqRec = rows[0];
    if (!reqRec) return c.json({ error: 'Schedule request not found' }, 404);

    // Denial isn't accepting an offer, so it's allowed regardless of whose turn it is.
    if (!OPEN_STATUSES.includes(reqRec[sr.status])) {
      return c.json({ error: `Cannot deny a request in status "${reqRec[sr.status]}"` }, 409);
    }

    await sf.updateRecord(sr.sobject, id, {
      [sr.status]: 'Denied',
      [sr.officeNote]: officeNote,
      [sr.resolvedAt]: new Date().toISOString(),
    });
    await notifyTech(c.env, reqRec[sr.techRelationship]?.Name, 'deny');
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});
