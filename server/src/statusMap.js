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
  'Completed':         'Installation Completed',
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
  'Installation Completed':     'Completed',
  'Waiting on Payment':        'Billing Completed',
  'Billing Complete':          'Billing Completed',
  'Project Complete':          'Billing Completed',
};

// SF stages where billing has actually closed out. Once here, FS can never
// pull SF backward — no matter how recent FS's LastUpdated looks.
// Why: FS LastUpdated changes on any field edit, not just status, and jobs
// are sometimes billed ahead of the field work finishing (e.g. a test/
// inspection billed in advance while FS still shows an earlier status).
// A fresh-looking FS timestamp in that case doesn't mean the job regressed —
// reconcile() skips rather than trusting it. This is a business decision,
// not a general "furthest-ahead-wins" rule: "Waiting on Payment" (billing
// not yet closed) is NOT in this set on purpose — FS must stay free to pull
// SF back down to Scheduled/In Progress/etc. after a job is billed early,
// otherwise a pre-billed job could never move again on the board.
const SF_TERMINAL_LOCKED = new Set(['Billing Complete', 'Project Complete']);

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
 * SF stage → FS status with assignment awareness.
 * "Scheduled" maps to "Assigned" in FS when the job has at least one tech
 * assigned — "Assigned" in FS means techs are booked, "Scheduled" means the
 * date is set but no one is attached yet.
 */
export function sfToFsStatus(sfStatus, hasAssignments) {
  if (sfStatus === 'Scheduled' && hasAssignments) return 'Assigned';
  return SF_TO_FS[sfStatus] ?? null;
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

  // Billing has actually closed on the SF side — frozen regardless of what
  // FS's timestamp says. See SF_TERMINAL_LOCKED comment above for why.
  if (SF_TERMINAL_LOCKED.has(sfStatus)) {
    return { action: 'skip', reason: `SF status "${sfStatus}" is terminal — not writable from FS` };
  }

  // Pure recency: whichever side was actually edited more recently wins.
  const fsTime = new Date(fsLastUpdated).getTime();
  const sfTime = new Date(sfLastModifiedDate).getTime();

  if (Number.isNaN(fsTime) || Number.isNaN(sfTime) || fsTime === sfTime) {
    return { action: 'noop' }; // no usable signal to break the tie
  }

  if (fsTime > sfTime) {
    const sfTarget = FS_TO_SF[fsStatus];
    if (!sfTarget) return { action: 'skip', reason: `No SF mapping for FS="${fsStatus}"` };
    return { action: 'write', target: 'sf', value: sfTarget };
  }

  const fsTarget = SF_TO_FS[sfStatus];
  if (!fsTarget) return { action: 'skip', reason: `No FS mapping for SF="${sfStatus}"` };
  return { action: 'write', target: 'fs', value: fsTarget };
}