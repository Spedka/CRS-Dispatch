// ============================================================
//  Status mapping - FS <-> Salesforce
//  Edit this file when statuses change, not the sync logic.
//
//  There used to be an automatic bidirectional reconcile() here that
//  compared FS/SF timestamps and auto-wrote a status to whichever side
//  looked stale. It was removed: an automatic write could silently overturn
//  a status a human had just set on either side. Status comparison is
//  otherwise display-only - the board's drift badge (FS_STATUS_COMPATIBLE
//  in web/src/App.jsx) flags a mismatch for a person to look at, and
//  nothing writes Project_Status__c based on it. FS_TO_SF below is kept
//  purely as the documented FS→SF direction for that comparison - no code
//  path writes Project_Status__c through it.
//
//  As of 2026-08-03, fsSync.js DOES use the comparison (via
//  isFsStatusCompatible below) for one narrow purpose: a job flagged as
//  "drifting" might just have a stale FS_Status__c *snapshot* rather than
//  a real disagreement - the cron's other refresh triggers (FS reports it
//  modified, or the snapshot is empty) don't catch a present-but-wrong
//  snapshot. So flagged jobs get a live FS re-check, and ONLY
//  FS_Status__c/FS_Last_Modified__c get corrected if that live check
//  actually differs from what's cached. Project_Status__c is still never
//  written by this or any other cron path.
// ============================================================

// Documents which SF stage a given FS status corresponds to. Reference only
// (see note above) - not used to write Project_Status__c.
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
// (dispatcher-driven writes only - see sfToFsStatus below and its callers in
// routes.js/assignments.js). null = skip.
// Keyed by the raw status VALUE (not by field), so it covers every record
// type's status field at once - the value spellings don't collide across the
// Project_Status__c / Service_Status__c / StageName picklists (a shared value
// like 'Scheduled' or 'Completed' means the same thing on any of them).
export const SF_TO_FS = {
  'Pending Customer Approval': 'Entered',
  'Quoted':                    'Entered',
  'Parts ordered':             'Entered', // casing matches the org's picklist
  'Ready to be scheduled':     'Entered',
  'Ready to be Scheduled':     'Entered', // Service_Status__c spelling (capital S)
  'Unscheduled':               'Entered', // StageName (Test & Inspection)
  'Scheduled':                 'Scheduled',
  'In Progress':               'In-Progress',
  'Installation Completed':     'Completed',
  'Completed':                 'Completed', // Service_Status__c / StageName
  'Waiting on Payment':        'Billing Completed',
  'Billing Complete':          'Billing Completed',
  'Project Complete':          'Billing Completed',
};

/**
 * SF stage → FS status with assignment awareness.
 * "Scheduled" maps to "Assigned" in FS when the job has at least one tech
 * assigned - "Assigned" in FS means techs are booked, "Scheduled" means the
 * date is set but no one is attached yet.
 *
 * Only called from explicit dispatcher-driven paths (PATCH /jobs/:id,
 * assignment creation) - never from the FS-sync cron or the fs-link
 * endpoint, which no longer push a status to FS on their own.
 */
export function sfToFsStatus(sfStatus, hasAssignments) {
  if (sfStatus === 'Scheduled' && hasAssignments) return 'Assigned';
  return SF_TO_FS[sfStatus] ?? null;
}

// Per-record-type FS↔SF compatibility. Each table maps that record type's own
// status VALUES to the set of raw FS statuses that are NOT a contradiction.
// Same tables as in web/src/App.jsx (FS_COMPAT_BASE / FS_STATUS_COMPATIBLE_BY_TYPE)
// - kept as a hand-maintained copy, not derived from FS_TO_SF, since it isn't a
// pure inverse (several early-stage SF statuses all compare compatible with FS's
// single "Entered"). Keep both copies in sync by hand - CLAUDE.md audit item #4.
//
// Types on Project_Status__c (null / Default / Job / Work_Order) share BASE.
const FS_COMPAT_BASE = {
  'Pending Customer Approval': ['Entered'],
  'Quoted': ['Entered'],
  'Parts ordered': ['Entered'],
  'Ready to be scheduled': ['Entered'],
  'Scheduled': ['Scheduled', 'Assigned', 'Rescheduled'],
  'In Progress': ['In-Progress', 'En-Route', 'Return Trip'],
  'Installation Completed': ['Completed'],
  'Waiting on Payment': ['Billing Completed'],
  'Billing Complete': ['Billing Completed'],
  'Project Complete': ['Billing Completed'],
};

const FS_STATUS_COMPATIBLE_BY_TYPE = {
  Service_Call: { // Service_Status__c values
    'Pending Customer Approval': ['Entered'],
    'Ready to be Scheduled': ['Entered'],
    'Scheduled': ['Scheduled', 'Assigned', 'Rescheduled'],
    'In Progress': ['In-Progress', 'En-Route', 'Return Trip'],
    'Completed': ['Completed'],
  },
  Test_Inspection: { // Inspection_Status__c values (no "In Progress" on that field)
    'Pending Customer Approval': ['Entered'],
    'Unscheduled': ['Entered'],
    'Scheduled': ['Scheduled', 'Assigned', 'Rescheduled'],
    'Completed': ['Completed'],
  },
};

// Resolve the compatibility table for a record type (BASE for null/Default/
// Job/Work_Order and anything not explicitly diverged).
function compatTableFor(recordType) {
  return FS_STATUS_COMPATIBLE_BY_TYPE[recordType] || FS_COMPAT_BASE;
}

// FS statuses with no SF equivalent at all (see the null entries in
// FS_TO_SF above) - there's nothing on the SF side for these to
// agree/disagree with, so they're treated as non-contradictory. Mirrors
// FS_NO_EQUIVALENT/FS_NO_EQUIVALENT_IS_CONTRADICTION in App.jsx.
const FS_NO_EQUIVALENT = new Set(['In-review', 'Warranty']);

/**
 * True if sfStatus/fsStatus look compatible for a job of the given record type
 * (or fsStatus has no SF equivalent at all). `recordType` is
 * RecordType.DeveloperName (null for legacy Opps -> BASE table). Mirrors
 * fsDriftInfo() in App.jsx exactly, so fsSync.js's drift-verification pass never
 * flags something the board's own drift badge wouldn't also flag, or vice versa.
 */
export function isFsStatusCompatible(recordType, sfStatus, fsStatus) {
  if (FS_NO_EQUIVALENT.has(fsStatus)) return true;
  const compatible = compatTableFor(recordType)[sfStatus];
  return !!(compatible && compatible.includes(fsStatus));
}