import { Hono } from 'hono';
import { config, statusFieldForType, allStatusFields, stageForQuoteStatus } from './config.js';
import { createSalesforce } from './salesforce.js';
import { createFs } from './fieldSquared.js';
import { sfToFsStatus } from './statusMap.js';
import { runFsSync } from './fsSync.js';
import { createAssignment, esc, normTime, toSfTime, buildFsSchedules, getTechDirectory, invalidateTechDirectory } from './assignments.js';
import { scheduleRequests } from './scheduleRequests.js';
import { parts } from './parts.js';
import { notifyTech } from './notifyBoard.js';
import { notifyTv } from './notifyTv.js';
import { getAuthSecret, signDeviceToken, resolveBearer } from './auth.js';

const f = config.fields;
const o = config.objects;
const n = config.dispatchNote;
const acc = config.account;
const inv = config.invoicing;
const ou = config.officeUser;
const FS_TASK_TYPE = 'CCTV Job/Work Order'; // only task type currently synced;

// ---- Record-type-aware board query helpers ----
// The status columns every board job query must SELECT so shapeJob can resolve
// the right one per record type (Project_Status__c + Service_Status__c +
// StageName + Monitoring_Status__c). Also pulls RecordType.DeveloperName.
const JOB_STATUS_SELECT = `RecordType.DeveloperName, ${allStatusFields().join(', ')}`;

// Builds the "belongs on the dispatch board" SOQL predicate. Legacy/none +
// Default + Job + Work_Order match on Project_Status__c (jobStatusValues);
// Service_Call matches on Service_Status__c, Test_Inspection on StageName —
// each against its own board value list. Monitoring is excluded entirely (both
// the record type and the legacy Opportunity_Type__c = 'Monitoring' value).
// When `statusValue` is passed, every branch is narrowed to that single value
// (matched against whichever status field applies to each type).
function boardStatusPredicate(statusValue) {
  const rt = config.recordTypeStatus;
  const inClause = (field, values) => {
    const list = (statusValue ? [statusValue] : values).map((s) => `'${esc(s)}'`).join(',');
    return `${field} IN (${list})`;
  };
  const diverged = Object.keys(rt.fieldByType); // Service_Call, Test_Inspection, Monitoring
  const divergedList = diverged.map((t) => `'${t}'`).join(',');
  const baseBranch =
    `((RecordType.DeveloperName NOT IN (${divergedList}) OR RecordType.DeveloperName = null)` +
    ` AND (${f.oppType} != 'Monitoring' OR ${f.oppType} = null)` +
    ` AND ${inClause(rt.fallbackField, config.jobStatusValues)})`;
  const typedBranches = Object.entries(rt.valuesByType).map(([type, values]) =>
    `(RecordType.DeveloperName = '${type}' AND ${inClause(rt.fieldByType[type], values)})`);
  return `(${[baseBranch, ...typedBranches].join(' OR ')})`;
}

// Quotes-tab predicate: match a single status VALUE against each record type's
// resolved status field. Unlike the board, this INCLUDES Monitoring (Monitoring
// quotes belong on the Quotes tab even though Monitoring is off the board).
function quoteStatusPredicate(statusValue) {
  const rt = config.recordTypeStatus;
  const v = `'${esc(statusValue)}'`;
  const diverged = Object.keys(rt.fieldByType); // Service_Call, Test_Inspection, Monitoring
  const divergedList = diverged.map((t) => `'${t}'`).join(',');
  const base = `((RecordType.DeveloperName NOT IN (${divergedList}) OR RecordType.DeveloperName = null) AND ${rt.fallbackField} = ${v})`;
  const typed = Object.entries(rt.fieldByType).map(([type, field]) => `(RecordType.DeveloperName = '${type}' AND ${field} = ${v})`);
  return `(${[base, ...typed].join(' OR ')})`;
}

function shapeNote(r) {
  return {
    id: r.Id,
    text: r[n.body] ?? '',
    opportunityId: r[n.opportunity] ?? null,
    opportunitySpecific: r[n.opportunitySpecific] === true,
    opportunityName: r[n.opportunityRelationship]?.Name ?? null,
    opportunityLid: r[n.opportunityRelationship]?.[f.oppLid] ?? null,
    createdDate: r.CreatedDate ?? null,
    lastModifiedDate: r.LastModifiedDate ?? null,
  };
}

export function shapeJob(r) {
  const child = r[o.assignmentChildRelationship];
  const assignments = child
    ? child.records.map((a) => ({
        assignmentId: a.Id,
        technicianId: a[o.assignmentTechLookup],
        technicianName: a[o.assignmentTechRelationship]?.Name ?? null,
        workDate: a[o.assignmentDate] ?? null,
        startTime: normTime(a[o.assignmentStartTime]) || '07:00',
        endTime: normTime(a[o.assignmentEndTime]),
        completed: a[o.assignmentCompleted] === true,
      }))
    : [];
  const address = [r[f.addrStreet], r[f.addrCity], r[f.addrState], r[f.addrZip]].filter(Boolean).join(', ');
  // Resolve the lifecycle status from whichever field this record type uses
  // (Project_Status__c for legacy/Job/Work_Order, Service_Status__c for
  // Service Call, StageName for Test & Inspection). `recordType` is surfaced so
  // the frontend can pick the matching status dropdown + drift table.
  const recordType = r.RecordType?.DeveloperName ?? null;
  return {
    id: r.Id,
    name: r[f.oppName],
    lid: r[f.oppLid] ?? null,
    status: r[statusFieldForType(recordType)] ?? null,
    recordType,
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

function shapeQuote(r) {
  const recordType = r.RecordType?.DeveloperName ?? null;
  const account = r[f.oppAccountRelationship] ?? {};
  return {
    id: r.Id,
    name: r[f.oppName],
    opportunityType: r[f.oppType] ?? null,
    status: r[statusFieldForType(recordType)] ?? null,
    recordType,
    dueDate: r[f.oppBidDate] ?? null,
    reviewDeadline: r[f.oppReviewDeadline] ?? null,
    accountName: account.Name ?? null,
    // Installed-system manufacturers from the linked Account, shown in the
    // quote card's "System Info" modal. Null = not recorded on the account.
    systems: {
      fireAlarm: account[acc.fireAlarmMfr] ?? null,
      accessControl: account[acc.accessControlMfr] ?? null,
      cctv: account[acc.cctvMfr] ?? null,
      intrusion: account[acc.intrusionMfr] ?? null,
    },
    sentToCustomer: r[f.oppSentToCustomer] === true,
    readyForReview: r[f.oppReadyForReview] === true,
    createdDate: r.CreatedDate ?? null,
  };
}

// Shared by the "Sent"/"Review" quote actions: send the notification email,
// then stamp the relevant checkbox -- a failed stamp doesn't undo the send,
// just gets surfaced separately (same no-rollback convention as the FS
// write-through's fsError). The caller (App.jsx) is what gates the actual
// status PATCH on this succeeding, not this helper.
async function sendQuoteNotification(sf, id, recipients, { subject, html, stampField }) {
  await sf.sendEmail({ to: recipients, subject, html });
  let stamped = false;
  let stampError = null;
  try {
    await sf.updateRecord('Opportunity', id, { [stampField]: true });
    stamped = true;
  } catch (e) {
    stampError = e.message;
  }
  return { ok: true, stamped, stampError };
}

function shapeQuoteDocument(r, instanceUrl) {
  const doc = r.ContentDocument || {};
  const name = doc.FileExtension ? `${doc.Title}.${doc.FileExtension}` : doc.Title;
  return {
    id: r.ContentDocumentId,
    name,
    url: `${instanceUrl}/${r.ContentDocumentId}`,
    lastModified: doc.LastModifiedDate ?? null,
  };
}

// Runs the default (no status filter) jobs query -- the same one GET /jobs
// runs with no ?status= param. Extracted so server/src/tv.js's aggregating
// /api/tv/data handler shares this exact query/shape instead of duplicating
// the SOQL.
export async function getAllJobs(env) {
  const sf = createSalesforce(env);

  const soql = `
    SELECT Id, ${f.oppName}, ${f.oppLid}, ${JOB_STATUS_SELECT}, ${f.oppScheduledDate},
           ${f.oppFsTaskId}, ${f.oppFsStatus}, ${f.oppFsLastModified}, ${f.oppType}, CreatedDate, CloseDate,
           ${f.addrStreet}, ${f.addrCity}, ${f.addrState}, ${f.addrZip},
           (SELECT Id, ${o.assignmentTechLookup}, ${o.assignmentTechRelationship}.Name,
                   ${o.assignmentDate}, ${o.assignmentStartTime}, ${o.assignmentEndTime}, ${o.assignmentCompleted}
            FROM ${o.assignmentChildRelationship})
    FROM Opportunity
    WHERE ${boardStatusPredicate()}
    AND (CloseDate >= LAST_N_DAYS:365 OR CloseDate > TODAY)
    ORDER BY ${f.oppScheduledDate} ASC NULLS LAST`;

  const records = await sf.query(soql);
  return records.map(shapeJob);
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Same query as GET /technicians -- extracted for the same reason as
// getAllJobs above. includeInactive=true is used by the Manage Techs panel
// (which needs to show/reactivate deactivated techs); every other caller
// (assignment pickers, the /tv calendar) wants the default active-only list.
export async function getAllTechnicians(env, includeInactive = false) {
  const sf = createSalesforce(env);
  const soql = `SELECT Id, Name, ${o.technicianActive}, ${o.technicianFsUserId}, ${o.technicianColor}
                FROM ${o.technician}
                ${includeInactive ? '' : `WHERE ${o.technicianActive} = true`}
                ORDER BY Name`;
  const recs = await sf.query(soql);
  return recs.map((t) => ({
    id: t.Id,
    name: t.Name,
    active: t[o.technicianActive] === true,
    fsUserId: t[o.technicianFsUserId] ?? null,
    color: t[o.technicianColor] ?? null,
  }));
}

// Same query as GET /time-off -- extracted for the same reason as
// getAllJobs above. start/end must already be validated YYYY-MM-DD strings.
export async function getTimeOffRange(env, start, end) {
  const sf = createSalesforce(env);
  const soql = `
    SELECT Id, ${o.assignmentTechLookup}, ${o.assignmentTechRelationship}.Name,
           ${o.assignmentDate}, ${o.assignmentStartTime}, ${o.assignmentEndTime}
    FROM ${o.assignment}
    WHERE ${o.assignmentOppLookup} = '${esc(env.TIME_OFF_OPPORTUNITY_ID)}'
      AND ${o.assignmentDate} >= ${start} AND ${o.assignmentDate} <= ${end}`;
  const records = await sf.query(soql);
  return records.map((r) => ({
    id: r.Id,
    technicianId: r[o.assignmentTechLookup],
    technicianName: r[o.assignmentTechRelationship]?.Name ?? null,
    workDate: r[o.assignmentDate] ?? null,
    startTime: normTime(r[o.assignmentStartTime]),
    endTime: normTime(r[o.assignmentEndTime]),
  }));
}

export const api = new Hono();
api.route('/', scheduleRequests);
api.route('/', parts);

// ---- Office/dispatch auth ----
// Resolves the authenticated office user from the bearer device token (which
// carries the SF User Id). Re-reads role/access LIVE from Salesforce so a
// revoked admin/access takes effect immediately. Returns { id, name, isAdmin }
// or null (unknown / inactive / access revoked).
async function getOfficeUser(c) {
  const id = await resolveBearer(c);
  if (!id) return null;
  const sf = createSalesforce(c.env);
  const rows = await sf.query(
    `SELECT Id, ${ou.name}, ${ou.email}, ${ou.admin}, ${ou.access} FROM ${ou.sobject} ` +
    `WHERE Id = '${esc(id)}' AND ${ou.active} = true LIMIT 1`
  );
  const u = rows[0];
  if (!u || u[ou.access] !== true) return null;
  return { id: u.Id, name: u[ou.name], email: u[ou.email], isAdmin: u[ou.admin] === true };
}

// Login by email + app password. Blank Password__c => DEFAULT_OFFICE_PASSWORD.
api.post('/auth/login', async (c) => {
  try {
    const { email, password } = await c.req.json();
    if (!email || !password) return c.json({ error: 'Email and password required' }, 400);
    const sf = createSalesforce(c.env);
    const rows = await sf.query(
      `SELECT Id, ${ou.name}, ${ou.email}, ${ou.password}, ${ou.admin} FROM ${ou.sobject} ` +
      `WHERE ${ou.email} = '${esc(email)}' AND ${ou.access} = true AND ${ou.active} = true LIMIT 1`
    );
    const u = rows[0];
    const fallback = c.env.DEFAULT_OFFICE_PASSWORD || 'crs';
    const stored = u?.[ou.password];
    const effective = stored && String(stored).length ? String(stored) : fallback;
    if (!u || String(password) !== effective) return c.json({ error: 'Invalid email or password' }, 401);
    const token = await signDeviceToken(u.Id, getAuthSecret(c.env));
    return c.json({ token, name: u[ou.name], email: u[ou.email], isAdmin: u[ou.admin] === true });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

// The signed-in user changes their own password.
api.post('/auth/change-password', async (c) => {
  try {
    const me = await getOfficeUser(c);
    if (!me) return c.json({ error: 'Not authenticated' }, 401);
    const { password } = await c.req.json();
    if (!password || String(password).trim().length < 3) return c.json({ error: 'Password must be at least 3 characters' }, 400);
    const sf = createSalesforce(c.env);
    await sf.updateRecord('User', me.id, { [ou.password]: String(password) });
    return c.json({ ok: true });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

// Whoami — lets the frontend refresh name/role/email on load.
api.get('/auth/me', async (c) => {
  const me = await getOfficeUser(c);
  if (!me) return c.json({ error: 'Not authenticated' }, 401);
  return c.json(me);
});

// Admin-only: list dispatch-access users for the Office Users panel. Includes
// the (plaintext) password so an admin can read a forgotten one, matching the
// deliberate office-visible design.
api.get('/auth/office-users', async (c) => {
  try {
    const me = await getOfficeUser(c);
    if (!me?.isAdmin) return c.json({ error: 'Admin only' }, 403);
    const sf = createSalesforce(c.env);
    const rows = await sf.query(
      `SELECT Id, ${ou.name}, ${ou.email}, ${ou.admin}, ${ou.password} FROM ${ou.sobject} ` +
      `WHERE ${ou.access} = true AND ${ou.active} = true ORDER BY ${ou.name}`
    );
    return c.json({ users: rows.map((u) => ({
      id: u.Id, name: u[ou.name], email: u[ou.email],
      isAdmin: u[ou.admin] === true, password: u[ou.password] ?? '',
    })) });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

// Admin-only: set another user's password and/or role. Blank password resets to
// the default. Demoting an admin is blocked if they'd be the last one.
api.patch('/auth/office-users/:id', async (c) => {
  try {
    const me = await getOfficeUser(c);
    if (!me?.isAdmin) return c.json({ error: 'Admin only' }, 403);
    const id = c.req.param('id');
    const body = await c.req.json();
    const sf = createSalesforce(c.env);
    const fields = {};
    if ('password' in body) fields[ou.password] = body.password ? String(body.password) : null;
    if ('isAdmin' in body) {
      if (body.isAdmin === false) {
        const admins = await sf.query(
          `SELECT COUNT(Id) c FROM ${ou.sobject} WHERE ${ou.admin} = true AND ${ou.active} = true AND ${ou.access} = true`
        );
        if ((admins[0]?.c ?? 0) <= 1) return c.json({ error: 'Cannot remove the last admin' }, 400);
      }
      fields[ou.admin] = !!body.isAdmin;
    }
    if (Object.keys(fields).length === 0) return c.json({ error: 'Nothing to update' }, 400);
    await sf.updateRecord('User', id, fields);
    return c.json({ ok: true });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

// ---- Usage analytics (D1: USAGE_DB) ----
// Best-effort event ingest from the dispatch frontend. Never breaks the UI:
// any failure (incl. USAGE_DB unbound) returns ok:false silently.
api.post('/track', async (c) => {
  try {
    const db = c.env.USAGE_DB;
    if (!db) return c.json({ ok: false });
    const me = await getOfficeUser(c);
    const { event, screen, props } = await c.req.json();
    if (!event) return c.json({ ok: false });
    await db.prepare('INSERT INTO usage_events (ts, app, actor, event, screen, props) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(Date.now(), 'dispatch', me?.name ?? 'office', String(event), screen ? String(screen) : null, props ? JSON.stringify(props) : null)
      .run();
    return c.json({ ok: true });
  } catch { return c.json({ ok: false }); }
});

const usageDays = (c) => Math.min(365, Math.max(1, parseInt(c.req.query('days') || '30', 10)));

// Admin-only dashboard aggregates (board + dispatch).
api.get('/usage', async (c) => {
  try {
    const me = await getOfficeUser(c);
    if (!me?.isAdmin) return c.json({ error: 'Admin only' }, 403);
    const db = c.env.USAGE_DB;
    if (!db) return c.json({ error: 'Usage DB not configured' }, 500);
    const days = usageDays(c);
    const since = Date.now() - days * 86400000;
    // Optional app filter (board / dispatch) applied to every aggregate.
    const app = c.req.query('app');
    const appClause = (app === 'board' || app === 'dispatch') ? ' AND app = ?' : '';
    const binds = appClause ? [since, app] : [since];
    const q = (sql) => db.prepare(sql).bind(...binds).all().then((r) => r.results ?? []);
    const [eventsByDay, activeByDay, byEvent, byUser, byApp, byHour, byScreen, totals] = await Promise.all([
      q(`SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') d, COUNT(*) c FROM usage_events WHERE ts>=?${appClause} GROUP BY d ORDER BY d`),
      q(`SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') d, COUNT(DISTINCT actor) c FROM usage_events WHERE ts>=?${appClause} GROUP BY d ORDER BY d`),
      q(`SELECT event, COUNT(*) c FROM usage_events WHERE ts>=?${appClause} GROUP BY event ORDER BY c DESC`),
      q(`SELECT actor, app, COUNT(*) c, MAX(ts) last FROM usage_events WHERE ts>=?${appClause} GROUP BY actor, app ORDER BY c DESC`),
      q(`SELECT app, COUNT(*) c FROM usage_events WHERE ts>=?${appClause} GROUP BY app`),
      q(`SELECT strftime('%H', ts/1000, 'unixepoch') h, COUNT(*) c FROM usage_events WHERE ts>=?${appClause} GROUP BY h ORDER BY h`),
      q(`SELECT screen, COUNT(*) c FROM usage_events WHERE ts>=?${appClause} AND screen IS NOT NULL GROUP BY screen ORDER BY c DESC`),
      q(`SELECT COUNT(DISTINCT actor) users, COUNT(*) events, SUM(CASE WHEN event='login' THEN 1 ELSE 0 END) logins FROM usage_events WHERE ts>=?${appClause}`),
    ]);
    return c.json({ days, app: app || 'all', eventsByDay, activeByDay, byEvent, byUser, byApp, byHour, byScreen, totals: totals[0] ?? { users: 0, events: 0, logins: 0 } });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

// Chronological activity feed (admin). Newest first; optional actor/app filters.
api.get('/usage/recent', async (c) => {
  try {
    const me = await getOfficeUser(c);
    if (!me?.isAdmin) return c.json({ error: 'Admin only' }, 403);
    const db = c.env.USAGE_DB;
    if (!db) return c.json({ error: 'Usage DB not configured' }, 500);
    const days = usageDays(c);
    const since = Date.now() - days * 86400000;
    const limit = Math.min(500, Math.max(1, parseInt(c.req.query('limit') || '100', 10)));
    const actor = c.req.query('actor');
    const app = c.req.query('app');
    let where = 'ts>=?';
    const binds = [since];
    if (actor) { where += ' AND actor=?'; binds.push(actor); }
    if (app === 'board' || app === 'dispatch') { where += ' AND app=?'; binds.push(app); }
    const rows = await db.prepare(`SELECT ts, app, actor, event, screen FROM usage_events WHERE ${where} ORDER BY ts DESC LIMIT ${limit}`).bind(...binds).all().then((r) => r.results ?? []);
    return c.json({ events: rows });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

// Picker list for the per-user drill-down: all active Technicians + all active
// Users (so a zero-activity person is still selectable).
api.get('/usage/people', async (c) => {
  try {
    const me = await getOfficeUser(c);
    if (!me?.isAdmin) return c.json({ error: 'Admin only' }, 403);
    const sf = createSalesforce(c.env);
    const [techs, users] = await Promise.all([
      getAllTechnicians(c.env, false),
      sf.query(`SELECT ${ou.name} FROM ${ou.sobject} WHERE ${ou.active} = true ORDER BY ${ou.name}`),
    ]);
    return c.json({ people: [
      ...techs.map((t) => ({ name: t.name, kind: 'tech' })),
      ...users.map((u) => ({ name: u[ou.name], kind: 'office' })),
    ] });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

// One person's usage (matched on actor name across both apps).
api.get('/usage/user', async (c) => {
  try {
    const me = await getOfficeUser(c);
    if (!me?.isAdmin) return c.json({ error: 'Admin only' }, 403);
    const db = c.env.USAGE_DB;
    if (!db) return c.json({ error: 'Usage DB not configured' }, 500);
    const actor = c.req.query('actor');
    if (!actor) return c.json({ error: 'actor required' }, 400);
    const days = usageDays(c);
    const since = Date.now() - days * 86400000;
    const q = (sql) => db.prepare(sql).bind(actor, since).all().then((r) => r.results ?? []);
    const [eventsByDay, byEvent, byApp, byScreen, activeDays, recent, totals] = await Promise.all([
      q(`SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') d, COUNT(*) c FROM usage_events WHERE actor=? AND ts>=? GROUP BY d ORDER BY d`),
      q(`SELECT event, COUNT(*) c FROM usage_events WHERE actor=? AND ts>=? GROUP BY event ORDER BY c DESC`),
      q(`SELECT app, COUNT(*) c FROM usage_events WHERE actor=? AND ts>=? GROUP BY app`),
      q(`SELECT screen, COUNT(*) c FROM usage_events WHERE actor=? AND ts>=? AND screen IS NOT NULL GROUP BY screen ORDER BY c DESC`),
      q(`SELECT COUNT(DISTINCT strftime('%Y-%m-%d', ts/1000, 'unixepoch')) d FROM usage_events WHERE actor=? AND ts>=?`),
      db.prepare(`SELECT ts, app, event, screen FROM usage_events WHERE actor=? AND ts>=? ORDER BY ts DESC LIMIT 50`).bind(actor, since).all().then((r) => r.results ?? []),
      q(`SELECT COUNT(*) events, MIN(ts) first, MAX(ts) last FROM usage_events WHERE actor=? AND ts>=?`),
    ]);
    return c.json({
      actor, days, eventsByDay, byEvent, byApp, byScreen, recent,
      activeDays: activeDays[0]?.d ?? 0,
      totals: totals[0] ?? { events: 0, first: null, last: null },
    });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

api.get('/jobs', async (c) => {
  try {
    const statusParam = c.req.query('status');
    if (!statusParam) return c.json(await getAllJobs(c.env));

    const sf = createSalesforce(c.env);

    const soql = `
      SELECT Id, ${f.oppName}, ${f.oppLid}, ${JOB_STATUS_SELECT}, ${f.oppScheduledDate},
             ${f.oppFsTaskId}, ${f.oppFsStatus}, ${f.oppFsLastModified}, ${f.oppType}, CreatedDate, CloseDate,
             ${f.addrStreet}, ${f.addrCity}, ${f.addrState}, ${f.addrZip},
             (SELECT Id, ${o.assignmentTechLookup}, ${o.assignmentTechRelationship}.Name,
                     ${o.assignmentDate}, ${o.assignmentStartTime}, ${o.assignmentEndTime}, ${o.assignmentCompleted}
              FROM ${o.assignmentChildRelationship})
      FROM Opportunity
      WHERE ${boardStatusPredicate(statusParam)}
      ORDER BY ${f.oppScheduledDate} ASC NULLS LAST`;

    const records = await sf.query(soql);
    return c.json(records.map(shapeJob));
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Opportunities in the pre-scheduling quoting stage. Deliberately no
// Monitoring-type exclusion here (unlike every other Opportunity query in
// this file) -- the Quotes tab shows every type, since Job Type is itself
// one of the displayed columns.
// ?view=sent switches from the default "Needs Quote" status filter to every
// Opportunity with Sent_To_Customer__c checked, regardless of its current
// status -- the checkbox and the status are independent signals (see
// send-email route). ?view=review switches to the internal-review status.
// ?view=sent requires BOTH the status and the checkbox -- status alone could
// include an opp that was manually moved to Pending Customer Approval
// without ever going through the Sent flow (no email, no stamp); the
// checkbox alone could include one sent long ago whose status later moved
// on. Both together means "sent, and still sitting in that stage."
api.get('/jobs/quotes', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const view = c.req.query('view');
    // Each view matches a status VALUE against every record type's resolved
    // status field (Project_Status__c / Service_Status__c / Inspection_Status__c
    // / Monitoring_Status__c). Sent additionally requires the Sent_To_Customer__c
    // checkbox, same as before.
    // The sub-clause for each of the three views, reused below.
    const needsClause = quoteStatusPredicate(config.quotes.status);
    const reviewClause = quoteStatusPredicate(config.quotes.reviewStatus);
    const sentClause = `(${quoteStatusPredicate(config.quotes.sentStatus)} AND ${f.oppSentToCustomer} = true)`;
    const whereClause =
      // ?view=all is the calendar's consolidated set — the union of all three
      // segments so the calendar shows the same quotes regardless of which
      // Needs Quote / Ready for Review / Quote Sent segment is selected.
      view === 'all' ? `(${needsClause} OR ${reviewClause} OR ${sentClause})` :
      view === 'sent' ? sentClause :
      view === 'review' ? reviewClause :
      needsClause;
    const soql = `
      SELECT Id, ${f.oppName}, ${f.oppType}, ${JOB_STATUS_SELECT}, ${f.oppBidDate}, ${f.oppReviewDeadline},
             ${f.oppAccountRelationship}.Name,
             ${f.oppAccountRelationship}.${acc.fireAlarmMfr}, ${f.oppAccountRelationship}.${acc.accessControlMfr},
             ${f.oppAccountRelationship}.${acc.cctvMfr}, ${f.oppAccountRelationship}.${acc.intrusionMfr},
             ${f.oppSentToCustomer}, ${f.oppReadyForReview}, CreatedDate
      FROM Opportunity
      WHERE ${whereClause}
      ORDER BY ${f.oppBidDate} ASC NULLS LAST`;

    const records = await sf.query(soql);
    return c.json(records.map(shapeQuote));
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Salesforce Files linked to a quote's Opportunity (ContentDocumentLink),
// shown as an active-link dropdown on the Quotes tab.
api.get('/jobs/quotes/:id/documents', async (c) => {
  try {
    const id = c.req.param('id');
    const sf = createSalesforce(c.env);
    const soql = `
      SELECT ContentDocumentId, ContentDocument.Title, ContentDocument.FileExtension,
             ContentDocument.LastModifiedDate
      FROM ContentDocumentLink
      WHERE LinkedEntityId = '${esc(id)}'`;

    const [records, instanceUrl] = await Promise.all([sf.query(soql), sf.getInstanceUrl()]);
    return c.json(records.map((r) => shapeQuoteDocument(r, instanceUrl)));
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Active Salesforce Users, for the Quotes tab's "Sent" recipient picker.
// Fetched once and filtered client-side, same lazy-load convention as
// getContacts/getAccounts -- no separate ?q= search endpoint needed at this
// org's User-table size.
api.get('/users', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const records = await sf.query('SELECT Id, Name, Email FROM User WHERE IsActive = true ORDER BY Name ASC');
    return c.json(
      records
        .filter((r) => r.Email)
        .map((r) => ({ id: r.Id, name: r.Name, email: r.Email }))
    );
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Notifies the picked recipients that a quote was sent to the customer.
// Status is changed separately via the normal PATCH /jobs/:id write-through
// (same path the Jobs board uses) -- but the frontend (App.jsx's sendQuote)
// deliberately calls THIS route first and only fires the status PATCH if it
// succeeds, so a failed send never leaves a quote's status looking like it
// went to the customer when it didn't. This route itself only ever touches
// Sent_To_Customer__c, never Project_Status__c.
api.post('/jobs/quotes/:id/send-email', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const recipients = Array.isArray(body.recipients) ? body.recipients.filter(Boolean) : [];
    if (recipients.length === 0) return c.json({ error: 'No recipients selected' }, 400);

    const sf = createSalesforce(c.env);
    const existing = await sf.query(`SELECT ${f.oppName} FROM Opportunity WHERE Id = '${esc(id)}' LIMIT 1`);
    const quoteName = existing?.[0]?.[f.oppName] ?? 'this opportunity';

    const result = await sendQuoteNotification(sf, id, recipients, {
      subject: `Quote sent for approval: ${quoteName}`,
      html: `
        <div style="font-family: Arial, sans-serif; font-size: 14px; color: #1a1a1a;">
          <h1 style="font-size: 22px; margin: 0 0 16px;">Quote Sent to Customer</h1>
          <p style="margin: 0 0 8px;"><strong>${quoteName}</strong> has been sent to the customer and is now marked <strong>Pending Customer Approval</strong> in Salesforce.</p>
        </div>`,
      stampField: f.oppSentToCustomer,
    });
    return c.json(result);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Same shape as send-email above, for the earlier "ready for internal
// review" stage -- stamps Ready_For_Review__c instead, and the frontend
// (App.jsx's reviewQuote) gates the Project_Status__c -> "Needs Quote
// Review" PATCH on this succeeding the same way.
api.post('/jobs/quotes/:id/send-review-email', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json();
    const recipients = Array.isArray(body.recipients) ? body.recipients.filter(Boolean) : [];
    if (recipients.length === 0) return c.json({ error: 'No recipients selected' }, 400);

    const sf = createSalesforce(c.env);
    const existing = await sf.query(`SELECT ${f.oppName} FROM Opportunity WHERE Id = '${esc(id)}' LIMIT 1`);
    const quoteName = existing?.[0]?.[f.oppName] ?? 'this opportunity';

    const result = await sendQuoteNotification(sf, id, recipients, {
      subject: `${quoteName} is ready for review`,
      html: `
        <div style="font-family: Arial, sans-serif; font-size: 14px; color: #1a1a1a;">
          <h1 style="font-size: 22px; margin: 0 0 16px;">Ready for Review</h1>
          <p style="margin: 0 0 8px;"><strong>${quoteName}</strong> is ready for review.</p>
        </div>`,
      stampField: f.oppReadyForReview,
    });
    return c.json(result);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

api.get('/technicians', async (c) => {
  try {
    const includeInactive = c.req.query('all') === '1';
    return c.json(await getAllTechnicians(c.env, includeInactive));
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Add a technician from the board UI — Name is required, FS user ID and
// color are optional (a tech with no FS ID just doesn't sync to Field
// Squared; a tech with no color falls back to /tv's hash-based color).
api.post('/technicians', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const { name, fsUserId, color } = await c.req.json();
    if (!name || !name.trim()) return c.json({ error: 'name required' }, 400);
    if (color && !HEX_COLOR_RE.test(color)) return c.json({ error: 'color must be a hex value like #2563EB' }, 400);

    const fields = { Name: name.trim(), [o.technicianActive]: true };
    if (fsUserId && fsUserId.trim()) fields[o.technicianFsUserId] = fsUserId.trim();
    if (color) fields[o.technicianColor] = color;

    const result = await sf.createRecord(o.technician, fields);
    invalidateTechDirectory();
    await notifyTv(c.env, 'tech-added');
    return c.json({ id: result?.id, name: name.trim(), fsUserId: fsUserId || null, color: color || null, active: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Manage Techs panel: edit name/FS account/color, or soft-delete (Active__c
// = false) -- never a hard SF delete, since Job_Assignment__c and
// Schedule_Request__c both hold lookups to Technician__c, and GET
// /technicians already filters on Active__c = true everywhere else.
api.patch('/technicians/:id', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const id = c.req.param('id');
    const body = await c.req.json();

    if ('color' in body && body.color && !HEX_COLOR_RE.test(body.color)) {
      return c.json({ error: 'color must be a hex value like #2563EB' }, 400);
    }

    const fields = {};
    if ('name' in body) {
      if (!body.name || !body.name.trim()) return c.json({ error: 'name cannot be blank' }, 400);
      fields.Name = body.name.trim();
    }
    if ('fsUserId' in body) fields[o.technicianFsUserId] = body.fsUserId ? body.fsUserId.trim() : null;
    if ('color' in body) fields[o.technicianColor] = body.color || null;
    if ('active' in body) fields[o.technicianActive] = !!body.active;
    // Chalkboard login password (plaintext by design — see config). Empty string
    // clears it, so the tech falls back to DEFAULT_TECH_PASSWORD.
    if ('password' in body) fields[o.technicianPassword] = body.password ? String(body.password) : null;
    if (Object.keys(fields).length === 0) return c.json({ error: 'Nothing to update' }, 400);

    await sf.updateRecord(o.technician, id, fields);
    invalidateTechDirectory();
    await notifyTv(c.env, 'tech-updated');
    return c.json({ ok: true });
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

    return c.json(await getTimeOffRange(c.env, start, end));
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
    await notifyTv(c.env, 'time-off-added');
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

    // Only scheduledDate + status are writable through this route.
    const wantsStatus = 'status' in body;
    const wantsDate = 'scheduledDate' in body;
    if (!wantsStatus && !wantsDate) {
      return c.json({ error: 'No writable fields in request' }, 400);
    }

    // Pre-fetch current opp: needed for the record-type status-field resolution,
    // the scheduledDate crew-release check, and the FS write-through. The status
    // field a dispatcher's change lands in depends on the record type
    // (Project_Status__c for legacy/Job/Work_Order, Service_Status__c for
    // Service Call, StageName for Test & Inspection).
    let previousSfStatus = null;
    let fsTaskId = null;
    let shouldReleaseCrew = false;
    let oppName = '';
    let recordType = null;
    {
      const existing = await sf.query(
        `SELECT ${f.oppName}, ${f.oppScheduledDate}, RecordType.DeveloperName,
                ${allStatusFields().join(', ')}, ${f.oppFsTaskId}
         FROM Opportunity WHERE Id = '${esc(id)}' LIMIT 1`
      );
      const cur = existing?.[0];
      oppName = cur?.[f.oppName] ?? '';
      recordType = cur?.RecordType?.DeveloperName ?? null;
      if (wantsDate) {
        const curVal = cur?.[f.oppScheduledDate] ?? null;
        const newVal = body.scheduledDate === '' ? null : body.scheduledDate;
        if (curVal !== newVal) shouldReleaseCrew = true;
      }
      if (wantsStatus) previousSfStatus = cur?.[statusFieldForType(recordType)] ?? null;
      fsTaskId = cur?.[f.oppFsTaskId] ?? null;
    }

    const payload = {};
    if (wantsDate) payload[f.oppScheduledDate] = body.scheduledDate === '' ? null : body.scheduledDate;
    if (wantsStatus) {
      payload[statusFieldForType(recordType)] = body.status === '' ? null : body.status;
      // Quote-lifecycle transitions co-write StageName to keep the SF sales
      // pipeline in sync (Needs Quote→Proposal/Price Quote, Ready for Review→
      // Ready For Review, Pending Customer Approval→Negotiation/Review). Returns
      // null for non-quote statuses and for Service Call (stays Open Service/*).
      const stage = stageForQuoteStatus(recordType, body.status);
      if (stage) payload.StageName = stage;
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
    // Surfaced in the response so the client can patch its own local
    // fsStatus/fsLastModified immediately instead of showing the pre-push
    // value until its next full board reload.
    let fsStampedStatus = null;
    let fsStampedLastModified = null;

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
          let assignEndTime = null;
          if (body.scheduledDate) {
            try {
              const asgn = await sf.query(
                `SELECT ${o.assignmentStartTime}, ${o.assignmentEndTime} FROM ${o.assignment}
                 WHERE ${o.assignmentOppLookup} = '${esc(id)}'
                   AND ${o.assignmentCompleted} = false
                   AND ${o.assignmentDate} != null
                 ORDER BY ${o.assignmentDate} ASC NULLS LAST LIMIT 1`
              );
              if (asgn[0]?.[o.assignmentStartTime]) assignTime = asgn[0][o.assignmentStartTime];
              if (asgn[0]?.[o.assignmentEndTime]) assignEndTime = normTime(asgn[0][o.assignmentEndTime]);
            } catch (_) {}
          }
          const task = await fs.getTask(fsTaskId);
          const sched = body.scheduledDate
            ? buildFsSchedules(task, body.scheduledDate, assignTime, assignEndTime)
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
          fsStampedStatus = fsStatus;
          fsStampedLastModified = new Date().toISOString();
          await sf.updateRecord('Opportunity', id, {
            [f.oppFsStatus]: fsStampedStatus,
            [f.oppFsLastModified]: fsStampedLastModified,
          });
        }
      } catch (fsErr) {
        console.error('[routes] FS write failed (SF kept):', fsErr.message);
        fsError = fsErr.message;
      }
    }

    await notifyTv(c.env, 'job-updated');
    return c.json({ ok: true, fsUpdated, fsError, fsStatus: fsStampedStatus, fsLastModified: fsStampedLastModified });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

api.post('/jobs/:oppId/assignments', async (c) => {
  try {
    const oppId = c.req.param('oppId');
    const { technicianId, workDate, startTime, endTime, status, scheduledDate, deriveScheduledDate } = await c.req.json();
    if (!technicianId) return c.json({ error: 'technicianId required' }, 400);
    // Required for real job assignments (unlike time off / schedule-request
    // approvals, which call createAssignment directly and keep endTime
    // optional) — an end time is what lets the FS Schedule sync below carry
    // a real duration instead of the old hardcoded start+1hr placeholder.
    if (!endTime) return c.json({ error: 'endTime required' }, 400);

    const result = await createAssignment(c.env, oppId, {
      technicianId, workDate, startTime, endTime, status, scheduledDate, deriveScheduledDate,
    });
    await notifyTv(c.env, 'assignment-added');
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
    if ('endTime' in body) fields[o.assignmentEndTime] = toSfTime(body.endTime || null);
    if (Object.keys(fields).length === 0) return c.json({ error: 'Nothing to update' }, 400);

    // Pre-fetch assignment context before updating so we have the parent opp + current values
    // needed to sync schedule changes to FS, plus the tech name for the live-push notify below.
    let oppId = null;
    let workDateForFs = null;
    let startTimeForFs = null;
    let endTimeForFs = null;
    let techName = null;
    const needsFsSync = 'workDate' in body || 'startTime' in body || 'endTime' in body;
    try {
      const rows = await sf.query(
        `SELECT ${o.assignmentOppLookup}, ${o.assignmentDate}, ${o.assignmentStartTime}, ${o.assignmentEndTime}, ${o.assignmentTechRelationship}.Name
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
          endTimeForFs = 'endTime' in body
            ? (body.endTime || null)
            : normTime(rows[0][o.assignmentEndTime]);
        }
      }
    } catch (e) {
      console.warn('[routes] Could not pre-fetch assignment for FS sync:', e.message);
    }

    await sf.updateRecord(o.assignment, id, fields);
    await notifyTech(c.env, techName, 'assignment-updated');
    await notifyTv(c.env, 'assignment-updated');

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
            sched = buildFsSchedules(task, workDateForFs, startTimeForFs, endTimeForFs);
          } else {
            // workDate was cleared — SF update already committed (null date), so just
            // query all assignments; the date filter below drops this one naturally.
            const remaining = await sf.query(
              `SELECT ${o.assignmentDate}, ${o.assignmentStartTime}, ${o.assignmentEndTime}, ${o.assignmentCompleted}
               FROM ${o.assignment} WHERE ${o.assignmentOppLookup} = '${esc(oppId)}'`
            );
            const next = remaining
              .filter(a => a[o.assignmentDate] && !a[o.assignmentCompleted])
              .sort((a, b) => {
                const d = String(a[o.assignmentDate]).localeCompare(String(b[o.assignmentDate]));
                return d !== 0 ? d : (normTime(a[o.assignmentStartTime]) || '').localeCompare(normTime(b[o.assignmentStartTime]) || '');
              })[0];
            sched = next
              ? buildFsSchedules(task, next[o.assignmentDate], normTime(next[o.assignmentStartTime]) || '08:00', normTime(next[o.assignmentEndTime]))
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
    await notifyTv(c.env, 'assignment-removed');

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
            `SELECT ${o.assignmentDate}, ${o.assignmentStartTime}, ${o.assignmentEndTime}, ${o.assignmentCompleted},
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
            patch.Schedules = buildFsSchedules(task, next[o.assignmentDate], time, normTime(next[o.assignmentEndTime]));
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
    const { contactId, field } = await c.req.json();
    if (!contactId) return c.json({ error: 'contactId required' }, 400);

    const fieldMap = { property: acc.propertyContact, apManagement: acc.apContact, apLid: acc.apContactLid };
    const sfField = fieldMap[field ?? 'property'];
    if (!sfField) return c.json({ error: 'Invalid field' }, 400);

    await sf.updateRecord('Account', id, { [sfField]: contactId });

    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

api.patch('/accounts/:id', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const id = c.req.param('id');
    const body = await c.req.json();

    const fields = {};
    if ('industry' in body) fields[acc.industry] = body.industry || null;
    if ('phone' in body) fields[acc.phone] = body.phone || null;
    if ('website' in body) fields[acc.website] = body.website || null;
    if ('street' in body) fields[acc.street] = body.street || null;
    if ('city' in body) fields[acc.city] = body.city || null;
    if ('state' in body) fields[acc.state] = body.state || null;
    if ('zip' in body) fields[acc.zip] = body.zip || null;

    if (Object.keys(fields).length === 0) return c.json({ error: 'Nothing to update' }, 400);
    await sf.updateRecord('Account', id, fields);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

api.get('/accounts', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const [accountRecords, contactRecords, billingRecords] = await Promise.all([
      sf.query(`SELECT Id, Name, ${acc.lid}, ${acc.type}, ${acc.industry}, ${acc.phone}, ${acc.website},
                       ${acc.street}, ${acc.city}, ${acc.state}, ${acc.zip},
                       ${acc.propertyContact}, ${acc.apContact}, ${acc.apContactLid},
                       ${acc.parent}, Parent.Name, RecordType.DeveloperName, LastModifiedDate
                FROM Account ORDER BY Name`),
      sf.query(`SELECT Id, Name FROM Contact`),
      sf.query(`SELECT Id, ${f.oppName}, ${f.oppLid}, ${f.oppStatus}
                FROM Opportunity
                WHERE ${f.oppStatus} IN ('Waiting on Payment', 'Installation Completed')
                AND ${f.oppLid} != null
                AND CloseDate >= 2025-01-01
                AND (${f.oppType} != 'Monitoring' OR ${f.oppType} = null)`),
    ]);

    const contactNameById = new Map(contactRecords.map((r) => [r.Id, r.Name]));

    // Invoice records live on Invoicing__c (Job__c looks up to the
    // Opportunity) — a Job can have more than one, so keep the full set per
    // Job (not just the latest) for the Overdue / Ready to Bill popups.
    const billingJobIds = billingRecords.map((r) => r.Id);
    const invoicesByOppId = new Map();
    if (billingJobIds.length > 0) {
      const idList = billingJobIds.map((id) => `'${id}'`).join(',');
      const invoiceRecords = await sf.query(
        `SELECT Id, Name, ${inv.job}, ${inv.date}, ${inv.amount}, ${inv.status}, ${inv.totalInvoice},
                ${inv.nextExpectedPayment}, ${inv.arAccount}, ${inv.arNumber}, ${inv.percentOfProject}, ${inv.billingType}
         FROM ${inv.sobject} WHERE ${inv.job} IN (${idList})`
      );
      for (const r of invoiceRecords) {
        const jobId = r[inv.job];
        const list = invoicesByOppId.get(jobId) ?? [];
        list.push({
          id: r.Id,
          number: r.Name,
          date: r[inv.date] ?? null,
          amount: r[inv.amount] ?? null,
          status: r[inv.status] ?? null,
          totalInvoice: r[inv.totalInvoice] ?? null,
          nextExpectedPaymentDate: r[inv.nextExpectedPayment] ?? null,
          arAccount: r[inv.arAccount] ?? null,
          arNumber: r[inv.arNumber] ?? null,
          percentOfProject: r[inv.percentOfProject] ?? null,
          billingType: r[inv.billingType] ?? null,
        });
        invoicesByOppId.set(jobId, list);
      }
      // Most recent first, so the newest invoice is what's seen without scrolling.
      for (const list of invoicesByOppId.values()) list.sort((x, y) => (y.date ?? '').localeCompare(x.date ?? ''));
    }

    // LID -> { unpaid: [{id,name,invoices}], readyToBill: [...] } — LID__c,
    // not AccountId, is the join key between Opportunity and Account in this org.
    const billingByLid = new Map();
    for (const r of billingRecords) {
      const lid = r[f.oppLid];
      const entry = billingByLid.get(lid) ?? { unpaid: [], readyToBill: [] };
      const job = { id: r.Id, name: r[f.oppName], invoices: invoicesByOppId.get(r.Id) ?? [] };
      if (r[f.oppStatus] === 'Waiting on Payment') entry.unpaid.push(job);
      else entry.readyToBill.push(job);
      billingByLid.set(lid, entry);
    }

    return c.json(accountRecords.map((r) => {
      const billing = billingByLid.get(r[acc.lid]) ?? { unpaid: [], readyToBill: [] };
      // Two SF fields represent the same concept (AP contact — who invoices go
      // to), split by which kind of account they live on: apContact for
      // management/Customer accounts, apContactLid for LID/property accounts.
      // Prefer whichever matches this account's own RecordType, but fall back
      // to the other field if that one is empty — a handful of accounts only
      // have the "other" field populated (leftover from before AP_Contact__c
      // replaced AR_Contact__c), and hiding real data isn't the goal here.
      const isLidAccount = r.RecordType?.DeveloperName === 'LID_Account';
      const apContactId = (isLidAccount ? r[acc.apContactLid] : r[acc.apContact])
        ?? (isLidAccount ? r[acc.apContact] : r[acc.apContactLid])
        ?? null;
      return {
        id: r.Id,
        name: r.Name,
        lid: r[acc.lid] ?? null,
        type: r[acc.type] ?? null,
        industry: r[acc.industry] ?? null,
        phone: r[acc.phone] ?? null,
        website: r[acc.website] ?? null,
        street: r[acc.street] ?? null,
        city: r[acc.city] ?? null,
        state: r[acc.state] ?? null,
        zip: r[acc.zip] ?? null,
        parentId: r[acc.parent] ?? null,
        parentName: r.Parent?.Name ?? null,
        recordType: r.RecordType?.DeveloperName ?? null,
        propertyContactId: r[acc.propertyContact] ?? null,
        propertyContactName: contactNameById.get(r[acc.propertyContact]) ?? null,
        apContactId,
        apContactName: contactNameById.get(apContactId) ?? null,
        lastModifiedDate: r.LastModifiedDate ?? null,
        unpaidJobs: billing.unpaid,
        readyToBillJobs: billing.readyToBill,
      };
    }));
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
    if ('title' in body) fields.Title = body.title || null;
    if ('accountId' in body) fields.AccountId = body.accountId || null;

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
      accountId: r.AccountId ?? null,
      accounts: accountsByContact.get(r.Id) ?? [],
      lastModifiedDate: r.LastModifiedDate ?? null,
    })));
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Shared team notes (Dispatch_Note__c) — no per-user auth in this app, so these
// are visible/editable by anyone with board access. Optionally linked to an
// Opportunity via the lookup; Opportunity_Specific__c mirrors whether that
// lookup is set (the client drives both fields together, never independently).
api.get('/notes', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const rows = await sf.query(
      `SELECT Id, ${n.body}, ${n.opportunity}, ${n.opportunitySpecific},
              ${n.opportunityRelationship}.Name, ${n.opportunityRelationship}.${f.oppLid},
              CreatedDate, LastModifiedDate
       FROM ${n.sobject} ORDER BY LastModifiedDate DESC`
    );
    return c.json(rows.map(shapeNote));
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

api.post('/notes', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const { text, opportunityId } = await c.req.json();
    const body = (text ?? '').trim();
    if (!body) return c.json({ error: 'Note text is required' }, 400);
    const created = await sf.createRecord(n.sobject, {
      [n.body]: body,
      [n.opportunity]: opportunityId || null,
      [n.opportunitySpecific]: !!opportunityId,
    });
    return c.json({ id: created.id });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

api.patch('/notes/:id', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const id = c.req.param('id');
    const { text, opportunityId } = await c.req.json();
    const fields = {};
    if (text !== undefined) {
      const body = text.trim();
      if (!body) return c.json({ error: 'Note text is required' }, 400);
      fields[n.body] = body;
    }
    if (opportunityId !== undefined) {
      fields[n.opportunity] = opportunityId || null;
      fields[n.opportunitySpecific] = !!opportunityId;
    }
    await sf.updateRecord(n.sobject, id, fields);
    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

api.delete('/notes/:id', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    await sf.deleteRecord(n.sobject, c.req.param('id'));
    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// Manually stamp an FS task ID onto a SF opportunity, then sync user
// assignments and a status snapshot from the FS task so the board reflects
// reality (status is display-only — see comment below, no write to either side).
api.post('/jobs/:id/fs-link', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const fs = createFs(c.env);
    const id = c.req.param('id');
    const { fsTaskId } = await c.req.json();
    if (!fsTaskId) return c.json({ error: 'fsTaskId required' }, 400);

    // Stamp the link first — if anything below fails, the link is still saved.
    await sf.updateRecord('Opportunity', id, { [f.oppFsTaskId]: fsTaskId });

    const result = { assignmentsAdded: 0 };

    try {
      // Fetch opp, full FS task, existing SF assignments, and the FS↔SF tech
      // directory all in parallel so assignment count is available before we
      // decide the FS status to write.
      const [oppRows, fullTask, existingAssignments, techDir] = await Promise.all([
        sf.query(
          `SELECT ${f.oppScheduledDate} FROM Opportunity WHERE Id = '${esc(id)}' LIMIT 1`
        ),
        fs.getTask(fsTaskId),
        sf.query(`SELECT ${o.assignmentTechRelationship}.Name, ${o.assignmentStartTime}, ${o.assignmentEndTime} FROM ${o.assignment} WHERE ${o.assignmentOppLookup} = '${esc(id)}'`),
        getTechDirectory(sf),
      ]);
      const sfOpp = oppRows[0];
      if (!sfOpp) throw new Error('Opp not found');

      // Sync users: FS → SF — find techs in FS not yet in SF.
      const syncableUserIds = (Array.isArray(fullTask.Users) ? fullTask.Users : [])
        .filter(uid => uid in techDir.byFsId);

      const assignedNames = new Set(
        existingAssignments.map(a => a[o.assignmentTechRelationship]?.Name).filter(Boolean)
      );
      // "has assignments" = existing SF assignments + any we're about to add from FS
      const willHaveAssignments = existingAssignments.length > 0 || syncableUserIds.length > 0;

      // Status is display-only now — linking no longer writes Project_Status__c
      // or pushes a recency-based status to FS. The snapshot stamped above is
      // what the board's drift badge compares against; a person decides what,
      // if anything, to do about a mismatch.
      let targetFsStatus = null;

      // Scheduled + users → bump FS to "Assigned" so a newly-linked job that
      // already has techs on it doesn't sit as bare "Scheduled" in FS.
      if (fullTask.Status === 'Scheduled' && willHaveAssignments) {
        targetFsStatus = 'Assigned';
      }

      // Single FS write: status (if needed) + scheduled date from SF board.
      const fsPatch = {};
      if (targetFsStatus) fsPatch.Status = targetFsStatus;
      if (sfOpp[f.oppScheduledDate]) {
        const firstTime = existingAssignments[0]?.[o.assignmentStartTime] ?? '08:00';
        const firstEndTime = normTime(existingAssignments[0]?.[o.assignmentEndTime]);
        const sched = buildFsSchedules(fullTask, sfOpp[f.oppScheduledDate], firstTime, firstEndTime);
        if (sched) fsPatch.Schedules = sched;
      }
      if (Object.keys(fsPatch).length > 0) {
        await fs.patchTask(fsTaskId, fullTask, fsPatch);
      }

      // Stamp the raw FS status snapshot now that we know the FINAL status --
      // targetFsStatus if we just bumped it (Scheduled -> Assigned), otherwise
      // whatever FS already had. Done after the patch above (not before) so a
      // bump this same call just made is never immediately shown as stale
      // until the next fs-sync cron tick. Display-only; nothing reads this
      // to drive a status write anymore.
      await sf.updateRecord('Opportunity', id, {
        [f.oppFsStatus]: targetFsStatus ?? fullTask.Status ?? null,
        [f.oppFsLastModified]: Object.keys(fsPatch).length > 0 ? new Date().toISOString() : (fullTask.LastUpdated ?? null),
      });

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