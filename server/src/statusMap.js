// ============================================================
//  Status mapping — FS <-> Salesforce
//  Edit this file when statuses change, not the sync logic.
// ============================================================

// Canonical SF stage to write when FS status is the source of truth.
// null = skip (no SF equivalent; don't touch SF)
export const FS_TO_SF = {
  'Entered':           'Ready to be scheduled',
  'Scheduled':         'Scheduled',
  'Assigned':          'Scheduled',
  'En-Route':          'In Progress',
  'In-Progress':       'In Progress',
  'Rescheduled':       'Scheduled',
  'Return Trip':       'In Progress',
  'Completed':         'Installation Complete',
  'In-review':         null,
  'Billing Completed': 'Waiting on Payment', // special case — see reconcile
  'Warranty':          null,
};

// Canonical FS status to write when SF stage is the source of truth.
// null = skip
export const SF_TO_FS = {
  'Pending Customer Approval': 'Entered',
  'Quoted':                    'Entered',
  'Parts Ordered':             'Entered',
  'Ready to be scheduled':     'Entered',
  'Scheduled':                 'Scheduled',
  'In Progress':               'In-Progress',
  'Installation Complete':     'Completed',
  'Waiting on Payment':        'Billing Completed',
  'Billing Complete':          'Billing Completed',
  'Project Complete':          'Billing Completed',
};

// Numeric rank for furthest-ahead tiebreaker when timestamps are too close.
const FS_RANK = {
  'Entered':           1,
  'Scheduled':         2,
  'Assigned':          3,
  'En-Route':          4,
  'In-Progress':       5,
  'Rescheduled':       2,
  'Return Trip':       5,
  'Completed':         6,
  'In-review':         6,
  'Billing Completed': 7,
  'Warranty':          7,
};

const SF_RANK = {
  'Pending Customer Approval': 1,
  'Quoted':                    1,
  'Parts Ordered':             1,
  'Ready to be scheduled':     1,
  'Scheduled':                 2,
  'In Progress':               5,
  'Installation Complete':     6,
  'Waiting on Payment':        7,
  'Billing Complete':          8,
  'Project Complete':          8,
};

// Two statuses are equivalent if they map to the same canonical value,
// or if they are the special Billing Completed <-> Billing Complete pair
// (which would otherwise loop between Waiting on Payment and Billing Complete).
export function areEquivalent(fsStatus, sfStatus) {
  if (fsStatus === 'Billing Completed' && sfStatus === 'Billing Complete') return true;
  if (fsStatus === 'Billing Completed' && sfStatus === 'Waiting on Payment') return true;
  const fsMapped = FS_TO_SF[fsStatus];
  const sfMapped = SF_TO_FS[sfStatus];
  if (fsMapped && fsMapped === sfStatus) return true;
  if (sfMapped && sfMapped === fsStatus) return true;
  return false;
}

/**
 * Decide what (if anything) to write given the current status on each side.
 *
 * Returns one of:
 *   { action: 'noop' }
 *   { action: 'skip', reason: string }
 *   { action: 'write', target: 'sf'|'fs', value: string }
 */
export function reconcile(fsStatus, sfStatus, fsLastUpdated, sfLastModifiedDate) {
  const fsMapped = FS_TO_SF[fsStatus];
  const sfMapped = SF_TO_FS[sfStatus];

  // If FS status has no mapping, skip entirely.
  if (fsMapped === null || (fsMapped === undefined && !sfMapped)) {
    return { action: 'skip', reason: `No SF mapping for FS status "${fsStatus}"` };
  }

  // If SF status has no mapping, skip entirely.
  if (sfMapped === undefined) {
    return { action: 'skip', reason: `No FS mapping for SF status "${sfStatus}"` };
  }

  // Already equivalent — nothing to do.
  if (areEquivalent(fsStatus, sfStatus)) return { action: 'noop' };

  // Compare recency. Whichever side changed more recently wins outright,
  // unless the timestamps are too close to be meaningful (simultaneous edits).
  const fsTime = new Date(fsLastUpdated).getTime();
  const sfTime = new Date(sfLastModifiedDate).getTime();
  const THRESHOLD_MS = 60_000; // within 60 s → use rank instead

  if (Math.abs(fsTime - sfTime) > THRESHOLD_MS) {
    if (fsTime > sfTime) {
      // FS is newer — write to SF.
      // Special case: if SF is already at Billing Complete, don't demote.
      if (fsStatus === 'Billing Completed' && sfStatus === 'Billing Complete') {
        return { action: 'noop' };
      }
      const sfTarget = FS_TO_SF[fsStatus];
      if (!sfTarget) return { action: 'skip', reason: `No SF mapping for FS="${fsStatus}"` };
      return { action: 'write', target: 'sf', value: sfTarget };
    } else {
      // SF is newer — write to FS.
      const fsTarget = SF_TO_FS[sfStatus];
      if (!fsTarget) return { action: 'skip', reason: `No FS mapping for SF="${sfStatus}"` };
      return { action: 'write', target: 'fs', value: fsTarget };
    }
  }

  // Timestamps too close — fall back to furthest-ahead rank.
  const fsRank = FS_RANK[fsStatus] ?? 0;
  const sfRank = SF_RANK[sfStatus] ?? 0;

  if (fsRank > sfRank) {
    const sfTarget = FS_TO_SF[fsStatus];
    if (!sfTarget) return { action: 'skip', reason: `No SF mapping for FS="${fsStatus}"` };
    return { action: 'write', target: 'sf', value: sfTarget };
  }
  if (sfRank > fsRank) {
    const fsTarget = SF_TO_FS[sfStatus];
    if (!fsTarget) return { action: 'skip', reason: `No FS mapping for SF="${sfStatus}"` };
    return { action: 'write', target: 'fs', value: fsTarget };
  }

  // Same rank, same timestamp — genuinely ambiguous.
  return { action: 'noop' };
}