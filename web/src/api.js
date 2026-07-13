// Thin wrapper around the backend API. In dev, Vite proxies /api to :3001.

async function j(res) {
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || res.statusText);
  return res.json();
}

export const api = {
  getJobs: (status) =>
    fetch('/api/jobs' + (status ? `?status=${encodeURIComponent(status)}` : '')).then(j),

  getTechnicians: () => fetch('/api/technicians').then(j),

  addTechnician: (name, fsUserId) =>
    fetch('/api/technicians', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, fsUserId }),
    }).then(j),

  getTechLink: (technicianId) =>
    fetch('/api/tech-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ technicianId }),
    }).then(j),

  getFsUsers: () => fetch('/api/fs-users').then(j),

  updateJob: (oppId, fields) =>
    fetch(`/api/jobs/${oppId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }).then(j),

  // status and scheduledDate are optional — when provided the server also updates
  // the SF Opportunity in the same request, eliminating a second round-trip.
  addAssignment: (oppId, technicianId, workDate, startTime, status, scheduledDate) =>
    fetch(`/api/jobs/${oppId}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ technicianId, workDate, startTime, status, scheduledDate }),
    }).then(j),

  removeAssignment: (assignmentId) =>
    fetch(`/api/assignments/${assignmentId}`, { method: 'DELETE' }).then(j),

  searchFsTasks: (q) =>
    fetch(`/api/fs-search?q=${encodeURIComponent(q)}`).then(j),

  linkFsTask: (oppId, fsTaskId) =>
    fetch(`/api/jobs/${oppId}/fs-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fsTaskId }),
    }).then(j),

  updateAssignment: (assignmentId, fields) =>
    fetch(`/api/assignments/${assignmentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }).then(j),

  getContacts: () => fetch('/api/contacts').then(j),

  updateAccountContact: (accountId, contactId) =>
    fetch(`/api/accounts/${accountId}/contact`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId }),
    }).then(j),

  updateContact: (contactId, fields) =>
    fetch(`/api/contacts/${contactId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }).then(j),

  getScheduleRequests: () => fetch('/api/schedule-requests').then(j),

  // opportunityId only required for isNewWo rows — the server 400s otherwise.
  approveScheduleRequest: (id, opportunityId) =>
    fetch(`/api/schedule-requests/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opportunityId ? { opportunityId } : {}),
    }).then(j),

  counterScheduleRequest: (id, { date, start, end, officeNote }) =>
    fetch(`/api/schedule-requests/${id}/counter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, start, end, officeNote }),
    }).then(j),

  denyScheduleRequest: (id, officeNote) =>
    fetch(`/api/schedule-requests/${id}/deny`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ officeNote }),
    }).then(j),

  getTimeOff: (start, end) =>
    fetch(`/api/time-off?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`).then(j),

  addTimeOff: (technicianId, workDate, startTime, endTime) =>
    fetch('/api/time-off', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ technicianId, workDate, startTime, endTime }),
    }).then(j),

};
