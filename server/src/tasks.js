// CRS Schedule's office task/event system (Dispatch_Task__c +
// Dispatch_Task_Assignee__c) - see notes/ (or ask Claude) for the full
// design. Mounted directly in worker.js rather than chained through
// routes.js's own api.route('/', X) list, since it needs getOfficeUser/
// getAllOfficeUsers FROM routes.js - same one-directional-import reasoning
// tv.js already uses for getAllTechnicians/getAllJobs.
import { Hono } from 'hono';
import { config } from './config.js';
import { createSalesforce } from './salesforce.js';
import { esc, normTime, toSfTime } from './assignments.js';
import { getOfficeUser, getAllOfficeUsers } from './routes.js';

const dt = config.dispatchTask;
const ta = config.taskAssignee;

export const tasks = new Hono();

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const formatTaskWhen = (startDate, startTime, endDate, endTime) => {
  const range = endDate && endDate !== startDate ? `${startDate} - ${endDate}` : startDate;
  const time = startTime ? `, ${startTime}${endTime ? ` - ${endTime}` : ''}` : '';
  return `${range}${time}`;
};

function shapeAssignee(r) {
  return {
    id: r.Id,
    userId: r[ta.user],
    userName: r[ta.userRelationship]?.Name ?? null,
    responseStatus: r[ta.responseStatus],
    respondedAt: r[ta.respondedAt] ?? null,
  };
}

function shapeTask(r) {
  const assigneeRows = r[ta.taskChildRelationship]?.records ?? [];
  return {
    id: r.Id,
    name: r[dt.name],
    description: r[dt.description] ?? null,
    startDate: r[dt.startDate],
    startTime: normTime(r[dt.startTime]),
    endDate: r[dt.endDate] ?? r[dt.startDate],
    endTime: normTime(r[dt.endTime]),
    timeSensitive: r[dt.timeSensitive] === true,
    status: r[dt.status],
    opportunityId: r[dt.opportunity] ?? null,
    opportunityName: r[dt.opportunityRelationship]?.Name ?? null,
    createdById: r.CreatedById,
    createdByName: r.CreatedBy?.Name ?? null,
    assignees: assigneeRows.map(shapeAssignee),
  };
}

const SELECT_FIELDS = `Id, ${dt.name}, ${dt.description}, ${dt.startDate}, ${dt.startTime},
  ${dt.endDate}, ${dt.endTime}, ${dt.timeSensitive}, ${dt.status}, ${dt.opportunity}, ${dt.opportunityRelationship}.Name,
  CreatedById, CreatedBy.Name,
  (SELECT Id, ${ta.user}, ${ta.userRelationship}.Name, ${ta.responseStatus}, ${ta.respondedAt}
   FROM ${ta.taskChildRelationship})`;

// Best-effort: emails a fresh invite to the given user ids. Never throws -
// a failed send doesn't undo the task/assignee create, same no-rollback
// posture the FS push elsewhere in this app already uses. taskFields is the
// already-fetched {name, description, startDate, startTime, endDate,
// endTime} shape (raw SF field values, not yet shaped) so callers that
// already have the row (POST /tasks) don't re-query it.
async function sendInviteEmails(sf, env, assigneeUserIds, taskFields, creatorName) {
  try {
    if (!assigneeUserIds.length) return;
    const directory = await getAllOfficeUsers(env);
    const emails = assigneeUserIds.map((id) => directory.find((u) => u.id === id)?.email).filter(Boolean);
    if (!emails.length) return;
    const when = formatTaskWhen(
      taskFields.startDate, normTime(taskFields.startTime), taskFields.endDate, normTime(taskFields.endTime)
    );
    await sf.sendEmail({
      to: emails,
      subject: `New task: ${taskFields.name}`,
      html: `<p><strong>${escapeHtml(taskFields.name)}</strong></p>
             <p>${escapeHtml(when)}</p>
             ${taskFields.description ? `<p>${escapeHtml(taskFields.description)}</p>` : ''}
             <p>Assigned by ${escapeHtml(creatorName)}.</p>`,
    });
  } catch (e) {
    console.error('Task invite email failed:', e.message);
  }
}

// A task occupies [startDate, endDate ?? startDate] - shows if that
// interval overlaps the requested [start, end] range. Cancelled tasks never
// show on the grid (soft-deleted, same convention as Schedule_Request__c's
// deny/withdraw - see DELETE /tasks/:id below).
tasks.get('/tasks', async (c) => {
  try {
    const me = await getOfficeUser(c);
    if (!me) return c.json({ error: 'Not authenticated' }, 401);
    const start = c.req.query('start');
    const end = c.req.query('end');
    if (!start || !end) return c.json({ error: 'start and end are required' }, 400);
    const sf = createSalesforce(c.env);
    const soql = `SELECT ${SELECT_FIELDS} FROM ${dt.sobject}
      WHERE ${dt.status} != 'Cancelled'
        AND ${dt.startDate} <= ${end}
        AND (${dt.endDate} >= ${start} OR (${dt.endDate} = null AND ${dt.startDate} >= ${start}))
      ORDER BY ${dt.startDate} ASC, ${dt.startTime} ASC NULLS LAST`;
    const records = await sf.query(soql);
    return c.json({ tasks: records.map(shapeTask) });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

tasks.post('/tasks', async (c) => {
  try {
    const me = await getOfficeUser(c);
    if (!me) return c.json({ error: 'Not authenticated' }, 401);
    const body = await c.req.json();
    const { name, description, startDate, startTime, endDate, endTime, timeSensitive, opportunityId, assigneeUserIds } = body;
    if (!name || !name.trim()) return c.json({ error: 'name is required' }, 400);
    if (!startDate) return c.json({ error: 'startDate is required' }, 400);
    if (!Array.isArray(assigneeUserIds) || assigneeUserIds.length === 0) {
      return c.json({ error: 'At least one assignee is required' }, 400);
    }

    const sf = createSalesforce(c.env);
    const fields = {
      [dt.name]: name.trim(),
      [dt.status]: 'Open',
      [dt.startDate]: startDate,
      [dt.timeSensitive]: !!timeSensitive,
    };
    if (description) fields[dt.description] = description;
    if (startTime) fields[dt.startTime] = toSfTime(startTime);
    // Time-sensitive tasks are a due-by moment, not a start/end block -- the
    // frontend never sends endDate/endTime in that mode, but guard here too
    // rather than trusting the client alone.
    if (endDate && !timeSensitive) fields[dt.endDate] = endDate;
    if (endTime && !timeSensitive) fields[dt.endTime] = toSfTime(endTime);
    if (opportunityId) fields[dt.opportunity] = opportunityId;

    const created = await sf.createRecord(dt.sobject, fields);
    const taskId = created.id;

    await Promise.all(assigneeUserIds.map((userId) =>
      sf.createRecord(ta.sobject, {
        [ta.task]: taskId,
        [ta.user]: userId,
        [ta.responseStatus]: 'Invited',
      })
    ));

    await sendInviteEmails(sf, c.env, assigneeUserIds, { name: name.trim(), description, startDate, startTime, endDate, endTime }, me.name);

    return c.json({ id: taskId }, 201);
  } catch (e) { return c.json({ error: e.message }, 500); }
});

tasks.patch('/tasks/:id', async (c) => {
  try {
    const me = await getOfficeUser(c);
    if (!me) return c.json({ error: 'Not authenticated' }, 401);
    const id = c.req.param('id');
    const body = await c.req.json();
    const sf = createSalesforce(c.env);

    const fields = {};
    if ('name' in body) {
      if (!body.name || !body.name.trim()) return c.json({ error: 'name cannot be blank' }, 400);
      fields[dt.name] = body.name.trim();
    }
    if ('description' in body) fields[dt.description] = body.description || null;
    if ('startDate' in body) fields[dt.startDate] = body.startDate;
    if ('startTime' in body) fields[dt.startTime] = body.startTime ? toSfTime(body.startTime) : null;
    if ('timeSensitive' in body) fields[dt.timeSensitive] = !!body.timeSensitive;
    // Same guard as POST /tasks -- a time-sensitive task is a due-by moment,
    // never a start/end block, regardless of what the client sends for
    // endDate/endTime.
    const timeSensitive = 'timeSensitive' in body ? !!body.timeSensitive : undefined;
    if ('endDate' in body) fields[dt.endDate] = timeSensitive ? null : (body.endDate || null);
    if ('endTime' in body) fields[dt.endTime] = timeSensitive ? null : (body.endTime ? toSfTime(body.endTime) : null);
    if ('opportunityId' in body) fields[dt.opportunity] = body.opportunityId || null;
    if (Object.keys(fields).length > 0) {
      await sf.updateRecord(dt.sobject, id, fields);
    }

    if (Array.isArray(body.assigneeUserIds)) {
      const existing = await sf.query(
        `SELECT Id, ${ta.user} FROM ${ta.sobject} WHERE ${ta.task} = '${esc(id)}'`
      );
      const existingUserIds = new Set(existing.map((r) => r[ta.user]));
      const wantedIds = new Set(body.assigneeUserIds);

      const toRemove = existing.filter((r) => !wantedIds.has(r[ta.user]));
      const toAdd = body.assigneeUserIds.filter((uid) => !existingUserIds.has(uid));

      await Promise.all(toRemove.map((r) => sf.deleteRecord(ta.sobject, r.Id)));
      await Promise.all(toAdd.map((userId) =>
        sf.createRecord(ta.sobject, { [ta.task]: id, [ta.user]: userId, [ta.responseStatus]: 'Invited' })
      ));

      if (toAdd.length) {
        const [row] = await sf.query(
          `SELECT ${dt.name}, ${dt.description}, ${dt.startDate}, ${dt.startTime}, ${dt.endDate}, ${dt.endTime}
           FROM ${dt.sobject} WHERE Id = '${esc(id)}' LIMIT 1`
        );
        if (row) {
          await sendInviteEmails(sf, c.env, toAdd, {
            name: row[dt.name], description: row[dt.description],
            startDate: row[dt.startDate], startTime: row[dt.startTime],
            endDate: row[dt.endDate], endTime: row[dt.endTime],
          }, me.name);
        }
      }
    }

    return c.json({ ok: true });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

// Never a hard delete - same convention as Schedule_Request__c's deny/
// withdraw. GET /tasks already excludes Cancelled ones from the grid.
tasks.delete('/tasks/:id', async (c) => {
  try {
    const me = await getOfficeUser(c);
    if (!me) return c.json({ error: 'Not authenticated' }, 401);
    const sf = createSalesforce(c.env);
    await sf.updateRecord(dt.sobject, c.req.param('id'), { [dt.status]: 'Cancelled' });
    return c.json({ ok: true });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

// The caller responds to THEIR OWN invite - finds their own assignee row
// (Task__c + User__c = me), never anyone else's.
tasks.post('/tasks/:id/respond', async (c) => {
  try {
    const me = await getOfficeUser(c);
    if (!me) return c.json({ error: 'Not authenticated' }, 401);
    const id = c.req.param('id');
    const { response } = await c.req.json();
    if (response !== 'Accepted' && response !== 'Declined') {
      return c.json({ error: 'response must be Accepted or Declined' }, 400);
    }

    const sf = createSalesforce(c.env);
    const [row] = await sf.query(
      `SELECT Id FROM ${ta.sobject} WHERE ${ta.task} = '${esc(id)}' AND ${ta.user} = '${esc(me.id)}' LIMIT 1`
    );
    if (!row) return c.json({ error: 'Not invited to this task' }, 404);

    await sf.updateRecord(ta.sobject, row.Id, {
      [ta.responseStatus]: response,
      [ta.respondedAt]: new Date().toISOString(),
    });

    // Best-effort notice to whoever created the task - never blocks the response itself.
    try {
      const [taskRow] = await sf.query(
        `SELECT ${dt.name}, CreatedBy.Email FROM ${dt.sobject} WHERE Id = '${esc(id)}' LIMIT 1`
      );
      const creatorEmail = taskRow?.CreatedBy?.Email;
      if (creatorEmail) {
        await sf.sendEmail({
          to: [creatorEmail],
          subject: `${me.name} ${response.toLowerCase()}: ${taskRow[dt.name]}`,
          html: `<p>${escapeHtml(me.name)} ${response.toLowerCase()} <strong>${escapeHtml(taskRow[dt.name])}</strong>.</p>`,
        });
      }
    } catch (e) {
      console.error('Task response email failed:', e.message);
    }

    return c.json({ ok: true });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

// Drives the CRS Schedule tab badge (count) and the per-chip "unresponded"
// flag on the signed-in user's own pinned/highlighted items - not a
// dedicated list UI, see the plan's notes on why that idea was dropped.
tasks.get('/tasks/my-invites', async (c) => {
  try {
    const me = await getOfficeUser(c);
    if (!me) return c.json({ error: 'Not authenticated' }, 401);
    const sf = createSalesforce(c.env);
    const rows = await sf.query(
      `SELECT Id, ${ta.task}, ${ta.taskParentRelationship}.Name
       FROM ${ta.sobject}
       WHERE ${ta.user} = '${esc(me.id)}' AND ${ta.responseStatus} = 'Invited'`
    );
    return c.json({ invites: rows.map((r) => ({
      assigneeId: r.Id,
      taskId: r[ta.task],
      taskName: r[ta.taskParentRelationship]?.Name ?? null,
    })) });
  } catch (e) { return c.json({ error: e.message }, 500); }
});
