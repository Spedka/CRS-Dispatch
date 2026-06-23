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

  addAssignment: (oppId, technicianId, workDate, startTime) =>
    (function() {
      const body = { technicianId, workDate, startTime };
      try { console.log('[API] POST /api/jobs/' + oppId + '/assignments', body); } catch (e) {}
      return fetch(`/api/jobs/${oppId}/assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(j);
    })(),

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
    (function() {
      try { console.log('[API] PATCH /api/assignments/' + assignmentId, fields); } catch (e) {}
      return fetch(`/api/assignments/${assignmentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      }).then(j);
    })(),

};