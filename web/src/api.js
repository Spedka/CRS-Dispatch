// Thin wrapper around the backend API. In dev, Vite proxies /api to :3001.

async function j(res) {
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || res.statusText);
  return res.json();
}

export const api = {
  getJobs: (status) =>
    fetch('/api/jobs' + (status ? `?status=${encodeURIComponent(status)}` : '')).then(j),

  getTechnicians: (opts) =>
    fetch(`/api/technicians${opts?.all ? '?all=1' : ''}`).then(j),

  addTechnician: (name, fsUserId, color) =>
    fetch('/api/technicians', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, fsUserId, color }),
    }).then(j),

  updateTechnician: (id, fields) =>
    fetch(`/api/technicians/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }).then(j),


  getFsUsers: () => fetch('/api/fs-users').then(j),

  updateJob: (oppId, fields) =>
    fetch(`/api/jobs/${oppId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }).then(j),

  // status and scheduledDate are optional - when provided the server also updates
  // the SF Opportunity in the same request, eliminating a second round-trip.
  // endTime is required by the server (400s without it) for real job assignments.
  addAssignment: (oppId, technicianId, workDate, startTime, endTime, status, scheduledDate) =>
    fetch(`/api/jobs/${oppId}/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ technicianId, workDate, startTime, endTime, status, scheduledDate }),
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

  updateAccountContact: (accountId, contactId, field = 'property') =>
    fetch(`/api/accounts/${accountId}/contact`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactId, field }),
    }).then(j),

  updateContact: (contactId, fields) =>
    fetch(`/api/contacts/${contactId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }).then(j),

  getAccounts: () => fetch('/api/accounts').then(j),

  updateAccount: (accountId, fields) =>
    fetch(`/api/accounts/${accountId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }).then(j),

  getScheduleRequests: (opts) =>
    fetch(`/api/schedule-requests${opts?.resolved ? '?resolved=1' : ''}`).then(j),

  // opportunityId only required for isNewWo rows - the server 400s otherwise.
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

  getNotes: () => fetch('/api/notes').then(j),

  addNote: (text, opportunityId, taskId) =>
    fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, opportunityId: opportunityId || null, taskId: taskId || null }),
    }).then(j),

  updateNote: (id, fields) =>
    fetch(`/api/notes/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }).then(j),

  removeNote: (id) =>
    fetch(`/api/notes/${id}`, { method: 'DELETE' }).then(j),

  getQuotes: (view) =>
    fetch('/api/jobs/quotes' + (view ? `?view=${encodeURIComponent(view)}` : '')).then(j),

  getQuoteDocuments: (oppId) =>
    fetch(`/api/jobs/quotes/${oppId}/documents`).then(j),

  getUsers: () => fetch('/api/users').then(j),

  sendQuoteEmail: (oppId, recipients) =>
    fetch(`/api/jobs/quotes/${oppId}/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients }),
    }).then(j),

  sendQuoteReviewEmail: (oppId, recipients) =>
    fetch(`/api/jobs/quotes/${oppId}/send-review-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients }),
    }).then(j),

  getPartsInventory: () => fetch('/api/parts/inventory').then(j),

  getPartsCatalog: () => fetch('/api/parts/catalog').then(j),

  getServiceStock: () => fetch('/api/parts/service-stock').then(j),

  addInventory: (opportunityId, { poNumber, poUploaded, lines }) =>
    fetch('/api/parts/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opportunityId, poNumber, poUploaded, lines }),
    }).then(j),

  checkoutParts: (opportunityId, { checkedOutById, checkoutDate, truckNumber, materialRequestNumber, materialReqAttached, lines }) =>
    fetch('/api/parts/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opportunityId, checkedOutById, checkoutDate, truckNumber, materialRequestNumber, materialReqAttached, lines }),
    }).then(j),

  updateInventoryRow: (id, fields) =>
    fetch(`/api/parts/inventory/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }).then(j),

  // ---- Create PO (QBO purchasing) ----
  getPoSource: (oppIds) => fetch(`/api/finance/po-source?oppIds=${oppIds.map(encodeURIComponent).join(',')}`).then(j),

  getQuoteLines: (quoteId) => fetch(`/api/finance/quotes/${quoteId}/lines`).then(j),

  getQboVendors: () => fetch('/api/finance/qbo-vendors').then(j),

  getSfdcVendors: () => fetch('/api/finance/sfdc-vendors').then(j),

  getCostCenters: () => fetch('/api/finance/cost-centers').then(j),

  getQboProjects: () => fetch('/api/finance/qbo-projects').then(j),

  getQboItems: () => fetch('/api/finance/qbo-items').then(j),

  createPurchaseOrder: (body) =>
    fetch('/api/finance/purchase-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(j),

  // ---- Create PO from a Field Squared material req (Service Call / Service
  // Stock paths) ----
  // Broader than getJobs() on purpose -- includes Service Call Opportunities
  // regardless of board status, since a material req/PO is routinely made
  // after a service call has already closed out. See materialReqs.js.
  getServiceCallOpportunities: () => fetch('/api/finance/service-call-opportunities').then(j),

  getMaterialReqs: (oppId) => fetch(`/api/finance/material-reqs/${oppId}`).then(j),

  getMaterialReqLines: (oppId, docId) => fetch(`/api/finance/material-reqs/${oppId}/${docId}/lines`).then(j),

  getPoCustomerSuggestions: (oppId) => fetch(`/api/finance/po-customer-suggestions/${oppId}`).then(j),

  // ---- Create Invoice (QBO invoicing from FS SERVICE_ACK data) ----
  getServiceAcks: (oppId) => fetch(`/api/finance/service-acks/${oppId}`).then(j),

  getServiceAckLines: (oppId, docId) => fetch(`/api/finance/service-acks/${oppId}/${docId}/lines`).then(j),

  getQboSalesItems: () => fetch('/api/finance/qbo-sales-items').then(j),

  // ---- Expense Tracking (Job/Project Cost Tracking) ----
  getExpenseJobs: () => fetch('/api/finance/expense-jobs').then(j),

  getJobCost: (oppId) => fetch(`/api/finance/job-cost/${oppId}`).then(j),

  createInvoice: (body) =>
    fetch('/api/finance/invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(j),

  // ---- Office users (admin) ----
  getOfficeUsers: () => fetch('/api/auth/office-users').then(j),

  updateOfficeUser: (id, fields) =>
    fetch(`/api/auth/office-users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }).then(j),

  // ---- Usage analytics (admin) ----
  getUsage: (days, app) =>
    fetch(`/api/usage?days=${days}${app && app !== 'all' ? `&app=${app}` : ''}`).then(j),
  getUsagePeople: () => fetch('/api/usage/people').then(j),
  getUsageUser: (actor, days) =>
    fetch(`/api/usage/user?actor=${encodeURIComponent(actor)}&days=${days}`).then(j),
  getUsageRecent: ({ days, limit = 100, actor, app } = {}) => {
    const p = new URLSearchParams({ days: String(days), limit: String(limit) });
    if (actor) p.set('actor', actor);
    if (app && app !== 'all') p.set('app', app);
    return fetch(`/api/usage/recent?${p}`).then(j);
  },

  // Admin billing reconciliation (QBO vs SF). opts: { from, to, paymentMethod, refresh }.
  // groupBy is applied client-side (rows carry the grouping keys).
  getBillingReconciliation: (opts = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v != null && v !== '') p.set(k, String(v));
    return fetch(`/api/finance/reconciliation?${p}`).then(j);
  },

  // ---- CRS Schedule: office tasks/events (Dispatch_Task__c) ----
  // Lean {id, name, email, isAdmin} list, no admin gate, no password -- the
  // task-assignee picker's data source. Distinct from getOfficeUsers() above
  // (admin-only, includes passwords, for the Manage panel).
  getOfficeUserDirectory: () => fetch('/api/office-users/directory').then(j),

  getTasks: (start, end) =>
    fetch(`/api/tasks?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`).then(j),

  createTask: (body) =>
    fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(j),

  updateTask: (id, body) =>
    fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(j),

  cancelTask: (id) => fetch(`/api/tasks/${id}`, { method: 'DELETE' }).then(j),

  respondToTask: (id, response) =>
    fetch(`/api/tasks/${id}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response }),
    }).then(j),

  // Drives the CRS Schedule tab badge -- see tasks.js's own comment on why
  // there's no separate "Invites" list UI consuming this.
  getMyTaskInvites: () => fetch('/api/tasks/my-invites').then(j),

};
