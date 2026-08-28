import { Hono } from 'hono';
import { config, statusFieldForType, allStatusFields, stageForQuoteStatus } from './config.js';
import { createSalesforce } from './salesforce.js';
import { createFs } from './fieldSquared.js';
import { createQbo } from './quickbooks.js';
import { sfToFsStatus } from './statusMap.js';
import { runFsSync } from './fsSync.js';
import { createAssignment, esc, normTime, toSfTime, buildFsSchedules, getTechDirectory, invalidateTechDirectory } from './assignments.js';
import { scheduleRequests } from './scheduleRequests.js';
import { parts } from './parts.js';
import { purchaseOrders } from './purchaseOrders.js';
import { invoices } from './invoices.js';
import { jobCost, isJobType, isServiceType } from './jobCost.js';
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
// Service_Call matches on Service_Status__c, Test_Inspection on StageName -
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
    // Raw FS status snapshot - written only by the FS sync path (fsSync.js,
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
api.route('/', purchaseOrders);
api.route('/', invoices);
api.route('/', jobCost);

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

// Whoami - lets the frontend refresh name/role/email on load.
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

// Actors hidden from the usage DASHBOARDS (still ingested to D1 - nothing is
// dropped, so this is reversible). Keeps a heavy in-app developer/admin from
// dominating the analytics. Matched on the exact `actor` name; add more here.
const EXCLUDED_ACTORS = ['Leo Sokolyuk'];
const exclusionClause = () => EXCLUDED_ACTORS.length ? ` AND actor NOT IN (${EXCLUDED_ACTORS.map(() => '?').join(',')})` : '';

const usageDays = (c) => Math.min(365, Math.max(1, parseInt(c.req.query('days') || '30', 10)));

// screen_view_end is a synthetic bookkeeping event (paired with screen_view,
// carrying only a duration) -- not a real distinct action a person took, so
// it's excluded from every general count/feed/breakdown to avoid double-
// counting each screen view as two events. The one place it's deliberately
// still visible is the byScreen queries below, which read it on purpose to
// compute average time-on-screen. No bind params, so safe to splice into any
// query string alongside appClause/exclClause without touching `binds`.
const NO_DURATION_MARKER_CLAUSE = " AND event != 'screen_view_end'";

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
    const exclClause = exclusionClause();
    const binds = appClause ? [since, app] : [since];
    binds.push(...EXCLUDED_ACTORS);
    const q = (sql) => db.prepare(sql).bind(...binds).all().then((r) => r.results ?? []);
    const [eventsByDay, activeByDay, byEvent, byUser, byApp, byHour, byScreen, totals] = await Promise.all([
      q(`SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') d, COUNT(*) c FROM usage_events WHERE ts>=?${appClause}${exclClause}${NO_DURATION_MARKER_CLAUSE} GROUP BY d ORDER BY d`),
      q(`SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') d, COUNT(DISTINCT actor) c FROM usage_events WHERE ts>=?${appClause}${exclClause}${NO_DURATION_MARKER_CLAUSE} GROUP BY d ORDER BY d`),
      q(`SELECT event, COUNT(*) c FROM usage_events WHERE ts>=?${appClause}${exclClause}${NO_DURATION_MARKER_CLAUSE} GROUP BY event ORDER BY c DESC`),
      q(`SELECT actor, app, COUNT(*) c, MAX(ts) last FROM usage_events WHERE ts>=?${appClause}${exclClause}${NO_DURATION_MARKER_CLAUSE} GROUP BY actor, app ORDER BY c DESC`),
      q(`SELECT app, COUNT(*) c FROM usage_events WHERE ts>=?${appClause}${exclClause}${NO_DURATION_MARKER_CLAUSE} GROUP BY app`),
      q(`SELECT strftime('%H', ts/1000, 'unixepoch') h, COUNT(*) c FROM usage_events WHERE ts>=?${appClause}${exclClause}${NO_DURATION_MARKER_CLAUSE} GROUP BY h ORDER BY h`),
      // Avg duration comes from the sibling screen_view_end events (same
      // `screen`, `props.durationMs`) -- one query, not a second round trip.
      // D1/SQLite's json_extract pulls the number straight out of the
      // stored JSON props blob.
      q(`SELECT screen,
                SUM(CASE WHEN event='screen_view' THEN 1 ELSE 0 END) c,
                AVG(CASE WHEN event='screen_view_end' THEN CAST(json_extract(props,'$.durationMs') AS REAL) END) avgMs
         FROM usage_events WHERE ts>=?${appClause}${exclClause} AND screen IS NOT NULL GROUP BY screen ORDER BY c DESC`),
      q(`SELECT COUNT(DISTINCT actor) users, COUNT(*) events, SUM(CASE WHEN event='login' THEN 1 ELSE 0 END) logins FROM usage_events WHERE ts>=?${appClause}${exclClause}${NO_DURATION_MARKER_CLAUSE}`),
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
    if (actor) { where += ' AND actor=?'; binds.push(actor); } // explicit drill-down wins - no exclusion
    else { where += exclusionClause(); binds.push(...EXCLUDED_ACTORS); }
    if (app === 'board' || app === 'dispatch') { where += ' AND app=?'; binds.push(app); }
    // screen_view_end is deliberately NOT excluded here (unlike every other
    // aggregate above) -- per direction 2026-08-27, it's what carries the
    // "viewed X for Ys" duration into the recent activity feed. `props` is
    // selected so the frontend can read durationMs back out of it.
    const rows = await db.prepare(`SELECT ts, app, actor, event, screen, props FROM usage_events WHERE ${where} ORDER BY ts DESC LIMIT ${limit}`).bind(...binds).all().then((r) => r.results ?? []);
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
      q(`SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') d, COUNT(*) c FROM usage_events WHERE actor=? AND ts>=?${NO_DURATION_MARKER_CLAUSE} GROUP BY d ORDER BY d`),
      q(`SELECT event, COUNT(*) c FROM usage_events WHERE actor=? AND ts>=?${NO_DURATION_MARKER_CLAUSE} GROUP BY event ORDER BY c DESC`),
      q(`SELECT app, COUNT(*) c FROM usage_events WHERE actor=? AND ts>=?${NO_DURATION_MARKER_CLAUSE} GROUP BY app`),
      q(`SELECT screen,
                SUM(CASE WHEN event='screen_view' THEN 1 ELSE 0 END) c,
                AVG(CASE WHEN event='screen_view_end' THEN CAST(json_extract(props,'$.durationMs') AS REAL) END) avgMs
         FROM usage_events WHERE actor=? AND ts>=? AND screen IS NOT NULL GROUP BY screen ORDER BY c DESC`),
      q(`SELECT COUNT(DISTINCT strftime('%Y-%m-%d', ts/1000, 'unixepoch')) d FROM usage_events WHERE actor=? AND ts>=?${NO_DURATION_MARKER_CLAUSE}`),
      // screen_view_end intentionally not excluded here, same reasoning as
      // /usage/recent above -- it's what carries duration into this feed.
      db.prepare(`SELECT ts, app, event, screen, props FROM usage_events WHERE actor=? AND ts>=? ORDER BY ts DESC LIMIT 50`).bind(actor, since).all().then((r) => r.results ?? []),
      q(`SELECT COUNT(*) events, MIN(ts) first, MAX(ts) last FROM usage_events WHERE actor=? AND ts>=?${NO_DURATION_MARKER_CLAUSE}`),
    ]);
    return c.json({
      actor, days, eventsByDay, byEvent, byApp, byScreen, recent,
      activeDays: activeDays[0]?.d ?? 0,
      totals: totals[0] ?? { events: 0, first: null, last: null },
    });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

// ---- Billing reconciliation (QBO ↔ SF, admin-only) ----
// Compares billed/received totals and cross-references invoice numbers between
// Salesforce Invoicing__c and QuickBooks Online over a date range (default last
// 90 days). QBO "billed" counts SENT invoices only (EmailStatus=EmailSent). The
// diff anchors each side by its own invoice date, then confirms the counterpart
// by NUMBER over a wide lookback so date skew doesn't create phantom gaps.
const DAY_MS = 86400000;
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (dateStr, n) => ymd(new Date(dateStr + 'T00:00:00Z').getTime() + n * DAY_MS);
// Normalize an invoice number for cross-system matching: uppercase, drop a leading
// "INVOICE " prefix (SF noise), remove spaces. Keeps the -M/-ML/-L suffix - SF and QBO
// share it, and it distinguishes split invoices (7848834-M is NOT 7848834-ML). Requires
// a 5+ digit run so non-invoice names don't produce a key.
const invKey = (s) => {
  const t = String(s ?? '').trim().toUpperCase().replace(/^INVOICE\s+/, '').replace(/\s+/g, '');
  return /[0-9]{5,}/.test(t) ? t : null;
};
// Normalize an SF picklist / QBO PaymentMethod name to a shared vocabulary.
function normMethod(name) {
  if (!name) return null;
  const s = String(name).toLowerCase();
  if (s.includes('e-check') || s.includes('ach') || s.includes('auto draft') || s.includes('bank')) return 'ACH';
  if (s.includes('check')) return 'Check';
  if (s.includes('visa') || s.includes('master') || s.includes('amex') || s.includes('american express') || s.includes('discover') || s.includes('debit') || s.includes('credit')) return 'Credit Card';
  if (s.includes('cash')) return 'Cash';
  return 'Other';
}

// Computes (or reuses, KV-cached) the full QBO<->SF reconciliation dataset for a
// date range. Shared by /finance/reconciliation (display) and
// /finance/qbo-id-backfill (uses the same matched pairs to backfill QBO_Id__c).
async function getReconciliationData(env, from, to, padFrom, refresh) {
  const KV = env.SF_TOKENS;
  // v6: added Id + qboId (QBO_Id__c) to the SF select and sfId/qboInvoiceId/
  // currentQboId to each matched row, for the qbo-id-backfill endpoint.
  const cacheKey = `finance_recon_v6_${from}_${to}`;
  let data = (KV && !refresh) ? await KV.get(cacheKey, 'json') : null;

  if (!data) {
      const sf = createSalesforce(env);
      const qbo = createQbo(env);
      const [sfRecvAgg, sfInvoices, qboInvoicesAll, qboPaymentsAll, pmRes, qboCustomers] = await Promise.all([
        sf.query(`SELECT SUM(${inv.paymentReceived}) total FROM ${inv.sobject} WHERE ${inv.paymentReceivedDate} >= ${from} AND ${inv.paymentReceivedDate} <= ${to}`),
        sf.query(`SELECT Id, Name, ${inv.amount}, ${inv.totalInvoice}, ${inv.paymentReceived}, ${inv.date}, ${inv.status}, ${inv.paymentMethod}, ${inv.qboId}, ${inv.qboCustomerId}, Job__r.Name, Job__r.${f.oppType}, Job__r.RecordType.DeveloperName, Job__r.Account.Name, Job__r.Account.Parent.Name FROM ${inv.sobject} WHERE ${inv.date} >= ${padFrom} AND ${inv.date} <= ${to}`),
        qbo.queryAll('Invoice', `WHERE TxnDate >= '${padFrom}'`),
        qbo.queryAll('Payment', `WHERE TxnDate >= '${padFrom}'`),
        qbo.query('SELECT * FROM PaymentMethod'),
        qbo.queryAll('Customer', ''),
      ]);

      const inWindow = (d) => d && d >= from && d <= to;
      const num = (v) => (typeof v === 'number' ? v : Number(v) || 0);
      // The real final invoice total (tax/fees included) -- Invoice_Amount__c
      // is a pre-tax subtotal (confirmed live 2026-08-28: a real invoice had
      // Invoice_Amount__c $18,022.46 vs. Total_Invoice__c $18,854.64, the
      // $832.18 gap being exactly that invoice's Sales_Tax__c). Comparing the
      // subtotal against QBO's TotalAmt (which IS tax-inclusive) understated
      // every taxed invoice's real SF amount, systematically skewing both
      // the billed total below and the sfAmt matching used for reconciliation
      // -- most matches still passed only because LINE_MATCH_MAX_REL_DIFF's
      // 20% tolerance happened to absorb typical sales-tax-sized gaps.
      // Falls back to Invoice_Amount__c when Total_Invoice__c is blank.
      const sfTotal = (r) => num(r[inv.totalInvoice] ?? r[inv.amount]);
      // Was a separate SOQL SUM() aggregate -- folded into summing sfInvoices
      // (already fetched as plain rows above) instead, since sfInvoices is
      // the row-level source of truth for the correct field anyway and this
      // avoids a second round trip.
      const sfBilledAgg = [{ total: sfInvoices.filter((r) => r[inv.status] !== 'Voided' && inWindow(r[inv.date])).reduce((s, r) => s + sfTotal(r), 0) }];

      // QBO: sent invoices only for billed + the cross-reference.
      const qboSent = qboInvoicesAll.filter((i) => i.EmailStatus === 'EmailSent');
      const qboBilled = qboSent.filter((i) => inWindow(i.TxnDate)).reduce((s, i) => s + num(i.TotalAmt), 0);
      const qboReceived = qboPaymentsAll.filter((p) => inWindow(p.TxnDate)).reduce((s, p) => s + num(p.TotalAmt), 0);

      // Payment method by QBO invoice Id (unique) - a DocNumber can repeat, an Id can't.
      const pmById = new Map((pmRes.PaymentMethod || []).map((m) => [m.Id, m.Name]));
      const methodByInvId = new Map();
      for (const p of qboPaymentsAll) {
        const nm = normMethod(p.PaymentMethodRef ? pmById.get(p.PaymentMethodRef.value) : null);
        if (!nm) continue;
        for (const ln of (p.Line || [])) for (const lt of (ln.LinkedTxn || [])) {
          if (lt.TxnType === 'Invoice') methodByInvId.set(lt.TxnId, nm);
        }
      }
      // QBO customer map for account/parent grouping.
      const custById = new Map(qboCustomers.map((cu) => [cu.Id, cu]));
      const qboParentName = (custId) => {
        const cu = custById.get(custId); if (!cu) return null;
        if (cu.ParentRef) return custById.get(cu.ParentRef.value)?.DisplayName || cu.ParentRef.name || cu.DisplayName;
        return cu.DisplayName; // top-level customer is its own parent
      };

      // Group BOTH sides by invoice number (arrays - a number can legitimately repeat;
      // QBO reuses a DocNumber for genuinely different invoices, SF has some dupes too).
      const sfByKey = new Map(), qboByKey = new Map();
      for (const r of sfInvoices) { const k = invKey(r.Name); if (!k) continue; if (!sfByKey.has(k)) sfByKey.set(k, []); sfByKey.get(k).push(r); }
      for (const i of qboSent) { const k = invKey(i.DocNumber); if (!k) continue; if (!qboByKey.has(k)) qboByKey.set(k, []); qboByKey.get(k).push(i); }

      const sfAmt = sfTotal;
      const qbAmt = (i) => num(i.TotalAmt);
      const sameDay = (r, i) => (r[inv.date] || '') === (i.TxnDate || '');
      const sameCust = (r, i) => { const a = r.Job__r?.Account?.Name, b = i.CustomerRef?.name; return a && b && String(a).toLowerCase() === String(b).toLowerCase(); };
      // Third tiebreaker, per direction 2026-08-27: how much of the real
      // Opportunity name (Job__r.Name) shows up in the QBO invoice's own
      // line-item text. Real signal, not a guess -- Create Invoice's own
      // convention stamps the Opportunity's exact Name as the invoice's
      // first (DescriptionOnly) line for every invoice this app creates
      // (invoices.js), and qbo.queryAll('Invoice', ...)'s bulk SELECT *
      // already returns each invoice's full Line[] (confirmed live
      // 2026-08-27 -- no extra per-invoice fetch needed). For older
      // invoices that predate that convention (exactly the ones this
      // backfill exists for), the job/site name often still shows up
      // somewhere in a manually-typed line description, just not
      // guaranteed as line 1 -- so this checks all lines, not just the
      // first. Word-overlap, not exact match: fraction of the Opportunity
      // name's real words (>2 chars, skips "at"/"of"/etc.) found anywhere
      // in the invoice's combined line text.
      const qboLineText = (i) => (i.Line || [])
        .map((l) => l.Description || l.SalesItemLineDetail?.ItemRef?.name || '')
        .join(' ').toLowerCase();
      const nameLineSimilarity = (r, i) => {
        const oppName = r.Job__r?.Name;
        if (!oppName) return 0;
        const lineText = qboLineText(i);
        if (!lineText) return 0;
        const tokens = oppName.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
        if (tokens.length === 0) return 0;
        const hits = tokens.filter((t) => lineText.includes(t)).length;
        return hits / tokens.length;
      };
      // Pair SF↔QBO within one number by NEAREST amount (same date/customer/
      // opp-name-in-line-text break ties). For the overwhelmingly-common
      // 1:1 case this just pairs the two records.
      const pairKey = (sfList, qboList) => {
        const sfRem = [...sfList], pairs = [], qboLeft = [];
        for (const qi of qboList) {
          if (!sfRem.length) { qboLeft.push(qi); continue; }
          let best = 0, bestScore = Infinity;
          for (let j = 0; j < sfRem.length; j++) {
            let s = Math.abs(sfAmt(sfRem[j]) - qbAmt(qi));
            if (sameDay(sfRem[j], qi)) s -= 0.001;
            if (sameCust(sfRem[j], qi)) s -= 0.001;
            s -= nameLineSimilarity(sfRem[j], qi) * 0.001;
            if (s < bestScore) { bestScore = s; best = j; }
          }
          pairs.push([sfRem[best], qi]); sfRem.splice(best, 1);
        }
        return { pairs, sfLeft: sfRem, qboLeft };
      };

      // Walk every number, pair within it, and bucket into matched / qbo-only / sf-only.
      // Report only rows whose own record is in the requested window; a pair with a
      // twin dated just outside the window still counts as matched (date-skew rescue).
      const matched = [], qboOnly = [], sfOnly = [];
      for (const k of new Set([...sfByKey.keys(), ...qboByKey.keys()])) {
        const sfList = sfByKey.get(k) || [], qboList = qboByKey.get(k) || [];
        const dup = sfList.length > 1 || qboList.length > 1; // number appears more than once
        const { pairs, sfLeft, qboLeft } = pairKey(sfList, qboList);
        for (const [sr, qi] of pairs) {
          if (!inWindow(sr[inv.date]) && !inWindow(qi.TxnDate)) continue;
          matched.push({
            number: qi.DocNumber || sr.Name, dup,
            sfAmount: sfAmt(sr), qboAmount: qbAmt(qi),
            sfReceived: num(sr[inv.paymentReceived]), qboReceived: qbAmt(qi) - num(qi.Balance),
            sfDate: sr[inv.date], qboDate: qi.TxnDate,
            sfAccount: sr.Job__r?.Account?.Name || null, sfParent: sr.Job__r?.Account?.Parent?.Name || null,
            qboAccount: qi.CustomerRef?.name || null, qboParent: qboParentName(qi.CustomerRef?.value),
            paymentMethod: methodByInvId.get(qi.Id) || normMethod(sr[inv.paymentMethod]) || null,
            sfId: sr.Id, qboInvoiceId: qi.Id, currentQboId: sr[inv.qboId] || null,
            // The real QBO Customer Id -- Invoicing__c.QBO_Customer_Id__c is
            // read by invoices.js's Create Invoice customer-suggestion
            // feature but nothing anywhere ever writes it (confirmed live
            // 2026-08-27: suggestions never populate for any job, for
            // exactly that reason). Piggybacking the write onto this same
            // matching pass -- it already has the real QBO Invoice's
            // CustomerRef in hand, no extra query needed.
            qboCustomerId: qi.CustomerRef?.value || null, currentQboCustomerId: sr[inv.qboCustomerId] || null,
            // Per direction 2026-08-27: distinguish a durably-linked row
            // (QBO_Id__c already set to this exact QBO Invoice, via the
            // qbo-id-backfill write path) from one that's only matched by
            // this page's own live amount/date heuristic every load -- the
            // heuristic can't drift a linked row into the wrong bucket, but
            // it's still worth knowing which rows are confirmed vs. inferred.
            linked: (sr[inv.qboId] || null) === qi.Id,
            // For the qbo-id-backfill line-item-similarity relaxation --
            // real Opportunity name/type/record-type, and how much of that
            // name shows up in the QBO invoice's own line text.
            oppName: sr.Job__r?.Name || null,
            oppType: sr.Job__r?.[f.oppType] || null,
            oppRecordType: sr.Job__r?.RecordType?.DeveloperName || null,
            nameLineSimilarity: nameLineSimilarity(sr, qi),
          });
        }
        for (const qi of qboLeft) if (inWindow(qi.TxnDate)) qboOnly.push({
          side: 'qbo', number: qi.DocNumber, dup, date: qi.TxnDate, amount: qbAmt(qi),
          customer: qi.CustomerRef?.name || null,
          sfAccount: null, sfParent: null,
          qboAccount: qi.CustomerRef?.name || null, qboParent: qboParentName(qi.CustomerRef?.value),
          paymentMethod: methodByInvId.get(qi.Id) || null,
        });
        for (const sr of sfLeft) if (inWindow(sr[inv.date])) sfOnly.push({
          side: 'sf', number: sr.Name, dup, date: sr[inv.date], amount: sfAmt(sr),
          customer: sr.Job__r?.Account?.Name || null,
          sfAccount: sr.Job__r?.Account?.Name || null, sfParent: sr.Job__r?.Account?.Parent?.Name || null,
          qboAccount: null, qboParent: null,
          paymentMethod: normMethod(sr[inv.paymentMethod]),
        });
      }
      const matchedCount = matched.length;

      const sfB = num(sfBilledAgg[0]?.total), sfR = num(sfRecvAgg[0]?.total);
      data = {
        range: { from, to },
        sf: { billed: sfB, received: sfR },
        qbo: { billed: qboBilled, received: qboReceived },
        deltas: { billed: qboBilled - sfB, received: qboReceived - sfR },
        diff: { matchedCount, matched, qboOnly, sfOnly },
        computedAt: new Date().toISOString(),
      };
      if (KV) await KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 1800 });
  }
  return data;
}

api.get('/finance/reconciliation', async (c) => {
  try {
    const me = await getOfficeUser(c);
    if (!me?.isAdmin) return c.json({ error: 'Admin only' }, 403);

    const to = c.req.query('to') || ymd(Date.now());
    const days = Math.min(730, Math.max(1, parseInt(c.req.query('days') || '90', 10)));
    const from = c.req.query('from') || addDays(to, -days);
    const padFrom = addDays(from, -365); // wide lookback so a differently-dated twin is still found
    const methodFilter = c.req.query('paymentMethod') || null; // groupBy is applied client-side

    let data = await getReconciliationData(c.env, from, to, padFrom, c.req.query('refresh') === '1');
    data = { ...data, range: { ...data.range, days } };

    // Payment-method filter (post-cache, so switching filters doesn't recompute).
    if (methodFilter) {
      data = { ...data, diff: {
        ...data.diff,
        matched: data.diff.matched.filter((r) => r.paymentMethod === methodFilter),
        qboOnly: data.diff.qboOnly.filter((r) => r.paymentMethod === methodFilter),
        sfOnly: data.diff.sfOnly.filter((r) => r.paymentMethod === methodFilter),
      } };
    }
    return c.json(data);
  } catch (e) { return c.json({ error: e.message }, 500); }
});

// ---- QBO_Id__c backfill (admin-only, dry-run unless ?apply=1) ----
// One-off catch-up: stamps QBO_Id__c onto already-linked Invoicing__c records that
// predate the field, reusing the exact matched pairs computed above (same invKey
// grouping + nearest-amount pairing within a reused DocNumber). A pair is
// "super confident" enough to write when sfAmount === qboAmount EXACTLY -- number
// (DocNumber) alone isn't trusted since QBO reuses it across genuinely different
// invoices (see invKey/pairKey comments), and the amount-nearest pairing used for
// display purposes above is a heuristic, not a guarantee, for those reused-number
// groups. Never overwrites an existing QBO_Id__c that disagrees with the computed
// match -- that's surfaced as a conflict for a human to look at, not auto-resolved.
const amountsEqual = (a, b) => Math.abs((a || 0) - (b || 0)) < 0.005;

// Second, weaker-evidence tier, per direction 2026-08-27: an amount
// mismatch alone doesn't mean the pairing is wrong (a partial credit,
// adjustment, or rounding on one side is real and common) -- if the QBO
// invoice's own line-item text closely matches the real Opportunity name
// (nameLineSimilarity, computed above), that's real, independent evidence
// the pairing is right even though the dollar amount isn't.
// **Restricted to Job/Service Opportunities only** -- explicitly per
// direction, T&I and Monitoring jobs at the same physical site very often
// share naming with an unrelated Job/Service Opportunity there (same
// building address embedded in both names), so a name-similarity match is a
// much weaker, riskier signal for those types -- a real invoice for the
// wrong job type at the same site could pass a loose name check. Job/Service
// Opportunities don't have that same recurring-name risk pattern, so the
// relaxation only applies there; T&I/Monitoring mismatches stay in
// amountMismatch for a human to review, same as before this tier existed.
//
// **Also requires the amounts to be within a relative tolerance, not
// unlimited** -- found live 2026-08-27 sampling real candidates before
// applying anything: name similarity alone doesn't distinguish "the right
// invoice for this job" from "any of several real invoices for this job" --
// a job billed in multiple real installments (e.g. "Truist 2nd and 3rd" had
// 5+ separate real invoices, each legitimately mentioning the same
// Opportunity name) produced sim=1.00 pairs with $2,850-$5,340 dollar gaps
// on a $380-$8,140 base -- clearly the WRONG specific invoice for that SF
// record, just a real invoice for the same underlying job. A real credit/
// rounding/tax adjustment is a small fraction of the invoice, not multiples
// of it -- 20% relative tolerance keeps the legitimate small-variance cases
// (confirmed live: real examples at 0.6%-10% look like genuine adjustments)
// while excluding the multi-invoice-confusion cases (confirmed live: the
// wrong pairings were all 270%+ off).
const LINE_MATCH_THRESHOLD = 0.75;
const LINE_MATCH_MAX_REL_DIFF = 0.20;

api.get('/finance/qbo-id-backfill', async (c) => {
  try {
    const me = await getOfficeUser(c);
    if (!me?.isAdmin) return c.json({ error: 'Admin only' }, 403);

    const to = c.req.query('to') || ymd(Date.now());
    const days = Math.min(730, Math.max(1, parseInt(c.req.query('days') || '60', 10)));
    const from = c.req.query('from') || addDays(to, -days);
    const padFrom = addDays(from, -365);
    const apply = c.req.query('apply') === '1';

    // apply=1 always forces a fresh read, never the cache -- found live
    // 2026-08-27: the 30-min KV cache means currentQboId (used to decide
    // alreadySet/candidates) never reflected writes a PRIOR apply call had
    // just made, so every subsequent call in a batched loop kept re-
    // selecting and re-writing the exact same first `writeLimit` records
    // instead of ever progressing -- remaining stayed stuck for 20+ calls
    // before this was caught. Harmless (writing the same real QBO_Id__c
    // value twice is a no-op, not data corruption), but wasted real API
    // calls and never finished. Dry runs (apply=0) still respect
    // ?refresh=1 same as before -- only an actual write forces it.
    const data = await getReconciliationData(c.env, from, to, padFrom, apply || c.req.query('refresh') === '1');

    const candidates = [], lineMatchCandidates = [], alreadySet = [], conflicts = [], amountMismatch = [], customerIdOnly = [];
    for (const m of data.diff.matched) {
      if (!m.sfId || !m.qboInvoiceId) continue; // shouldn't happen - guard anyway
      const exact = amountsEqual(m.sfAmount, m.qboAmount);
      const isJobOrService = isJobType(m.oppRecordType, m.oppType) || isServiceType(m.oppRecordType, m.oppType);
      // Explicit belt-and-suspenders exclusion, found live 2026-08-27:
      // isServiceType's own "starts with 'service'" check (built for a
      // different purpose -- Expense Tracking's list inclusion) let
      // 'Service/Monitoring' through, since it starts with "service" even
      // though it's a real hybrid Monitoring category -- exactly the
      // mislinking risk flagged per direction. Belt-and-suspenders: exclude
      // on the raw oppType/oppRecordType text containing "monitoring" or
      // "inspection" anywhere, regardless of what isJobType/isServiceType
      // otherwise say.
      const oppTypeLower = (m.oppType || '').toLowerCase();
      const isMonitoringOrInspection = oppTypeLower.includes('monitoring') || oppTypeLower.includes('inspection')
        || m.oppRecordType === 'Monitoring' || m.oppRecordType === 'Test_Inspection';
      const relDiff = Math.abs(m.sfAmount - m.qboAmount) / Math.max(Math.abs(m.sfAmount), Math.abs(m.qboAmount), 1);
      const viaLineMatch = !exact && isJobOrService && !isMonitoringOrInspection && m.nameLineSimilarity >= LINE_MATCH_THRESHOLD && relDiff <= LINE_MATCH_MAX_REL_DIFF;
      if (!exact && !viaLineMatch) { amountMismatch.push(m); continue; }
      if (m.currentQboId === m.qboInvoiceId) {
        alreadySet.push(m);
        // QBO_Id__c is already correctly linked, but per direction
        // 2026-08-27, QBO_Customer_Id__c (read by invoices.js's Create
        // Invoice customer-suggestion feature) has never been written by
        // anything, ever -- confirmed live, suggestions never populate for
        // any job. Piggyback a customer-id-only backfill onto this same
        // pass for the already-linked backlog (the vast majority of real
        // records), not just newly-linked ones below.
        if (m.qboCustomerId && m.currentQboCustomerId !== m.qboCustomerId) customerIdOnly.push(m);
        continue;
      }
      if (m.currentQboId) { conflicts.push(m); continue; } // already set to something ELSE - don't touch
      (viaLineMatch ? lineMatchCandidates : candidates).push(m);
    }

    // Batched, not one giant sequential loop -- found live 2026-08-27: a
    // single apply=1 call against the full ~3,000-candidate backlog hit a
    // real Cloudflare Workers platform ceiling ("Too many subrequests by
    // single Worker invocation") partway through, since every write is its
    // own outbound subrequest within one invocation. Nothing was corrupted
    // by that -- each write is independently try/caught, so it just stopped
    // cleanly with a real count of what succeeded before the limit hit.
    // writeLimit caps how many writes THIS call attempts (default 30, well
    // under any plausible per-invocation cap); the reconciliation data
    // itself is KV-cached for 30 min (getReconciliationData), so repeated
    // calls in the same window reuse it instead of re-querying SF/QBO --
    // only the actual writes spend fresh subrequest budget. `remaining`
    // tells the caller whether to call again.
    const writeLimit = Math.min(200, Math.max(1, parseInt(c.req.query('writeLimit') || '30', 10)));
    let applied = null;
    if (apply) {
      const sf = createSalesforce(c.env);
      // New links (QBO_Id__c + QBO_Customer_Id__c together, one update per
      // record) go first, then customer-id-only backfill for the already-
      // linked backlog -- both queues share the same writeLimit/remaining
      // budget so a caller looping this can drain both without extra logic.
      const newLinks = [...candidates, ...lineMatchCandidates].map((m) => ({
        m, fields: { [inv.qboId]: m.qboInvoiceId, ...(m.qboCustomerId ? { [inv.qboCustomerId]: m.qboCustomerId } : {}) },
      }));
      const custOnly = customerIdOnly.map((m) => ({ m, fields: { [inv.qboCustomerId]: m.qboCustomerId } }));
      const allPending = [...newLinks, ...custOnly];
      const toWrite = allPending.slice(0, writeLimit);
      applied = { succeeded: 0, failed: [], attempted: toWrite.length, remaining: Math.max(0, allPending.length - toWrite.length) };
      for (const { m, fields } of toWrite) {
        try {
          await sf.updateRecord(inv.sobject, m.sfId, fields);
          applied.succeeded++;
        } catch (e) {
          applied.failed.push({ sfId: m.sfId, number: m.number, error: e.message });
        }
      }
    }

    return c.json({
      range: { from, to, days },
      counts: {
        candidates: candidates.length,
        lineMatchCandidates: lineMatchCandidates.length,
        alreadySet: alreadySet.length,
        conflicts: conflicts.length,
        amountMismatch: amountMismatch.length,
        customerIdOnly: customerIdOnly.length,
      },
      candidates, lineMatchCandidates, conflicts, amountMismatch, customerIdOnly,
      applied,
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
      // ?view=all is the calendar's consolidated set - the union of all three
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

// Add a technician from the board UI - Name is required, FS user ID and
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
    // Chalkboard login password (plaintext by design - see config). Empty string
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
// TIME_OFF_OPPORTUNITY_ID sentinel - invisible to GET /jobs (that query filters
// Opportunity by Project_Status__c and pulls assignments as a child subquery, so
// the sentinel itself is never selected). This overlays those rows for the board.
api.get('/time-off', async (c) => {
  try {
    const start = c.req.query('start');
    const end = c.req.query('end');
    const isoDate = /^\d{4}-\d{2}-\d{2}$/;
    // Work_Date__c is a Date field - SOQL date literals are unquoted, so esc()'s
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
// - TIME_OFF_OPPORTUNITY_ID is a server-only env var, deliberately never sent
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
          // Status-only: light /api/task endpoint - no 27KB getTask round-trip needed.
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
    // optional) - an end time is what lets the FS Schedule sync below carry
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
            // workDate was cleared - SF update already committed (null date), so just
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
            patch.Schedules = [];   // no dated assignments remain - clear FS schedule
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

// Search FS tasks by name fragment - used by the manual-link UI on the board.
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

    // No matches from cache - could be a brand-new task. Fetch just today's tasks and retry.
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

// FS's active user roster - feeds the "Add Tech" picklist so the office picks
// the FS account instead of hand-typing an opaque ObjectId.
api.get('/fs-users', async (c) => {
  try {
    const fs = createFs(c.env);
    const KV = c.env.SF_TOKENS;
    const CACHE_KEY = 'fs_user_list_v1';
    const CACHE_TTL = 1800; // 30 minutes - the user roster barely changes
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
      sf.query(`SELECT Id, ${f.oppName}, ${f.oppLid}, ${f.oppStatus}, ${f.oppFsTaskId}, ${f.oppType}, RecordType.DeveloperName
                FROM Opportunity
                WHERE ${f.oppStatus} IN ('Waiting on Payment', 'Installation Completed')
                AND ${f.oppLid} != null
                AND CloseDate >= 2025-01-01
                AND (${f.oppType} != 'Monitoring' OR ${f.oppType} = null)`),
    ]);

    const contactNameById = new Map(contactRecords.map((r) => [r.Id, r.Name]));

    // Invoice records live on Invoicing__c (Job__c looks up to the
    // Opportunity) - a Job can have more than one, so keep the full set per
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

    // LID -> { unpaid: [{id,name,invoices}], readyToBill: [...] } - LID__c,
    // not AccountId, is the join key between Opportunity and Account in this org.
    const billingByLid = new Map();
    for (const r of billingRecords) {
      const lid = r[f.oppLid];
      const entry = billingByLid.get(lid) ?? { unpaid: [], readyToBill: [] };
      const job = {
        id: r.Id,
        name: r[f.oppName],
        invoices: invoicesByOppId.get(r.Id) ?? [],
        fsTaskId: r[f.oppFsTaskId] ?? null,
        opportunityType: r[f.oppType] ?? null,
        recordType: r.RecordType?.DeveloperName ?? null,
      };
      if (r[f.oppStatus] === 'Waiting on Payment') entry.unpaid.push(job);
      else entry.readyToBill.push(job);
      billingByLid.set(lid, entry);
    }

    return c.json(accountRecords.map((r) => {
      const billing = billingByLid.get(r[acc.lid]) ?? { unpaid: [], readyToBill: [] };
      // Two SF fields represent the same concept (AP contact - who invoices go
      // to), split by which kind of account they live on: apContact for
      // management/Customer accounts, apContactLid for LID/property accounts.
      // Prefer whichever matches this account's own RecordType, but fall back
      // to the other field if that one is empty - a handful of accounts only
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
    if ('mobile' in body) fields.MobilePhone = body.mobile || null;
    if ('fax' in body) fields.Fax = body.fax || null;
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
    // Property_Contact_Name__c on Account is a Contact lookup - one person can be
    // the property contact for many buildings, so we group accounts by that field.
    const [contactRecords, accountRecords] = await Promise.all([
      // MobilePhone/Fax added alongside Phone -- per direction 2026-08-28,
      // "show all numbers": confirmed live these are the only two of
      // Contact's other phone-ish fields with meaningful real fill rates
      // (MobilePhone 26%, Fax 25.5%, out of 9,078 real Contacts) --
      // HomePhone/OtherPhone/AssistantPhone are all under 1% and not worth
      // the added UI clutter.
      sf.query(`SELECT Id, FirstName, LastName, Name, Email, Phone, MobilePhone, Fax, Title,
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
      mobile: r.MobilePhone ?? null,
      fax: r.Fax ?? null,
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

// Shared team notes (Dispatch_Note__c) - no per-user auth in this app, so these
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
// reality (status is display-only - see comment below, no write to either side).
api.post('/jobs/:id/fs-link', async (c) => {
  try {
    const sf = createSalesforce(c.env);
    const fs = createFs(c.env);
    const id = c.req.param('id');
    const { fsTaskId } = await c.req.json();
    if (!fsTaskId) return c.json({ error: 'fsTaskId required' }, 400);

    // Stamp the link first - if anything below fails, the link is still saved.
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

      // Sync users: FS → SF - find techs in FS not yet in SF.
      const syncableUserIds = (Array.isArray(fullTask.Users) ? fullTask.Users : [])
        .filter(uid => uid in techDir.byFsId);

      const assignedNames = new Set(
        existingAssignments.map(a => a[o.assignmentTechRelationship]?.Name).filter(Boolean)
      );
      // "has assignments" = existing SF assignments + any we're about to add from FS
      const willHaveAssignments = existingAssignments.length > 0 || syncableUserIds.length > 0;

      // Status is display-only now - linking no longer writes Project_Status__c
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
// TEMPORARY - Field Squared Documents API exploration. REMOVE THIS ROUTE
// once the investigation is done. No persistence, no SF writes, no UI wiring.
// Uses createFs(c.env) / getToken() from fieldSquared.js - never calls
// /Authentication directly.
//
// Usage:
//   GET /api/debug/documents                     - step 1: enumerate types
//   GET /api/debug/documents?externalId=<id>      - also runs step 2 for that doc
//   GET /api/debug/documents?raw=<query string>   - passthrough for experimenting
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

    // Raw passthrough mode - skip steps 1/2 entirely.
    if (raw !== undefined) {
      return c.json({ raw: asJson(await fs.rawDocumentQuery(raw)) });
    }

    // Step 1 - enumerate document types. Try no filter plus each of the
    // four CRS-configured types; raw error bodies are returned as-is if FS
    // rejects a type name/casing.
    const candidateTypes = [null, 'Service Acknowledgement', 'Work Order', 'Test & Inspection', 'Work Order Email - 1'];
    const types = {};
    for (const t of candidateTypes) {
      types[t ?? '(no filter)'] = asJson(await fs.listDocuments(t));
    }

    const result = { types };

    // Step 2 - pull a known document's full record, if provided.
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
