// ============================================================
//  Status mapping — FS <-> Salesforce
//  Edit this file when statuses change, not the sync logic.
//
//  There used to be an automatic bidirectional reconcile() here that
//  compared FS/SF timestamps and auto-wrote a status to whichever side
//  looked stale. It was removed: an automatic write could silently overturn
//  a status a human had just set on either side. Status comparison is now
//  display-only — the board's drift badge (FS_STATUS_COMPATIBLE in
//  web/src/App.jsx) flags a mismatch for a person to look at; nothing here
//  writes based on it. FS_TO_SF below is kept purely as the documented
//  FS→SF direction for that comparison — no code path writes through it.
// ============================================================

// Documents which SF stage a given FS status corresponds to. Reference only
// (see note above) — not used to write Project_Status__c.
// null = no SF equivalent
export const FS_TO_SF = {
  'Entered':           'Ready to be scheduled',
  'Scheduled':         'Scheduled',
  'Assigned':          'Scheduled',
  'En-Route':          'In Progress',
  'In-Progress':       'In Progress',
  'Rescheduled':       'Scheduled',
  'Return Trip':       'In Progress',
  'Completed':         'Installation Completed',
  'In-review':         null,
  'Billing Completed': 'Waiting on Payment',
  'Warranty':          null,
};

// Canonical FS status to write when a dispatcher explicitly sets an SF stage
// (dispatcher-driven writes only — see sfToFsStatus below and its callers in
// routes.js/assignments.js). null = skip.
export const SF_TO_FS = {
  'Pending Customer Approval': 'Entered',
  'Quoted':                    'Entered',
  'Parts Ordered':             'Entered',
  'Ready to be scheduled':     'Entered',
  'Scheduled':                 'Scheduled',
  'In Progress':               'In-Progress',
  'Installation Completed':     'Completed',
  'Waiting on Payment':        'Billing Completed',
  'Billing Complete':          'Billing Completed',
  'Project Complete':          'Billing Completed',
};

/**
 * SF stage → FS status with assignment awareness.
 * "Scheduled" maps to "Assigned" in FS when the job has at least one tech
 * assigned — "Assigned" in FS means techs are booked, "Scheduled" means the
 * date is set but no one is attached yet.
 *
 * Only called from explicit dispatcher-driven paths (PATCH /jobs/:id,
 * assignment creation) — never from the FS-sync cron or the fs-link
 * endpoint, which no longer push a status to FS on their own.
 */
export function sfToFsStatus(sfStatus, hasAssignments) {
  if (sfStatus === 'Scheduled' && hasAssignments) return 'Assigned';
  return SF_TO_FS[sfStatus] ?? null;
}