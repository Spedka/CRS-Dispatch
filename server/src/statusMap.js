// ============================================================
//  Status mapping — FS <-> Salesforce
//  Edit this file when statuses change, not the sync logic.
//
//  There used to be an automatic bidirectional reconcile() here that
//  compared FS/SF timestamps and auto-wrote a status to whichever side
//  looked stale. It was removed: an automatic write could silently overturn
//  a status a human had just set on either side. Status comparison is
//  otherwise display-only — the board's drift badge (FS_STATUS_COMPATIBLE
//  in web/src/App.jsx) flags a mismatch for a person to look at, and
//  nothing writes Project_Status__c based on it. FS_TO_SF below is kept
//  purely as the documented FS→SF direction for that comparison — no code
//  path writes Project_Status__c through it.
//
//  As of 2026-08-03, fsSync.js DOES use the comparison (via
//  isFsStatusCompatible below) for one narrow purpose: a job flagged as
//  "drifting" might just have a stale FS_Status__c *snapshot* rather than
//  a real disagreement — the cron's other refresh triggers (FS reports it
//  modified, or the snapshot is empty) don't catch a present-but-wrong
//  snapshot. So flagged jobs get a live FS re-check, and ONLY
//  FS_Status__c/FS_Last_Modified__c get corrected if that live check
//  actually differs from what's cached. Project_Status__c is still never
//  written by this or any other cron path.
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

// Same table as FS_STATUS_COMPATIBLE in web/src/App.jsx — kept as a
// separate, hand-maintained copy rather than derived from FS_TO_SF above,
// since it isn't a pure inverse of it (several early-stage SF statuses
// like "Quoted"/"Parts Ordered" all compare compatible with FS's single
// "Entered" status, not just the one SF stage FS_TO_SF's "Entered" entry
// points at). Keep in sync with App.jsx's copy by hand — see "Things to
// verify during audit" in CLAUDE.md.
const FS_STATUS_COMPATIBLE = {
  'Pending Customer Approval': ['Entered'],
  'Quoted': ['Entered'],
  'Parts Ordered': ['Entered'],
  'Ready to be scheduled': ['Entered'],
  'Scheduled': ['Scheduled', 'Assigned', 'Rescheduled'],
  'In Progress': ['In-Progress', 'En-Route', 'Return Trip'],
  'Installation Completed': ['Completed'],
  'Waiting on Payment': ['Billing Completed'],
  'Billing Complete': ['Billing Completed'],
  'Project Complete': ['Billing Completed'],
};

// FS statuses with no SF equivalent at all (see the null entries in
// FS_TO_SF above) — there's nothing on the SF side for these to
// agree/disagree with, so they're treated as non-contradictory. Mirrors
// FS_NO_EQUIVALENT/FS_NO_EQUIVALENT_IS_CONTRADICTION in App.jsx.
const FS_NO_EQUIVALENT = new Set(['In-review', 'Warranty']);

/**
 * True if sfStatus/fsStatus look compatible per the table above (or
 * fsStatus has no SF equivalent at all). Mirrors fsDriftInfo() in
 * App.jsx exactly, so fsSync.js's drift-verification pass never flags
 * something the board's own drift badge wouldn't also flag, or vice versa.
 */
export function isFsStatusCompatible(sfStatus, fsStatus) {
  if (FS_NO_EQUIVALENT.has(fsStatus)) return true;
  const compatible = FS_STATUS_COMPATIBLE[sfStatus];
  return !!(compatible && compatible.includes(fsStatus));
}