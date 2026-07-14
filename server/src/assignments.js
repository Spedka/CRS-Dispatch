import { config } from './config.js';
import { createSalesforce } from './salesforce.js';
import { createFs } from './fieldSquared.js';
import { sfToFsStatus } from './statusMap.js';
import { notifyTech } from './notifyBoard.js';

const f = config.fields;
const o = config.objects;

export const esc = (s) => String(s).replace(/'/g, "\\'");
export const normTime = (v) => (v ? String(v).slice(0, 5) : null);
export const toSfTime = (hhmm) => (hhmm ? `${hhmm}:00.000Z` : null);

// Live FS↔SF technician directory, read from Salesforce (Technician__c +
// FS_User_Id__c) instead of a hardcoded map — this is what lets "Add Tech" in
// the board UI take effect without a code deploy. Cached per-isolate for a
// short window since it's queried on most assignment/sync operations;
// invalidateTechDirectory() clears it right after a new tech is created so
// the next call sees them immediately.
const TECH_DIR_TTL_MS = 60_000;
let techDirCache = { data: null, expires: 0 };

export async function getTechDirectory(sf) {
  const now = Date.now();
  if (techDirCache.data && now < techDirCache.expires) return techDirCache.data;

  const rows = await sf.query(
    `SELECT Id, Name, ${o.technicianFsUserId} FROM ${o.technician} WHERE ${o.technicianActive} = true`
  );
  const byName = {};
  const byFsId = {};
  for (const r of rows) {
    const fsUserId = r[o.technicianFsUserId] || null;
    byName[r.Name] = { sfId: r.Id, fsUserId };
    if (fsUserId) byFsId[fsUserId] = { sfId: r.Id, name: r.Name };
  }
  const data = { byName, byFsId };
  techDirCache = { data, expires: now + TECH_DIR_TTL_MS };
  return data;
}

export function invalidateTechDirectory() {
  techDirCache = { data: null, expires: 0 };
}

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
// FS ObjectIds are base64url-encoded 16-byte GUIDs (no padding).
// The web app mints these client-side; FS keys the Schedules array by ObjectId
// and rejects entries that omit it rather than auto-generating one server-side.
function fsObjectId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Pass null/empty isoDate to return null which skips the Schedules write.
export function buildFsSchedules(task, isoDate, localTime = '08:00') {
  if (!isoDate) return null;
  const start = toFsDateTime(isoDate, localTime);
  const h = parseInt(start.slice(11, 13), 10);
  const end = start.slice(0, 11) + String((h + 1) % 24).padStart(2, '0') + start.slice(13);
  const existing = Array.isArray(task.Schedules) ? task.Schedules[0] : null;
  const toId = (u) => (typeof u === 'string' ? u : u?.ObjectId ?? null);
  if (existing) {
    return [{
      ...(existing.ObjectId ? { ObjectId: existing.ObjectId } : {}),
      Start: start,
      End: end,
      Users: Array.isArray(existing.Users) ? existing.Users.map(toId).filter(Boolean) : [],
      Teams: existing.Teams ?? [],
      Data: existing.Data ?? {},
      TimeZone: existing.TimeZone ?? '',
    }];
  }
  // No existing schedule — mint a client-side ObjectId. FS keys the Schedules
  // array by ObjectId and rejects entries that omit it.
  return [{ ObjectId: fsObjectId(), Start: start, End: end, Users: [], Teams: [], Data: {}, TimeZone: '' }];
}

export async function createAssignment(env, oppId, {
  technicianId,
  workDate,
  startTime,
  endTime,
  status,
  scheduledDate,
  deriveScheduledDate = false,
}) {
  // Approved time off is a Job_Assignment__c against a hidden sentinel
  // Opportunity. Its Project_Status__c sits outside jobStatusValues on
  // purpose — that's what keeps it off the board. Guard here, not in each
  // caller, so nothing can rewrite the sentinel into a real board status.
  const isTimeOff = oppId === env.TIME_OFF_OPPORTUNITY_ID;
  if (isTimeOff) {
    status = null;
    scheduledDate = null;
    deriveScheduledDate = false;
  }

  const sf = createSalesforce(env);

  const fields = {
    [o.assignmentOppLookup]: oppId,
    [o.assignmentTechLookup]: technicianId,
    [o.assignmentStartTime]: toSfTime(startTime || '07:00'),
  };
  if (endTime) fields[o.assignmentEndTime] = toSfTime(endTime);
  // Time_Off__c, not the sentinel Opportunity Id, is how the tech app tells a
  // time-off assignment apart from a real job assignment.
  if (isTimeOff) fields[o.assignmentTimeOff] = true;
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

  // Caller doesn't know the job's other assignment dates — derive the earliest
  // one ourselves so a later assignment doesn't push FS's scheduled date forward.
  // The newly inserted row is included by this query, which is what we want.
  if (deriveScheduledDate && !scheduledDate) {
    const rows = await sf.query(
      `SELECT ${o.assignmentDate} FROM ${o.assignment}
       WHERE ${o.assignmentOppLookup} = '${esc(oppId)}'
         AND ${o.assignmentDate} != null`
    );
    const dates = rows.map(r => r[o.assignmentDate]).filter(Boolean).sort();
    scheduledDate = dates[0] ?? workDate ?? null;
  }

  // Sync new assignment to FS if the job has a linked FS task. The sentinel's
  // FS_Task_Id__c is always null so this would self-skip further down anyway
  // (see the fsTaskId check below), but skip explicitly here on the same
  // condition as the guard above so the intent isn't implicit.
  const fsDebug = { techName: assignmentRec?.technicianName ?? null, fsUserId: null, fsTaskId: null, patch: null, error: null };
  if (assignmentRec?.technicianName && !isTimeOff) {
    const techDir = await getTechDirectory(sf);
    const fsUserId = techDir.byName[assignmentRec.technicianName]?.fsUserId;
    fsDebug.fsUserId = fsUserId ?? `NOT IN MAP (name="${assignmentRec.technicianName}")`;
    if (fsUserId) {
      let fsTaskId = null;
      try {
        const fs = createFs(env);
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
          const fsPatch = {};
          if (!currentUserIds.includes(fsUserId)) {
            fsPatch.Users = [...currentUserIds, fsUserId];
          }
          if (status) {
            const fsStatus = sfToFsStatus(status, true); // always has assignments — just added one
            if (fsStatus) fsPatch.Status = fsStatus;
          }
          // scheduledDate = earliest assignment date (derived by client); use it
          // rather than workDate so adding a later assignment doesn't move FS forward.
          const assignDate = scheduledDate ?? workDate ?? opps[0]?.[f.oppScheduledDate];
          if (assignDate) {
            const sched = buildFsSchedules(task, assignDate, startTime || '08:00');
            if (sched) fsPatch.Schedules = sched;
          }
          fsDebug.patch = Object.keys(fsPatch);
          if (Object.keys(fsPatch).length > 0) {
            await fs.patchTask(fsTaskId, task, fsPatch);
          }
        }
      } catch (fsErr) {
        console.error('[routes] FS assign failed (SF kept):', fsErr.message, { fsTaskId });
        fsDebug.error = fsErr.message;
      }
    }
  }

  // Update SF Opp status/scheduledDate in the same request so the caller
  // doesn't need a separate updateJob round-trip.
  if (status != null || scheduledDate != null) {
    try {
      const oppPayload = {};
      if (status != null) oppPayload[f.oppStatus] = status || null;
      if (scheduledDate != null) oppPayload[f.oppScheduledDate] = scheduledDate === '' ? null : scheduledDate;
      if (Object.keys(oppPayload).length > 0) await sf.updateRecord('Opportunity', oppId, oppPayload);
    } catch (oppErr) {
      console.error('[routes] SF Opp update failed (assignment kept):', oppErr.message);
    }
  }

  // Single choke point for every assignment-creation caller (approve,
  // /api/jobs/:oppId/assignments, /api/time-off, fs-link) -- no need to
  // duplicate this call at each site.
  await notifyTech(env, assignmentRec?.technicianName, 'assignment');

  return { assignmentId: createdId, assignment: assignmentRec, fsDebug };
}
