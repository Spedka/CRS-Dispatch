async function request(path, options) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  getJobs: (status) => request(status ? `/jobs?status=${encodeURIComponent(status)}` : '/jobs'),
  getTechnicians: () => request('/technicians'),
  addAssignment: (oppId, technicianId, workDate) =>
    request(`/jobs/${oppId}/assignments`, {
      method: 'POST',
      body: JSON.stringify({ technicianId, workDate }),
    }),
  removeAssignment: (assignmentId) =>
    request(`/assignments/${assignmentId}`, { method: 'DELETE' }),
};
