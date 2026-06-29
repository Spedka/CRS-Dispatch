// Thin wrapper around the backend API. In dev, Vite proxies /api to :3001.

async function j(res) {
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || res.statusText);
  return res.json();
}

export const api = {
  getJobs: (status) =>
    fetch('/api/jobs' + (status ? `?status=${encodeURIComponent(status)}` : '')).then(j),

  getTechnicians: () => fetch('/api/technicians').then(j),

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

};
