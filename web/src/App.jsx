import React, { useEffect, useLayoutEffect, useState, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.js';
import { getUser, login as authLogin, logout as authLogout, changePassword as authChangePassword, track as trackUsage } from './auth.js';

// Map your real status strings to a color treatment. Unknown -> neutral.
const STATUS_CLASS = {
  'Needs Quote': 'needs',             // amber - pre-scheduling quote stage, Quotes tab only
  'Ready for Review': 'dispatched',   // indigo - quote drafted, awaiting internal review
  'Needs Quote Review': 'dispatched', // legacy value (replaced by 'Ready for Review')
  'Pending Customer Approval': 'scheduled',
  'Quoted': 'scheduled',
  'Parts ordered': 'needs',
  'Ready to be scheduled': 'needs',   // amber - needs a tech assigned
  'Ready to be Scheduled': 'needs',   // Service Call (Service_Status__c) spelling
  'Unscheduled': 'needs',             // Test & Inspection (StageName)
  'Scheduled': 'scheduled',           // blue - booked
  'In Progress': 'dispatched',        // indigo - tech on site
  'Installation Completed': 'dispatched',
  'Completed': 'dispatched',          // Service Call / Test & Inspection terminal
  'Waiting on Payment': 'emergency',  // red - done, awaiting payment
  'Billing Complete': 'scheduled',
  'Project Complete': 'scheduled',
};
const statusClass = (s) => STATUS_CLASS[s] || 'scheduled';

// Persists the top-level tab + jobs-list filters across reloads (including a
// hard browser refresh, which a plain useState wouldn't survive) -- this app
// has no router, so localStorage is the lower-lift fix over building one.
// Scoped to this top-level state only; Schedule's own view state and
// ContactsTab's own search/filters are left alone.
const VIEW_STATE_KEY = 'dispatch_view_state';
const loadViewState = () => {
  try { return JSON.parse(localStorage.getItem(VIEW_STATE_KEY) || '{}'); } catch { return {}; }
};

// Terminal statuses leave the board (mirrors: not in jobStatusValues). Viewable
// via a filter regardless of how they were set. "Billing Complete" only ever
// comes from Field Squared; "Project Complete" can also be set from the dropdown
// below (see ASSIGNABLE_STATUSES).
const TERMINAL_STATUSES = ['Billing Complete', 'Project Complete'];

// Everything that stays on the board (mirrors config.jobStatusValues) - for
// legacy / Job / Work_Order jobs on Project_Status__c.
// 'Needs Quote' added 2026-08-25: a pre-quote site visit is a real reason to
// dispatch a tech before quoting is done, so it has to be board-visible too -
// see config.js's jobStatusValues comment for the real case that prompted this.
const BOARD_STATUSES = [
  'Needs Quote', 'Pending Customer Approval', 'Quoted', 'Parts ordered', 'Ready to be scheduled',
  'Scheduled', 'In Progress', 'Installation Completed', 'Waiting on Payment',
];
// A dispatcher can set any board status, plus "Project Complete" to take a job
// off the board manually (it's a real picklist value, just not in jobStatusValues,
// so the board query is unaffected). "Billing Complete" stays excluded - that one
// still only happens in Field Squared. Strings must match the SF picklist EXACTLY.
const ASSIGNABLE_STATUSES = [...BOARD_STATUSES, 'Project Complete'];

// ---- Record-type-aware status handling (mirrors server config.recordTypeStatus) ----
// New record types keep their lifecycle status in a different field with its own
// values. Service Call -> Service_Status__c, Test & Inspection -> Inspection_Status__c.
// Types not listed here ride Project_Status__c and use the BOARD/ASSIGNABLE lists,
// which as of 2026-08-25 include 'Needs Quote' (see BOARD_STATUSES above).
// Service_Call/Test_Inspection below still deliberately exclude the
// quote-pipeline values -- only extend those too if the same
// site-visit-before-quote need comes up for those record types.
const STATUS_VALUES_BY_TYPE = {
  Service_Call: ['Pending Customer Approval', 'Ready to be Scheduled', 'Scheduled', 'In Progress', 'Completed'],
  Test_Inspection: ['Pending Customer Approval', 'Unscheduled', 'Scheduled', 'Completed'],
};
// Dropdown options for a job of the given record type.
const assignableStatusesFor = (recordType) =>
  STATUS_VALUES_BY_TYPE[recordType] || ASSIGNABLE_STATUSES;
// True if `status` keeps a job of this record type on the board (server's
// boardStatusPredicate treats every valuesByType entry as on-board).
const isBoardStatusFor = (recordType, status) =>
  (STATUS_VALUES_BY_TYPE[recordType] || BOARD_STATUSES).includes(status);
// The "Scheduled" value is identical across every type's status field.
const SCHEDULED_STATUS = 'Scheduled';
// The value meaning "back in the queue / not yet scheduled" per record type.
const QUEUE_STATUS_BY_TYPE = {
  Service_Call: 'Ready to be Scheduled',
  Test_Inspection: 'Unscheduled',
};
const queueStatusFor = (recordType) =>
  QUEUE_STATUS_BY_TYPE[recordType] || 'Ready to be scheduled';
// Statuses that auto-advance to "Scheduled" when a date is set, per record type.
const PRE_SCHEDULED_BY_TYPE = {
  Service_Call: ['Pending Customer Approval', 'Ready to be Scheduled'],
  Test_Inspection: ['Unscheduled'],
};
const preScheduledFor = (recordType) =>
  PRE_SCHEDULED_BY_TYPE[recordType] || PRE_SCHEDULED;

// ---- Job category facet (the "Type" filter dropdown) ----
// Buckets every job into Job / Service Call / Test & Inspection / Other /
// Monitoring. Only the FOUR real record types are authoritative - `Default`
// (catch-all) and `Work_Order` (the FS artifact) are NOT semantic categories,
// so they fall through to the explicit Opportunity_Type__c map below rather
// than forcing "Job" (that precedence was the bug where `Service - Fire` opps
// with a Default/Work_Order record type showed as Job). Unknown / null
// Opportunity_Type__c values default to Job.
const RECORD_TYPE_LABELS = {
  Job: 'Job',
  Service_Call: 'Service Call',
  Test_Inspection: 'Test & Inspection',
  Monitoring: 'Monitoring',
};
// Explicit - no fuzzy matching. Keep in sync with the org's Opportunity_Type__c
// picklist (CLAUDE.md audit item #13). A new picklist value not listed here
// falls to Job until added.
const OPP_TYPE_CATEGORY = {
  // --- Job (generic install / system project types) ---
  'A/V': 'Job', 'Access': 'Job', 'CCTV': 'Job', 'Communications': 'Job',
  'Energy Controls': 'Job', 'Fire': 'Job', 'Nurse Call - Area of Rescue': 'Job',
  'Security': 'Job',
  // --- Service Call (field service visits on a system) ---
  'Service - Access': 'Service Call', 'Service - CCTV': 'Service Call',
  'Service - Fire': 'Service Call', 'Service - Security': 'Service Call',
  'Service/Equipment': 'Service Call', 'Service/Monitoring': 'Service Call',
  // --- Test & Inspection ---
  'Test & Inspection': 'Test & Inspection', 'Inspections and Fees': 'Test & Inspection',
  // --- Monitoring (excluded from the board, categorized for completeness) ---
  'Monitoring': 'Monitoring',
  // --- Other (contract / revenue / misc - not a field visit) ---
  'Service Agreement': 'Other', 'Service Revenue': 'Other',
  'Software upgrade/ service accessory': 'Other', 'Other': 'Other',
};
function jobCategory(job) {
  const rt = RECORD_TYPE_LABELS[job.recordType];
  if (rt) return rt;                                        // real record type wins
  return OPP_TYPE_CATEGORY[job.opportunityType] || 'Job';   // else explicit map, default Job
}

// Display label for a subtype inside the Type filter's submenu. Service Call
// subtypes strip the redundant "Service - " / "Service/" prefix so they read
// like the Job submenu (Fire, Access, Equipment…). Filtering always uses the
// raw opportunityType value, never this cleaned label.
function cleanSubLabel(category, opportunityType) {
  if (!opportunityType) return opportunityType;
  if (category === 'Service Call') return opportunityType.replace(/^Service\s*[-/]\s*/i, '');
  return opportunityType;
}

// Stable left-to-right order for the Type menu's categories.
const TYPE_CATEGORY_ORDER = ['Job', 'Service Call', 'Test & Inspection', 'Other'];

// =====================================================================
//  FS drift badge - EDIT ME
//  Maps each dispatch status to the set of raw FS statuses that are NOT a
//  contradiction for it - i.e. FS is either already in agreement or in an
//  expected transient state on the way there. Any FS status not listed for the
//  job's current status is flagged red.
//
//  Per record type: a job's status now lives in a different field depending on
//  its Opportunity record type, so the compatible-set is keyed by record type
//  too. Legacy / Job / Work_Order jobs ride Project_Status__c and use BASE;
//  Service Call uses Service_Status__c values, Test & Inspection uses StageName
//  values. compatTableFor(job.recordType) picks the table.
//
//  Keep in sync BY HAND with server/src/statusMap.js (FS_COMPAT_BASE /
//  FS_STATUS_COMPATIBLE_BY_TYPE) - CLAUDE.md audit item #4. Comparison-only:
//  never drives a write to SF or FS.
//
//  Example (confirmed): dispatch status "Installation Completed" with FS
//  status "Entered" → "Entered" isn't in BASE's list → red.
// =====================================================================
const FS_COMPAT_BASE = { // Project_Status__c - null / Default / Job / Work_Order
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

const compatTableFor = (recordType) =>
  FS_STATUS_COMPATIBLE_BY_TYPE[recordType] || FS_COMPAT_BASE;

// FS statuses with no dispatch-side equivalent at all (see FS_TO_SF nulls in
// statusMap.js). There's nothing on our side for these to agree/disagree
// with, so they default to non-contradictory. Set to `true` to flag them red
// instead.
const FS_NO_EQUIVALENT = new Set(['In-review', 'Warranty']);
const FS_NO_EQUIVALENT_IS_CONTRADICTION = false;

// Compares a job's dispatch status against its raw FS status snapshot.
// Returns null when there's nothing to compare yet (unlinked, or FS sync
// hasn't stamped a snapshot).
function fsDriftInfo(job) {
  if (!job.fsTaskId || !job.fsStatus) return null;

  const compatible = compatTableFor(job.recordType)[job.status];
  const contradicts = FS_NO_EQUIVALENT.has(job.fsStatus)
    ? FS_NO_EQUIVALENT_IS_CONTRADICTION
    : !(compatible && compatible.includes(job.fsStatus));

  return { level: contradicts ? 'contradiction' : 'agree' };
}

// Small read-only badge showing FS's own reported status next to the primary
// dispatch status. Color communicates drift (see fsDriftInfo above), not the
// raw FS value itself. If the job isn't linked at all, the existing fs-badge
// (⬡ Attach FS) is a separate action affordance for the unlinked case; this
// badge instead states the FS-connection state plainly for every job.
function FsDriftBadge({ job }) {
  if (!job.fsTaskId) {
    return (
      <span className="fs-drift-badge fs-drift-disconnected" title="No Field Squared task linked">
        FS Disconnected
      </span>
    );
  }

  if (!job.fsStatus) {
    return (
      <span className="fs-drift-badge fs-drift-pending" title="Linked to Field Squared, but no status has synced yet">
        FS Pending
      </span>
    );
  }

  const drift = fsDriftInfo(job);
  const title = `Field Squared status: ${job.fsStatus}${job.fsLastModified ? ` · FS updated ${fmtDateTime(job.fsLastModified)}` : ''}`;
  return (
    <span className={`fs-drift-badge fs-drift-${drift.level}`} title={title}>
      FS Status: {job.fsStatus}
    </span>
  );
}

const POLL_MS = 5 * 60 * 1000; // refresh from Salesforce every 5 minutes

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[a.length][b.length];
}

function fuzzyNameMatch(query, name) {
  const q = query.toLowerCase().trim();
  const n = name.toLowerCase();
  if (!q) return true;
  if (n.includes(q)) return true;
  const qTokens = q.split(/\s+/).filter(Boolean);
  const nTokens = n.split(/\s+/).filter(Boolean);
  return qTokens.every((qt) => {
    if (nTokens.some((nt) => nt.includes(qt))) return true;
    const maxDist = qt.length >= 5 ? 2 : qt.length >= 3 ? 1 : 0;
    return nTokens.some((nt) => levenshtein(qt, nt) <= maxDist);
  });
}

// Wraps the first case-insensitive occurrence of `query` inside `text` in a
// <mark> so a dispatcher can see why a row matched a name/address search.
function highlightMatch(text, query) {
  if (!text) return text;
  const q = query.trim();
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="search-hl">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

// Statuses that auto-advance to "Scheduled" the moment a job is given a date.
// (Already-advanced statuses like In Progress are left alone.)
const PRE_SCHEDULED = ['Quoted', 'Parts ordered', 'Ready to be scheduled'];

// ---- date helpers (all local-time, no UTC drift) ----
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = (d) => { const x = startOfDay(d); x.setDate(x.getDate() - x.getDay()); return x; }; // Sunday start
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateOnlyISO = (iso) => iso && typeof iso === 'string' ? iso.slice(0, 10) : null;
const initials = (name) => name ? name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() : '?';

// Base = the org's My Domain (matches SF_LOGIN_URL in wrangler.toml). Salesforce
// resolves `${base}/${id}` to the record and redirects to Lightning. Hardcoded so
// links are available at first render with no config fetch; swap to a /api/config
// endpoint if the org URL ever changes.
const SF_BASE = 'https://crsbuilding.my.salesforce.com';
const oppUrl = (id) => `${SF_BASE}/${id}`;
// Renders an Opportunity name as a link that opens the SF record in a new tab.
// Falls back to plain text when there's no id (guards non-opportunity titles).
// stopPropagation so clicking the name inside an already-clickable row/chip opens
// Salesforce without also triggering the row's own click (modal/toggle).
function OppLink({ id, name, className, style }) {
  if (!id) return <span className={className} style={style}>{name}</span>;
  return (
    <a className={`opp-link ${className || ''}`} style={style} href={oppUrl(id)}
       target="_blank" rel="noopener noreferrer"
       onClick={(e) => { e.stopPropagation(); trackUsage('opp_link_click', { oppId: id }); }}>
      {name}
    </a>
  );
}

// Shared loading indicator -- three bouncing dots, optionally with a label.
// Used app-wide in place of plain "Loading…" text (see styles.css's
// .loading-dots-* rules). `inline` drops the block padding/centering so it
// can sit inside a button or a tight row (e.g. a modal's "Next" button while
// its data loads) instead of standing alone as a full loading state.
function LoadingDots({ label, inline }) {
  return (
    <span className={`loading-dots-wrap ${inline ? 'loading-dots-inline' : 'loading-dots-block'}`}>
      {label && <span className="loading-dots-label">{label}</span>}
      <span className="loading-dots" aria-hidden="true"><span /><span /><span /></span>
    </span>
  );
}
const startOfYear = (d) => { const x = startOfDay(d); x.setMonth(0, 1); return x; };
const startOfMonth = (d) => { const x = startOfDay(d); x.setDate(1); return x; };
const startOfPreviousMonth = (d) => { const x = startOfMonth(d); x.setMonth(x.getMonth() - 1); return x; };
const todayIso = () => new Date().toISOString().slice(0, 10);

function formatPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '').slice(0, 10);
  if (!digits) return '';
  if (digits.length <= 3) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function fmtDate(iso) {
  if (!iso) return null;
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fmtCurrency(n) {
  if (n == null) return null;
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

function fmtAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `synced ${s}s ago`;
  return `synced ${Math.floor(s / 60)}m ago`;
}

// Average time-on-screen, ms -> "45s" / "2m 14s" / "1h 05m". null/NaN (no
// screen_view_end data yet for that screen) renders as "-", not "0s" -- an
// absence of data isn't the same as an instant view.
function fmtDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return null;
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function nextScheduledAssignmentDate(job) {
  const dates = (job.assignments || [])
    .filter((a) => a.workDate && !a.completed)
    .map((a) => a.workDate)
    .sort();
  return dates[0] || '';
}

function deriveJobStatusFromAssignments(job) {
  const nextDate = nextScheduledAssignmentDate(job);
  if (nextDate) return { status: SCHEDULED_STATUS, scheduledDate: nextDate };
  return { status: queueStatusFor(job.recordType), scheduledDate: '' };
}

// Ticks once a second on its own - kept out of App so the "synced Xs ago"
// display doesn't force a full-tree re-render of every job card every second.
function SyncedAgo({ lastSync }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="ago">{lastSync ? fmtAgo(now - lastSync) : '…'}</span>;
}

// Wrapped in React.memo so typing/ticking elsewhere in App doesn't re-render
// every job card - only the ones whose own props actually changed. That only
// works because every handler prop below is stabilized with useCallback in
// App, and fsLinkForJob/pendingAddForJob collapse to `null` for every row
// except the one with a panel open (see the .map() call site in App).
const JobCard = React.memo(function JobCard({
  job, readOnly, techs, fsLinkForJob, pendingAddForJob, jobNotes, onOpenNote, onDeleteNote,
  onToggleDone, onAssignmentDateChange, onAssignmentTimeChange, onAssignmentEndTimeChange, onUnassign, onAssign,
  onSetStatus, onOpenFsLink, onCloseFsLink, onFsLinkChange, onPendingAddChange,
  onSearchFs, onConfirmFsLink,
}) {
  // Local, self-contained state -- this modal's visibility never needs to
  // coordinate with sibling JobCards the way the FS-attach panel does, so it
  // doesn't need to live in the parent's prop-drilled state. Declared before
  // the readOnly early return so the hook order stays consistent across both
  // branches below.
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  // Mobile-only collapse (styles.css hides .job-collapsible below 768px
  // unless this is true) -- desktop is unaffected, everything always shows
  // there regardless of this value.
  const [expanded, setExpanded] = useState(false);
  // Local, bottom-fixed warning (same .toast styling used app-wide) instead
  // of a native alert() -- the default browser dialog interrupts at the top
  // of the page and needs a manual dismiss; this matches how every other
  // transient message in this app already behaves.
  const [invoiceWarn, setInvoiceWarn] = useState(null);
  const flashInvoiceWarn = (msg) => { setInvoiceWarn(msg); setTimeout(() => setInvoiceWarn(null), 2600); };
  const invoiceBtn = (
    <button
      type="button"
      className={`fs-badge inv-badge job-row-invoice-btn${job.fsTaskId ? '' : ' inv-badge-nofs'}`}
      title={job.fsTaskId ? 'Draft an invoice from Field Squared completion data' : 'Field Squared must be attached to this job before an invoice can be drafted'}
      onClick={() => job.fsTaskId ? setShowInvoiceModal(true) : flashInvoiceWarn('Field Squared must be attached to this job before an invoice can be drafted.')}
    >+ Invoice</button>
  );
  const invoiceModal = showInvoiceModal && (
    <CreateInvoiceModal job={job} onClose={() => setShowInvoiceModal(false)} />
  );
  const invoiceWarnToast = invoiceWarn && <div className="toast">{invoiceWarn}</div>;

  if (readOnly) {
    return (
      <div className="job ro">
        <div className="stripe" data-status={statusClass(job.status)} />
        <div className="body">
          <div className="row1">
            <OppLink className="jname" id={job.id} name={job.name} />
            {job.lid && <span className="lidtag">LID {job.lid}</span>}
            {job.fsTaskId
              ? <span className="fs-badge linked" title={`FS task: ${job.fsTaskId}`}>⬡ FS</span>
              : <span className="fs-badge unlinked" title="No Field Squared task linked">⬡ FS</span>}
            <FsDriftBadge job={job} />
            <span className={`badge ${statusClass(job.status)}`}>{job.status}</span>
            {invoiceBtn}
            {jobNotes?.length > 0 && <JobNotesBadge notes={jobNotes} onOpenNote={onOpenNote} onDeleteNote={onDeleteNote} />}
            {/* Mobile-only (styles.css) -- desktop always shows everything
                below already, this toggle is a no-op there. Per direction
                2026-08-28: show just the name/status "top part" of a job
                card by default on a phone, expand for the rest on tap. */}
            <button type="button" className="job-expand-toggle" onClick={() => setExpanded((e) => !e)} aria-label={expanded ? 'Collapse job details' : 'Expand job details'} aria-expanded={expanded}>
              <span className="job-expand-chevron">{expanded ? '▾' : '▸'}</span>
            </button>
          </div>
          <div className={`job-collapsible ${expanded ? 'expanded' : ''}`}>
            <div className="job-collapsible-inner">
              <div className="meta">
                <span><span className="ic">◍</span>{job.address || 'No address'}</span>
                {job.closeDate && <span className="created">Close Date {fmtDate(job.closeDate)}</span>}
                {job.scheduledDate && <span className="created">Scheduled {fmtDate(job.scheduledDate)}</span>}
              </div>
              {job.assignments.length > 0 && (
                <div className="rotechs">
                  {job.assignments.map((a) => (
                    <span className="rotech" key={a.assignmentId}>
                      {a.completed ? '✓ ' : ''}{a.technicianName}{a.workDate ? ` · ${fmtDate(a.workDate)}` : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        {invoiceModal}
        {invoiceWarnToast}
      </div>
    );
  }

  const fsOpen = !!fsLinkForJob;

  return (
    <div className="job">
      <div className="stripe" data-status={statusClass(job.status)} />
      <div className="body">
        <div className="row1">
          <OppLink className="jname" id={job.id} name={job.name} />
          {job.lid && <span className="lidtag">LID {job.lid}</span>}
          {job.fsTaskId
            ? <span className="fs-badge linked" title={`FS task: ${job.fsTaskId}`}>⬡ FS</span>
            : <button className="fs-badge unlinked fs-attach-btn" title="Attach Field Squared job" onClick={() => fsOpen ? onCloseFsLink() : onOpenFsLink(job.id)}>⬡ Attach FS</button>}
          <FsDriftBadge job={job} />
          <FilterSelect
            value={job.status}
            onChange={(v) => onSetStatus(job, v)}
            options={[
              ...(!assignableStatusesFor(job.recordType).includes(job.status) ? [[job.status, job.status]] : []),
              ...assignableStatusesFor(job.recordType).map((s) => [s, s]),
            ]}
            triggerClassName={`statussel-pill job-row-status ${statusClass(job.status)}`}
            ariaLabel="Job status"
          />
          {invoiceBtn}
          {jobNotes?.length > 0 && <JobNotesBadge notes={jobNotes} onOpenNote={onOpenNote} onDeleteNote={onDeleteNote} />}
          {/* Mobile-only (styles.css) -- see the readOnly branch above for
              the full reasoning. The FS-attach panel below is deliberately
              kept OUTSIDE .job-collapsible -- it's rendered from a user just
              tapping "Attach FS" in this same row, so it must stay visible
              regardless of collapse state or that tap would silently appear
              to do nothing. */}
          <button type="button" className="job-expand-toggle" onClick={() => setExpanded((e) => !e)} aria-label={expanded ? 'Collapse job details' : 'Expand job details'} aria-expanded={expanded}>
            <span className="job-expand-chevron">{expanded ? '▾' : '▸'}</span>
          </button>
        </div>
        {fsOpen && (
          <div className="fs-attach-panel">
            <div className="fs-attach-header">
              <span className="fs-attach-title">Search Field Squared</span>
              <button className="fs-attach-close" onClick={onCloseFsLink} aria-label="Close">×</button>
            </div>
            <div className="fs-attach-row">
              <input
                className="fs-attach-input"
                type="text"
                placeholder="Type part of the FS job name…"
                value={fsLinkForJob.query}
                onChange={(e) => onFsLinkChange((s) => ({ ...s, query: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && onSearchFs(fsLinkForJob.query)}
                autoFocus
              />
              <button className="fs-btn-search" onClick={() => onSearchFs(fsLinkForJob.query)} disabled={fsLinkForJob.searching || fsLinkForJob.query.trim().length < 3}>
                {fsLinkForJob.searching ? '…' : 'Search'}
              </button>
            </div>
            {fsLinkForJob.error && <div className="fs-attach-error">{fsLinkForJob.error}</div>}
            {fsLinkForJob.matches !== null && fsLinkForJob.matches.length === 0 && (
              <div className="fs-attach-empty">No FS tasks found with that name.</div>
            )}
            {fsLinkForJob.matches && fsLinkForJob.matches.map((m) => (
              <div className="fs-attach-result" key={m.externalId}>
                <div className="fs-result-info">
                  <div className="fs-result-name">{m.name}</div>
                  <div className="fs-result-meta">{m.taskType} · {m.status}</div>
                </div>
                <button className="fs-btn-link" onClick={() => onConfirmFsLink(job.id, m.externalId, m.name)}>Link</button>
              </div>
            ))}
          </div>
        )}
        <div className={`job-collapsible ${expanded ? 'expanded' : ''}`}>
        <div className="job-collapsible-inner">
        {/* Mobile-only duplicate of the .row1 status control (hidden there
            via .job-row-status on mobile, styles.css) -- per direction
            2026-08-28, the top status *filter* dropdown only narrows the
            list, it was never a way to *change* an individual job's status,
            so hiding the per-row control on mobile with nothing replacing
            it left no way to edit status from a phone at all. Same
            dual-instance pattern already used for .filters-desktop/
            .filters-mobile: render both, let CSS show the right one per
            breakpoint, rather than trying to relocate one DOM node between
            two different parents. Desktop hides this copy (.job-collapsible-
            status, styles.css) since .row1's version already covers it
            there. */}
        <div className="job-collapsible-status-row">
          <FilterSelect
            value={job.status}
            onChange={(v) => onSetStatus(job, v)}
            options={[
              ...(!assignableStatusesFor(job.recordType).includes(job.status) ? [[job.status, job.status]] : []),
              ...assignableStatusesFor(job.recordType).map((s) => [s, s]),
            ]}
            triggerClassName={`statussel-pill job-collapsible-status ${statusClass(job.status)}`}
            ariaLabel="Job status"
          />
        </div>
        <div className="meta">
          <span><span className="ic">◍</span>{job.address || 'No address'}</span>
          {job.closeDate && <span className="created">Close Date {fmtDate(job.closeDate)}</span>}
          <span className="nextlabel">Next scheduled</span>
          <span className="dateinput ro" title="Next scheduled assignment date">
            {nextScheduledAssignmentDate(job) ? fmtDate(nextScheduledAssignmentDate(job)) : '-'}
          </span>
          {nextScheduledAssignmentDate(job)
            ? <span className="created">Scheduled {fmtDate(nextScheduledAssignmentDate(job))}</span>
            : <span className="unsched-tag">None</span>}
        </div>
        <div className="assignlist">
          {job.assignments.length === 0 && <span className="unassigned-tag">No techs assigned</span>}
          {job.assignments.map((a) => {
            const cls = a.completed ? 'done' : (!a.workDate ? 'unscheduled' : '');
            return (
              <div className={`assignrow ${cls}`} key={a.assignmentId}>
                <button
                  className="check"
                  onClick={() => onToggleDone(job, a)}
                  title={a.completed ? 'Worked this day - click to reopen' : 'Mark as worked (freezes the date)'}
                  aria-label="Toggle done"
                >{a.completed ? '✓' : '○'}</button>
                <span className="aname">{a.technicianName || 'Tech'}</span>
                <DatePicker className="dp-adate" value={a.workDate || ''} onChange={(v) => onAssignmentDateChange(job, a, v)} placeholder="Date" />
                <TimePicker
                  className="atime"
                  value={a.startTime || '07:00'}
                  onChange={(v) => onAssignmentTimeChange(job, a, v)}
                  title="Start time"
                  disabled={a.completed}
                />
                <TimePicker
                  className="atime"
                  value={a.endTime || ''}
                  onChange={(v) => onAssignmentEndTimeChange(job, a, v)}
                  title="End time"
                  placeholder="End"
                  disabled={a.completed}
                  clearable
                />
                {!a.workDate && !a.completed && <span className="untag">unscheduled</span>}
                <button className="x" onClick={() => onUnassign(job, a.assignmentId)} aria-label="Remove">×</button>
              </div>
            );
          })}
          <div>
            <TechMultiSelect
              techs={techs}
              value={pendingAddForJob?.techIds || []}
              onChange={(next) => {
                if (next.length === 0) { onPendingAddChange({ jobId: null, techIds: [], dates: [], time: '', endTime: '' }); return; }
                onPendingAddChange((p) => (p && p.jobId === job.id)
                  ? { ...p, techIds: next }
                  : { jobId: job.id, techIds: next, dates: job.scheduledDate ? [job.scheduledDate] : [], time: '', endTime: '' });
              }}
            />
            {pendingAddForJob && pendingAddForJob.techIds.length > 0 && (
              <div className="inline-add">
                <MultiDatePicker className="dp-adate" value={pendingAddForJob.dates} onChange={(v) => onPendingAddChange((p) => ({ ...p, dates: v }))} placeholder="Date(s)" />
                <TimePicker
                  className="atime"
                  value={pendingAddForJob.time || '07:00'}
                  onChange={(v) => onPendingAddChange((p) => ({ ...p, time: v }))}
                  title="Start time"
                  quickPicks={deriveTimeQuickPicks(job.assignments)}
                />
                <TimePicker
                  className="atime"
                  value={pendingAddForJob.endTime || ''}
                  onChange={(v) => onPendingAddChange((p) => ({ ...p, endTime: v }))}
                  title="End time (required)"
                  placeholder="End"
                />
                <button
                  className="add-btn"
                  disabled={!pendingAddForJob.endTime}
                  title={!pendingAddForJob.endTime ? 'Pick an end time first' : undefined}
                  onClick={async () => {
                    const { techIds, dates, time, endTime } = pendingAddForJob;
                    onPendingAddChange({ jobId: null, techIds: [], dates: [], time: '', endTime: '' });
                    // One Job_Assignment__c per (tech × selected day) -- chained
                    // sequentially so each call builds on the job state the
                    // previous call returned, rather than re-adding onto a stale
                    // snapshot and dropping earlier creates.
                    let current = job;
                    for (const techId of techIds) {
                      for (const d of dates.length ? dates : ['']) {
                        current = await onAssign(current, techId, d, time || '07:00', endTime);
                      }
                    }
                  }}
                >Add</button>
                <button className="cancel-btn" onClick={() => onPendingAddChange({ jobId: null, techIds: [], dates: [], time: '', endTime: '' })}>Cancel</button>
              </div>
            )}
          </div>
        </div>
        </div>
        </div>
      </div>
      {invoiceModal}
      {invoiceWarnToast}
    </div>
  );
});

// Thin auth wrapper: the real app (DispatchApp, with all its data-loading
// hooks) only MOUNTS once there's a session, so no API call ever fires
// pre-login and hits the 401 gate. Logging in swaps the login screen for the
// app cleanly; logging out unmounts it.
export default function App() {
  const [user, setUser] = useState(() => getUser());
  if (!user) return <DispatchLogin onLoggedIn={() => setUser(getUser())} />;
  return <DispatchApp user={user} onLoggedOut={() => { authLogout(); setUser(null); }} />;
}

function DispatchApp({ user, onLoggedOut }) {
  const [accountOpen, setAccountOpen] = useState(false);
  const [officeUsersOpen, setOfficeUsersOpen] = useState(false);
  const [usageRefresh, setUsageRefresh] = useState(0);
  const [tab, setTab] = useState(() => loadViewState().tab ?? 'jobs');
  // Usage analytics: record which tab (screen) is viewed, plus how long it
  // was actually visible before switching to a different in-app tab or
  // navigating/backgrounding away from the browser tab entirely -- per
  // direction 2026-08-27. "Visible" specifically, not wall-clock: if the
  // browser tab is backgrounded and later refocused on the same in-app
  // screen, that starts a fresh viewing stretch rather than resuming the
  // old one, so a stretch's duration never counts time the screen genuinely
  // wasn't on screen. screen_view_end carries durationMs; screen_view itself
  // is untouched so existing view-count analytics don't shift.
  //
  // Idle timeout added 2026-08-27 -- found live: a real "Viewed quotes for
  // 19m 57s" that the person watching it never actually spent 20 minutes
  // on. Root cause: the Page Visibility API only knows the browser TAB lost
  // focus, not that the person stopped paying attention -- if that tab just
  // sits frontmost while they're away from the keyboard (a call, stepped
  // away, alt-tabbed to something that didn't actually background the
  // browser), visibilitychange never fires and the clock just keeps
  // running. Real interaction (mouse move/click, keypress, scroll, touch)
  // now resets an activity timestamp; if IDLE_TIMEOUT_MS passes with none,
  // the stretch is flushed at the LAST real interaction, not "whenever we
  // happened to notice" -- so an idle gap never gets counted as viewing
  // time, however long it runs on before something else (a tab switch,
  // visibilitychange) would otherwise have closed it out.
  const IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes with no interaction = "stepped away"
  const screenViewStartRef = useRef(null);
  const lastActivityRef = useRef(Date.now());
  useEffect(() => {
    const now = Date.now();
    trackUsage('screen_view', null, tab);
    screenViewStartRef.current = now;
    lastActivityRef.current = now;

    // endTime defaults to "right now" for tab-switch/hidden/unload closes,
    // where the moment we're flushing IS the moment it ended. The idle
    // check below is the one caller that passes something else -- the
    // timestamp of the last real interaction, since by the time the idle
    // check notices, real time has already moved past when it actually
    // ended.
    const flushDuration = (endTime = Date.now()) => {
      if (screenViewStartRef.current == null) return;
      const durationMs = Math.max(0, endTime - screenViewStartRef.current);
      trackUsage('screen_view_end', { durationMs }, tab);
      screenViewStartRef.current = null;
    };
    // Never passed directly as a raw DOM event listener (a PageTransitionEvent
    // as `endTime` would silently NaN the duration) -- always wrapped in a
    // no-arg arrow below.
    const onPageHide = () => flushDuration();
    const onVisibility = () => {
      if (document.hidden) flushDuration();
      else { screenViewStartRef.current = Date.now(); lastActivityRef.current = Date.now(); }
    };
    const onActivity = () => {
      lastActivityRef.current = Date.now();
      // Resuming after an idle-timeout flush (still visible the whole
      // time, just inactive) -- start a fresh stretch rather than staying
      // permanently closed out until the next tab/visibility change.
      if (screenViewStartRef.current == null && !document.hidden) screenViewStartRef.current = Date.now();
    };
    const idleCheck = setInterval(() => {
      if (screenViewStartRef.current != null && Date.now() - lastActivityRef.current >= IDLE_TIMEOUT_MS) {
        flushDuration(lastActivityRef.current);
      }
    }, 30 * 1000);

    const activityEvents = ['mousemove', 'mousedown', 'keydown', 'touchstart'];
    activityEvents.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }));
    window.addEventListener('scroll', onActivity, { passive: true, capture: true });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);

    return () => {
      flushDuration();
      clearInterval(idleCheck);
      activityEvents.forEach((ev) => window.removeEventListener(ev, onActivity));
      window.removeEventListener('scroll', onActivity, { capture: true });
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [tab]);
  const [jobs, setJobs] = useState([]);
  const [techs, setTechs] = useState([]);
  const [notes, setNotes] = useState([]);
  const [editingNote, setEditingNote] = useState(null);
  const [filter, setFilter] = useState(() => loadViewState().filter ?? 'all');
  const [query, setQuery] = useState(() => loadViewState().query ?? '');
  const [closedFrom, setClosedFrom] = useState(() => loadViewState().closedFrom ?? '');
  const [closedTo, setClosedTo] = useState(() => loadViewState().closedTo ?? '');
  const [sortBy, setSortBy] = useState(() => loadViewState().sortBy ?? 'scheduled');
  const [jobTech, setJobTech] = useState(() => loadViewState().jobTech ?? 'all');
  const [jobType, setJobType] = useState(() => loadViewState().jobType ?? 'all');
  const [jobFsStatus, setJobFsStatus] = useState(() => loadViewState().jobFsStatus ?? 'all');
  // Infinite scroll on the jobs list - only the first `visibleCount` of `shown`
  // are ever mounted. Everything's already loaded client-side (no server paging),
  // so "loading more" just raises this cap; no extra fetch involved.
  const [visibleCount, setVisibleCount] = useState(50);
  const [extraJobs, setExtraJobs] = useState([]);   // jobs fetched for a terminal-status filter
  const [extraLoading, setExtraLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [lastSync, setLastSync] = useState(null);
  const [pendingAdd, setPendingAdd] = useState({ jobId: null, techIds: [], dates: [], time: '', endTime: '' });
  const [selectedJobId, setSelectedJobId] = useState(null);
  const [fsLink, setFsLink] = useState({ jobId: null, query: '', searching: false, matches: null, error: null });
  const [draftJob, setDraftJob] = useState(null);
  const [draftPendingAdd, setDraftPendingAdd] = useState({ techIds: [], date: '', time: '', endTime: '' });
  const [contacts, setContacts] = useState([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactsLoaded, setContactsLoaded] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [quotes, setQuotes] = useState([]);
  const [quotesLoading, setQuotesLoading] = useState(false);
  // 'needs' (Project_Status__c = Needs Quote) or 'sent' (Quote_Sent__c checked)
  // -- different SOQL filters, so a view change re-fetches. quotesLoadedView
  // tracks which one `quotes` currently holds, same lazy-once idea as
  // contactsLoaded/accountsLoaded but keyed by view instead of a plain bool.
  const [quotesView, setQuotesView] = useState('needs');
  const [quotesLoadedView, setQuotesLoadedView] = useState(null);
  const [emailUsers, setEmailUsers] = useState([]);
  const [emailUsersLoaded, setEmailUsersLoaded] = useState(false);
  const [scheduleRequests, setScheduleRequests] = useState([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  // Resolved (Approved/Denied/Withdrawn) history -- deliberately not part of
  // the default Requests view, and fetched only once the "Previous
  // requests" section is actually opened (same lazy-on-first-open pattern
  // as contactsLoaded), so nobody pays for this query until they ask for it.
  const [previousRequests, setPreviousRequests] = useState([]);
  const [previousRequestsLoading, setPreviousRequestsLoading] = useState(false);
  const [previousRequestsLoaded, setPreviousRequestsLoaded] = useState(false);
  const [manageTechsOpen, setManageTechsOpen] = useState(false);
  const [inventoryGroups, setInventoryGroups] = useState([]);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryLoaded, setInventoryLoaded] = useState(false);
  const [catalog, setCatalog] = useState([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [serviceStock, setServiceStock] = useState(null);       // {id, name}
  const [serviceStockLoaded, setServiceStockLoaded] = useState(false);

  useEffect(() => {
    localStorage.setItem(VIEW_STATE_KEY, JSON.stringify({
      tab, filter, query, closedFrom, closedTo, sortBy, jobTech, jobType, jobFsStatus,
    }));
  }, [tab, filter, query, closedFrom, closedTo, sortBy, jobTech, jobType, jobFsStatus]);

  // Count of in-flight writes. While > 0 the poll holds off so a background
  // refresh can't overwrite a change you just made but that hasn't saved yet.
  const pending = useRef(0);

  // Infinite-scroll sentinel ref - the observer effect lives further down,
  // after `shown` is computed (it needs shown.length to know when to re-attach).
  const scrollSentinelRef = useRef(null);

  // Kept separate from `load` (below) so a notes-only refresh -- e.g. the
  // Notes menu re-pulling on open, or after saving/deleting a note -- doesn't
  // need to also re-fetch jobs/techs. Errors are swallowed (console-only,
  // same fire-and-forget convention as notifyTech) rather than surfaced via
  // the board's main `error` state -- notes are ancillary, and a failure here
  // shouldn't take down the primary jobs list UI.
  const loadNotes = useCallback(async () => {
    try {
      setNotes(await api.getNotes());
    } catch (e) {
      console.error('[notes] load failed', e);
    }
  }, []);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [j, t] = await Promise.all([api.getJobs(), api.getTechnicians()]);
      setJobs(j);
      setTechs(t);
      setLastSync(Date.now());
    } catch (e) {
      setError(e.message);
    } finally {
      if (!silent) setLoading(false);
    }
    loadNotes();
  }, [loadNotes]);

  useEffect(() => { load(); }, [load]);

  // Job-specific notes (Opportunity_Specific__c) grouped by opportunity, for
  // the per-job notes badge on each job card. General (non-job) notes are
  // left out -- those only ever show in the header Notes menu.
  const notesByJobId = useMemo(() => {
    const m = new Map();
    for (const n of notes) {
      if (!n.opportunitySpecific || !n.opportunityId) continue;
      if (!m.has(n.opportunityId)) m.set(n.opportunityId, []);
      m.get(n.opportunityId).push(n);
    }
    return m;
  }, [notes]);

  // Single shared NoteEditModal instance -- both the header Notes menu and
  // each job card's notes badge open the same note-editing flow through this
  // one piece of state, rather than each owning its own modal.
  const openNewNote = useCallback((opportunityId, opportunityName) => {
    setEditingNote({ id: null, text: '', opportunityId: opportunityId || null, opportunityName: opportunityName || null, isNew: true });
  }, []);
  const openNote = useCallback((note) => { setEditingNote({ ...note, isNew: false }); }, []);
  const afterNoteChange = useCallback(() => { setEditingNote(null); loadNotes(); }, [loadNotes]);
  // Quick-delete straight from a notes popup (no confirm dialog, matching
  // NoteEditModal's own Delete button) -- doesn't touch editingNote since
  // this never goes through the modal.
  const deleteNote = useCallback(async (id) => {
    try {
      await api.removeNote(id);
      loadNotes();
    } catch (e) {
      alert(`Could not delete note: ${e.message}`);
    }
  }, [loadNotes]);

  useEffect(() => {
    if (closedFrom && !closedTo) {
      setClosedTo(todayIso());
    }
  }, [closedFrom, closedTo]);

  // A new search/filter is a new list - start from the top rather than keeping
  // whatever scroll depth was reached under the previous one.
  useEffect(() => {
    setVisibleCount(50);
  }, [query, filter, jobTech, jobType, jobFsStatus, closedFrom, closedTo, sortBy]);

  // Paused while the tab is backgrounded -- polling every 5 minutes
  // regardless of visibility means every idle/minimized staff tab still
  // bills a request pair on schedule. Regaining visibility refetches
  // immediately instead of waiting out whatever's left of the current tick.
  useEffect(() => {
    const tick = () => { if (pending.current === 0 && document.visibilityState === 'visible') load(true); };
    const id = setInterval(tick, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  useEffect(() => {
    if (!selectedJobId) return;
    const onKey = (e) => { if (e.key === 'Escape') setSelectedJobId(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selectedJobId]);

  // Snapshot the job into draftJob when the modal opens; don't re-init on every jobs update.
  useEffect(() => {
    if (selectedJobId) {
      const job = jobs.find((j) => j.id === selectedJobId);
      if (job) {
        setDraftJob(JSON.parse(JSON.stringify(job)));
        // Fires once per open (this effect only re-runs when selectedJobId
        // itself changes, not on every background `jobs` refresh) -- per
        // direction 2026-08-27: this is the one place a job gets expanded
        // to view from the calendar, so it's the single insertion point
        // that covers every real "opened this job" click app-wide.
        trackUsage('job_detail_open', { jobId: job.id, recordType: job.recordType ?? null });
      }
    } else {
      setDraftJob(null);
      setDraftPendingAdd({ techIds: [], date: '', time: '', endTime: '' });
    }
  }, [selectedJobId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Also loaded for the Accounts tab, not just Contacts - its "Change
    // contact" picker needs the same contact directory ContactsTab uses.
    if ((tab !== 'contacts' && tab !== 'accounts') || contactsLoaded) return;
    setContactsLoading(true);
    api.getContacts()
      .then((c) => { setContacts(c); setContactsLoaded(true); })
      .catch((e) => flash(`Contacts error: ${e.message}`))
      .finally(() => setContactsLoading(false));
  }, [tab, contactsLoaded]);

  const updateContact = useCallback(async (contactId, fields) => {
    setContacts((prev) => prev.map((c) => c.id === contactId ? { ...c, ...fields } : c));
    await api.updateContact(contactId, fields);
  }, []);

  useEffect(() => {
    // Also loaded for the Contacts tab, not just Accounts -- ContactInfoModal's
    // account-reassignment picker (opened from Contacts' own Edit button)
    // needs this same list, same reasoning as contacts being shared above.
    if ((tab !== 'accounts' && tab !== 'contacts') || accountsLoaded) return;
    setAccountsLoading(true);
    api.getAccounts()
      .then((a) => { setAccounts(a); setAccountsLoaded(true); })
      .catch((e) => flash(`Accounts error: ${e.message}`))
      .finally(() => setAccountsLoading(false));
  }, [tab, accountsLoaded]);

  const updateAccount = useCallback(async (accountId, fields) => {
    setAccounts((prev) => prev.map((a) => a.id === accountId ? { ...a, ...fields } : a));
    await api.updateAccount(accountId, fields);
  }, []);

  useEffect(() => {
    if (tab !== 'parts' || inventoryLoaded) return;
    setInventoryLoading(true);
    api.getPartsInventory()
      .then((g) => { setInventoryGroups(g); setInventoryLoaded(true); })
      .catch((e) => flash(`Parts error: ${e.message}`))
      .finally(() => setInventoryLoading(false));
  }, [tab, inventoryLoaded]);

  useEffect(() => {
    if (tab !== 'parts' || catalogLoaded) return;
    api.getPartsCatalog().then((p) => { setCatalog(p); setCatalogLoaded(true); }).catch((e) => flash(`Catalog error: ${e.message}`));
  }, [tab, catalogLoaded]);

  useEffect(() => {
    if (tab !== 'parts' || serviceStockLoaded) return;
    api.getServiceStock().then((s) => { setServiceStock(s); setServiceStockLoaded(true); }).catch((e) => flash(`Service Stock error: ${e.message}`));
  }, [tab, serviceStockLoaded]);

  const updateInventoryRow = useCallback(async (rowId, fields) => {
    setInventoryGroups((prev) => prev.map((g) => ({
      ...g, rows: g.rows.map((r) => r.id === rowId ? { ...r, ...fields } : r),
    })));
    await api.updateInventoryRow(rowId, fields);
  }, []);

  const refreshInventory = useCallback(async () => {
    const g = await api.getPartsInventory();
    setInventoryGroups(g);
  }, []);

  useEffect(() => {
    if (tab !== 'quotes' || quotesLoadedView === quotesView) return;
    setQuotesLoading(true);
    api.getQuotes(quotesView === 'needs' ? undefined : quotesView)
      .then((qs) => { setQuotes(qs); setQuotesLoadedView(quotesView); })
      .catch((e) => flash(`Quotes error: ${e.message}`))
      .finally(() => setQuotesLoading(false));
  }, [tab, quotesView, quotesLoadedView]);

  // Re-fetched on every visit (not cached like contacts) - a stale queue defeats
  // the point of a negotiation panel where the office and tech take turns.
  const loadRequests = useCallback(async () => {
    setRequestsLoading(true);
    try {
      const r = await api.getScheduleRequests();
      setScheduleRequests(r);
    } catch (e) {
      flash(`Requests error: ${e.message}`);
    } finally {
      setRequestsLoading(false);
    }
  }, []);

  // Fetched once on first expand, not re-fetched on every visit like
  // loadRequests -- history that's already resolved has no turn-taking
  // pressure keeping it fresh, so there's no reason to re-query it every
  // time the section is opened.
  const loadPreviousRequests = useCallback(async () => {
    setPreviousRequestsLoading(true);
    try {
      const r = await api.getScheduleRequests({ resolved: true });
      setPreviousRequests(r);
      setPreviousRequestsLoaded(true);
    } catch (e) {
      flash(`Previous requests error: ${e.message}`);
    } finally {
      setPreviousRequestsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'requests') loadRequests();
  }, [tab, loadRequests]);

  const approveRequest = async (req, opportunityId) => {
    // Optimistic: an approved request is resolved, so drop it from the open
    // list immediately rather than waiting on the round trip.
    setScheduleRequests((prev) => prev.filter((r) => r.id !== req.id));
    flash(`${req.technicianName || 'Request'} approved`);
    try {
      trackUsage('schedule_approve');
      await track(() => api.approveScheduleRequest(req.id, opportunityId));
      await load(true); // the new assignment shows up on the jobs/schedule tabs
    } catch (e) {
      flash(`Could not approve: ${e.message}`);
      loadRequests();
      throw e;
    }
  };

  const counterRequest = async (req, offer) => {
    // Optimistic: flip the row to "waiting on tech" with the new offer
    // immediately, rather than waiting on a refetch to reflect it.
    setScheduleRequests((prev) => prev.map((r) => r.id === req.id
      ? { ...r, proposedDate: offer.date, proposedStart: offer.start, proposedEnd: offer.end, officeNote: offer.officeNote ?? r.officeNote, waitingOn: 'tech' }
      : r));
    flash('Countered');
    try {
      trackUsage('schedule_counter');
      await track(() => api.counterScheduleRequest(req.id, offer));
    } catch (e) {
      flash(`Could not counter: ${e.message}`);
      loadRequests();
      throw e;
    }
  };

  const denyRequest = async (req, officeNote) => {
    // Optimistic: a denied request is resolved, so drop it from the open
    // list immediately.
    setScheduleRequests((prev) => prev.filter((r) => r.id !== req.id));
    flash('Request denied');
    try {
      trackUsage('schedule_deny');
      await track(() => api.denyScheduleRequest(req.id, officeNote));
    } catch (e) {
      flash(`Could not deny: ${e.message}`);
      loadRequests();
      throw e;
    }
  };

  // Lets ManageTechsModal refresh the app-wide active-tech list (used by
  // every assignment picker) after an add/edit/remove, without pulling in
  // the full load() (which would also re-fetch jobs and flip on the
  // page-wide loading skeleton just for a tech-roster change).
  const refreshTechs = useCallback(async () => {
    try {
      setTechs(await api.getTechnicians());
    } catch (e) {
      flash(`Could not refresh technicians: ${e.message}`);
    }
  }, []);

  // Terminal statuses aren't pulled with the board (could be huge history), so
  // fetch them on demand the moment such a filter is picked.
  useEffect(() => {
    if (!TERMINAL_STATUSES.includes(filter)) { setExtraJobs([]); return; }
    let cancelled = false;
    setExtraLoading(true);
    api.getJobs(filter)
      .then((j) => { if (!cancelled) setExtraJobs(j); })
      .catch(() => { if (!cancelled) setExtraJobs([]); })
      .finally(() => { if (!cancelled) setExtraLoading(false); });
    return () => { cancelled = true; };
  }, [filter]);

  // Stabilized with useCallback (empty deps - they only touch state setters and
  // the pending ref, both stable) so JobCard's React.memo below actually works:
  // an unstable handler prop defeats memoization for every row, not just one.
  const flash = useCallback((msg) => { setToast(msg); setTimeout(() => setToast(null), 2200); }, []);

  // Always re-fetches whichever view (needs/sent) is currently showing
  // afterward, rather than optimistically patching local state -- a status
  // change can move a quote out of (or, since Quote_Sent__c is independent
  // of status, sometimes not out of) the currently-visible filter, and only
  // the server knows which for sure.
  const updateQuoteStatus = useCallback(async (quote, status) => {
    try {
      const result = await api.updateJob(quote.id, { status });
      if (result.fsUpdated) flash('Status updated · FS synced');
      else if (result.fsError) flash(`Salesforce updated · FS error: ${result.fsError}`);
      else flash('Status updated');
    } catch (e) {
      flash(`Could not update: ${e.message}`);
    } finally {
      api.getQuotes(quotesView === 'needs' ? undefined : quotesView).then(setQuotes).catch(() => {});
    }
  }, [flash, quotesView]);

  const loadEmailUsers = useCallback(() => {
    if (emailUsersLoaded) return;
    api.getUsers()
      .then((u) => { setEmailUsers(u); setEmailUsersLoaded(true); })
      .catch((e) => flash(`Couldn't load people: ${e.message}`));
  }, [emailUsersLoaded, flash]);

  // Email goes out FIRST -- the status only moves to Pending Customer
  // Approval if the email actually sends. This is the opposite order (and
  // opposite guarantee) from the rest of this app's write-through convention
  // (SF write lands unconditionally, side effects are best-effort after) --
  // here the status change itself is the thing gated on success, by design,
  // so a failed send never leaves a quote looking like it went to the
  // customer when it didn't.
  const sendQuote = useCallback(async (quote, recipientEmails) => {
    trackUsage('quote_sent');
    try {
      const emailResult = await api.sendQuoteEmail(quote.id, recipientEmails);
      try {
        const result = await api.updateJob(quote.id, { status: 'Pending Customer Approval' });
        if (emailResult.stampError) {
          flash(`Quote sent · Sent_To_Customer__c not updated: ${emailResult.stampError}`);
        } else {
          flash(result.fsUpdated ? 'Quote sent · FS synced · email delivered' : 'Quote sent · email delivered');
        }
      } catch (e) {
        flash(`Email delivered · status NOT updated: ${e.message}`);
      }
    } catch (e) {
      flash(`Email failed, status left unchanged: ${e.message}`);
    } finally {
      api.getQuotes(quotesView === 'needs' ? undefined : quotesView).then(setQuotes).catch(() => {});
    }
  }, [flash, quotesView]);

  // Same email-first/status-second/no-rollback-on-email-failure guarantee as
  // sendQuote above, for the earlier "ready for internal review" stage.
  const reviewQuote = useCallback(async (quote, recipientEmails) => {
    trackUsage('quote_review');
    try {
      const emailResult = await api.sendQuoteReviewEmail(quote.id, recipientEmails);
      try {
        const result = await api.updateJob(quote.id, { status: 'Ready for Review' });
        if (emailResult.stampError) {
          flash(`Review requested · Ready_For_Review__c not updated: ${emailResult.stampError}`);
        } else {
          flash(result.fsUpdated ? 'Review requested · FS synced · email delivered' : 'Review requested · email delivered');
        }
      } catch (e) {
        flash(`Email delivered · status NOT updated: ${e.message}`);
      }
    } catch (e) {
      flash(`Email failed, status left unchanged: ${e.message}`);
    } finally {
      api.getQuotes(quotesView === 'needs' ? undefined : quotesView).then(setQuotes).catch(() => {});
    }
  }, [flash, quotesView]);

  const track = useCallback(async (fn) => {
    pending.current += 1;
    try { return await fn(); }
    finally { pending.current -= 1; }
  }, []);

  // Returns the updated job (or the original on failure) so callers adding
  // several assignments in one go (multi-day pick) can thread the result of
  // one call into the next instead of reusing a stale `job` snapshot - since
  // `updated` below is built by appending onto whatever `job.assignments`
  // was passed in, calling this repeatedly with the same stale `job` would
  // silently drop every add but the last.
  const assign = useCallback(async (job, technicianId, workDate, startTime = '07:00', endTime = '') => {
    trackUsage('assignment_add');
    const tech = techs.find((t) => t.id === technicianId);
    try {
      // Compute derived status before the call so the server can update the SF Opp
      // in the same request - eliminating the separate updateJob round-trip.
      const tentative = { ...job, assignments: [...job.assignments, { workDate, completed: false }] };
      const derived = deriveJobStatusFromAssignments(tentative);
      const resp = await track(() => api.addAssignment(job.id, technicianId, workDate, startTime, endTime, derived.status, derived.scheduledDate));
      const assignmentId = resp.assignmentId;
      const created = resp.assignment;
      const newAssignment = created
        ? { assignmentId: created.assignmentId, technicianId: created.technicianId, technicianName: created.technicianName, workDate: created.workDate, startTime: created.startTime || '07:00', endTime: created.endTime || null, completed: created.completed }
        : { assignmentId, technicianId, technicianName: tech?.name, workDate: workDate || null, startTime: startTime || '07:00', endTime: endTime || null, completed: false };
      // resp.fsStatus is only non-null when this call just bumped FS's status
      // (e.g. Scheduled -> Assigned once a tech is added) -- the server
      // already re-stamped FS_Status__c/FS_Last_Modified__c to match, so pick
      // that up here too instead of showing the pre-bump value until the
      // next full board reload.
      const fsSnapshot = resp.fsStatus ? { fsStatus: resp.fsStatus, fsLastModified: resp.fsLastModified } : {};
      const updated = { ...job, assignments: [...job.assignments, newAssignment], ...derived, ...fsSnapshot };
      setJobs((prev) => prev.map((j) => j.id === job.id ? updated : j));
      flash(`${tech?.name} added to ${job.name}`);
      return updated;
    } catch (e) { flash(`Could not assign: ${e.message}`); return job; }
  }, [techs, flash, track]);

  const unassign = useCallback(async (job, assignmentId) => {
    trackUsage('assignment_remove');
    const updatedAssignments = job.assignments.filter((a) => a.assignmentId !== assignmentId);
    const updatedJob = { ...job, assignments: updatedAssignments };
    const { status, scheduledDate } = deriveJobStatusFromAssignments(updatedJob);
    setJobs((prev) => prev.map((j) => j.id === job.id ? { ...updatedJob, status, scheduledDate } : j));
    try {
      await track(() => api.removeAssignment(assignmentId));
      await track(() => api.updateJob(job.id, { status, scheduledDate, _suppressRelease: true }));
      flash('Tech removed');
    } catch (e) { flash(`Could not remove: ${e.message}`); load(true); }
  }, [flash, track, load]);

  // Mark/unmark a tech's work as actually done. Completed assignments freeze on
  // their date (real history) and won't move when the job is rescheduled.
  const toggleDone = useCallback(async (job, a) => {
    const next = !a.completed;
    trackUsage(next ? 'assignment_complete' : 'assignment_reopen');
    const updatedJob = {
      ...job,
      assignments: job.assignments.map((x) => x.assignmentId === a.assignmentId ? { ...x, completed: next } : x),
    };
    const { status, scheduledDate } = deriveJobStatusFromAssignments(updatedJob);
    setJobs((prev) => prev.map((j) => j.id === job.id ? { ...updatedJob, status, scheduledDate } : j));
    try {
      await track(() => api.updateAssignment(a.assignmentId, { completed: next }));
      await track(() => api.updateJob(job.id, { status, scheduledDate, _suppressRelease: true }));
      flash(next ? `${a.technicianName} marked done` : `${a.technicianName} reopened`);
    } catch (e) { flash(`Could not update: ${e.message}`); load(true); }
  }, [flash, track, load]);

  // Edit a single assignment's own date.
  const setAssignmentDate = useCallback(async (job, a, date) => {
    trackUsage('assignment_reschedule');
    const updatedJob = {
      ...job,
      assignments: job.assignments.map((x) => x.assignmentId === a.assignmentId ? { ...x, workDate: date || null } : x),
    };
    const { status, scheduledDate } = deriveJobStatusFromAssignments(updatedJob);
    setJobs((prev) => prev.map((j) => j.id === job.id ? { ...updatedJob, status, scheduledDate } : j));
    try {
      await track(() => api.updateAssignment(a.assignmentId, { workDate: date }));
      await track(() => api.updateJob(job.id, { status, scheduledDate, _suppressRelease: true }));
      flash('Assignment date saved');
      await load(true);
    } catch (e) { flash(`Could not save date: ${e.message}`); load(true); }
  }, [flash, track, load]);

  const setAssignmentTime = useCallback(async (job, a, time) => {
    const t = time || '07:00';
    const updatedJob = {
      ...job,
      assignments: job.assignments.map((x) => x.assignmentId === a.assignmentId ? { ...x, startTime: t } : x),
    };
    setJobs((prev) => prev.map((j) => j.id === job.id ? updatedJob : j));
    try {
      await track(() => api.updateAssignment(a.assignmentId, { startTime: t }));
      await load(true);
    } catch (e) { flash(`Could not save time: ${e.message}`); load(true); }
  }, [flash, track, load]);

  // End time is required when *creating* a job assignment (see addAssignment
  // routes), but existing rows may still predate that requirement - so
  // editing stays nullable/clearable here rather than forcing a value in.
  const setAssignmentEndTime = useCallback(async (job, a, time) => {
    const t = time || null;
    const updatedJob = {
      ...job,
      assignments: job.assignments.map((x) => x.assignmentId === a.assignmentId ? { ...x, endTime: t } : x),
    };
    setJobs((prev) => prev.map((j) => j.id === job.id ? updatedJob : j));
    try {
      await track(() => api.updateAssignment(a.assignmentId, { endTime: t }));
      await load(true);
    } catch (e) { flash(`Could not save end time: ${e.message}`); load(true); }
  }, [flash, track, load]);

  const setDate = async (job, date) => {
    // Giving an un-advanced job a date schedules it; clearing returns it to queue.
    let status = job.status;
    if (date && preScheduledFor(job.recordType).includes(job.status)) status = SCHEDULED_STATUS;
    else if (!date) status = queueStatusFor(job.recordType);

    const fields = { scheduledDate: date };
    if (status !== job.status) fields.status = status;

    // Changing the next date RELEASES the planned crew: completed stay frozen,
    // non-completed are unscheduled (date cleared) and flagged for re-planning.
    setJobs((prev) => prev.map((j) => j.id === job.id
      ? { ...j, scheduledDate: date || null, status,
          assignments: j.assignments.map((a) => a.completed ? a : { ...a, workDate: null }) }
      : j));
    try {
      await track(() => api.updateJob(job.id, fields));
      flash(date ? 'Next date set - planned crew released' : 'Returned to queue');
    } catch (e) { flash(`Could not save date: ${e.message}`); load(true); }
  };

  // Pull a job off the calendar and back into the queue: clear its date and
  // reset status to "Ready to be scheduled". Completed assignments stay frozen.
  const unschedule = async (job) => {
    trackUsage('unschedule');
    const queueStatus = queueStatusFor(job.recordType);
    setJobs((prev) => prev.map((j) => j.id === job.id
      ? { ...j, scheduledDate: null, status: queueStatus,
          assignments: j.assignments.map((a) => a.completed ? a : { ...a, workDate: null }) }
      : j));
    try {
      await track(() => api.updateJob(job.id, { scheduledDate: '', status: queueStatus }));
      flash(`${job.name} unscheduled`);
    } catch (e) { flash(`Could not unschedule: ${e.message}`); load(true); }
  };

  const setStatus = useCallback(async (job, status) => {
    trackUsage('status_change', { status, recordType: job.recordType });
    const offBoard = !isBoardStatusFor(job.recordType, status);
    setJobs((prev) => offBoard
      ? prev.filter((j) => j.id !== job.id)
      : prev.map((j) => j.id === job.id ? { ...j, status } : j));
    try {
      const result = await track(() => api.updateJob(job.id, { status }));
      // The server re-stamps FS_Status__c/FS_Last_Modified__c immediately
      // whenever it pushes a status to FS -- merge that into local state
      // right away instead of leaving the pre-push value showing on the
      // badge until the next full board reload.
      if (result.fsUpdated && result.fsStatus) {
        setJobs((prev) => prev.map((j) => j.id === job.id
          ? { ...j, fsStatus: result.fsStatus, fsLastModified: result.fsLastModified }
          : j));
      }
      if (offBoard) {
        flash(`${job.name} closed out`);
      } else if (result.fsUpdated) {
        flash('Status updated · FS synced');
      } else if (result.fsError) {
        flash(`Salesforce updated · FS error: ${result.fsError}`);
      } else {
        flash('Status updated');
      }
    } catch (e) { flash(`Could not update: ${e.message}`); load(true); }
  }, [flash, track, load]);

  const openFsLink = useCallback((jobId) => setFsLink({ jobId, query: '', searching: false, matches: null, error: null }), []);
  const closeFsLink = useCallback(() => setFsLink({ jobId: null, query: '', searching: false, matches: null, error: null }), []);

  // Takes the query explicitly rather than reading fsLink.query via closure -
  // this and confirmFsLink below are passed to every JobCard, so if either
  // read fsLink from closure their reference would change on every keystroke
  // in the FS-search box, silently defeating React.memo for ALL job cards,
  // not just the one with the panel open.
  const searchFs = useCallback(async (query) => {
    if (query.trim().length < 3) return;
    setFsLink((s) => ({ ...s, searching: true, matches: null, error: null }));
    try {
      const { matches } = await api.searchFsTasks(query.trim());
      setFsLink((s) => ({ ...s, searching: false, matches }));
    } catch (e) {
      setFsLink((s) => ({ ...s, searching: false, error: e.message }));
    }
  }, []);

  const confirmFsLink = useCallback(async (jobId, fsTaskId, fsTaskName) => {
    closeFsLink();
    try {
      trackUsage('fs_link');
      const result = await api.linkFsTask(jobId, fsTaskId);
      // Reload to pick up the FS status snapshot and any synced assignments
      await load(true);
      // The calendar-tab job modal snapshots into `draftJob` on open and
      // doesn't re-sync from `jobs` while it's open (see the effect that
      // inits it) -- patch it directly so the badge flips immediately
      // instead of waiting for the modal to be closed and reopened.
      setDraftJob((d) => (d && d.id === jobId ? { ...d, fsTaskId } : d));
      const parts = [`Linked to "${fsTaskName}"`];
      if (result.assignmentsAdded > 0) {
        parts.push(`${result.assignmentsAdded} tech${result.assignmentsAdded > 1 ? 's' : ''} added`);
      }
      flash(parts.join(' · '));
    } catch (e) {
      flash(`Link failed: ${e.message}`);
    }
  }, [closeFsLink, load, flash]);

  const saveModal = async () => {
    const originalJob = jobs.find((j) => j.id === selectedJobId);
    if (!originalJob || !draftJob) return;

    // Optimistic: draftJob already IS the "what should happen" end state --
    // the modal UI built it via add/remove/edit before Save was pressed --
    // so apply it and close the modal immediately rather than waiting on
    // the network diff loop below to finish first.
    const derived = deriveJobStatusFromAssignments(draftJob);
    const finalStatus = draftJob.status !== originalJob.status ? draftJob.status : derived.status;
    setJobs((prev) => prev.map((j) => j.id === originalJob.id
      ? { ...draftJob, status: finalStatus, scheduledDate: derived.scheduledDate }
      : j));
    closeFsLink();
    setSelectedJobId(null);

    try {
      // Removed assignments
      const keptIds = new Set(draftJob.assignments.filter((a) => !a._new).map((a) => a.assignmentId));
      for (const a of originalJob.assignments) {
        if (!keptIds.has(a.assignmentId)) await api.removeAssignment(a.assignmentId);
      }
      // Changed assignments
      for (const da of draftJob.assignments.filter((a) => !a._new)) {
        const oa = originalJob.assignments.find((a) => a.assignmentId === da.assignmentId);
        if (!oa) continue;
        const ch = {};
        if (da.workDate !== oa.workDate) ch.workDate = da.workDate || '';
        if ((da.startTime || '07:00') !== (oa.startTime || '07:00')) ch.startTime = da.startTime || '07:00';
        if ((da.endTime || null) !== (oa.endTime || null)) ch.endTime = da.endTime || '';
        if (da.completed !== oa.completed) ch.completed = da.completed;
        if (Object.keys(ch).length > 0) await api.updateAssignment(da.assignmentId, ch);
      }
      // New assignments -- patch in the real assignmentId from each response
      // (same pattern as assign()) so a temp `_new_...` id never lingers in
      // state, where a later edit/remove on it would 404 against Salesforce.
      // endTime always present here -- the Add button in the inline-add flow
      // above is disabled until one is picked, same requirement the server
      // enforces for this endpoint.
      for (const na of draftJob.assignments.filter((a) => a._new)) {
        const resp = await api.addAssignment(draftJob.id, na.technicianId, na.workDate || '', na.startTime || '07:00', na.endTime);
        const created = resp.assignment;
        const realAssignment = created
          ? { assignmentId: created.assignmentId, technicianId: created.technicianId, technicianName: created.technicianName, workDate: created.workDate, startTime: created.startTime || '07:00', endTime: created.endTime || null, completed: created.completed }
          : { ...na, assignmentId: resp.assignmentId, _new: undefined };
        setJobs((prev) => prev.map((j) => j.id === draftJob.id
          ? { ...j, assignments: j.assignments.map((a) => a.assignmentId === na.assignmentId ? realAssignment : a) }
          : j));
      }
      // Sync Opportunity status + scheduledDate
      await api.updateJob(draftJob.id, { status: finalStatus, scheduledDate: derived.scheduledDate, _suppressRelease: true });
      flash('Changes saved');
    } catch (e) {
      flash(`Save failed: ${e.message}`);
      load(true);
    }
  };

  const cancelModal = () => { closeFsLink(); setSelectedJobId(null); };

  // Category -> its distinct present subtypes (raw Opportunity_Type__c values),
  // driving the cascading Type filter. Categories with no subtypes still show
  // (they just have no hover flyout).
  const typeTree = useMemo(() => {
    const map = new Map();
    for (const j of jobs) {
      const cat = jobCategory(j);
      if (!map.has(cat)) map.set(cat, new Set());
      if (j.opportunityType) map.get(cat).add(j.opportunityType);
    }
    const rank = (c) => { const i = TYPE_CATEGORY_ORDER.indexOf(c); return i === -1 ? 99 : i; };
    return [...map.keys()]
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
      .map((category) => ({ category, subtypes: [...map.get(category)].sort() }));
  }, [jobs]);

  const fsStatuses = useMemo(() =>
    [...new Set(jobs.map((j) => j.fsStatus).filter(Boolean))].sort()
  , [jobs]);

  const matchesFsStatus = (j, wanted) => {
    if (wanted === 'all') return true;
    if (wanted === 'unlinked') return !j.fsTaskId;
    return j.fsStatus === wanted;
  };

  const filteredJobs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs.filter((j) => {
      if (!(q === '' || j.name.toLowerCase().includes(q) || (j.address || '').toLowerCase().includes(q))) return false;
      if (jobTech === 'unassigned' && j.assignments.length > 0) return false;
      if (jobTech !== 'all' && jobTech !== 'unassigned'
          && !j.assignments.some((a) => a.technicianId === jobTech)) return false;
      if (jobType !== 'all') {
        const [cat, sub] = jobType.split('::');
        if (jobCategory(j) !== cat) return false;
        if (sub && j.opportunityType !== sub) return false;
      }
      if (!matchesFsStatus(j, jobFsStatus)) return false;
      if (closedFrom || closedTo) {
        const cd = dateOnlyISO(j.closeDate);
        if (!cd) return false;
        if (closedFrom && cd < closedFrom) return false;
        if (closedTo && cd > closedTo) return false;
      }
      return true;
    });
  }, [jobs, query, jobTech, jobType, jobFsStatus, closedFrom, closedTo]);

  const statuses = useMemo(() => {
    const set = new Map();
    filteredJobs.forEach((j) => set.set(j.status, (set.get(j.status) || 0) + 1));
    return [['all', filteredJobs.length], ...set.entries()];
  }, [filteredJobs]);

  const viewingTerminal = TERMINAL_STATUSES.includes(filter);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const source = viewingTerminal ? extraJobs : jobs;
    const filtered = source.filter((j) => {
      if (!(filter === 'all' || j.status === filter)) return false;
      if (!(q === '' || j.name.toLowerCase().includes(q) || (j.address || '').toLowerCase().includes(q))) return false;
      if (jobTech === 'unassigned' && j.assignments.length > 0) return false;
      if (jobTech !== 'all' && jobTech !== 'unassigned'
          && !j.assignments.some((a) => a.technicianId === jobTech)) return false;
      if (jobType !== 'all') {
        const [cat, sub] = jobType.split('::');
        if (jobCategory(j) !== cat) return false;
        if (sub && j.opportunityType !== sub) return false;
      }
      if (!matchesFsStatus(j, jobFsStatus)) return false;
      if (closedFrom || closedTo) {
        const cd = dateOnlyISO(j.closeDate);
        if (!cd) return false;
        if (closedFrom && cd < closedFrom) return false;
        if (closedTo && cd > closedTo) return false;
      }
      return true;
    });

    const byStr = (a, b) => a.localeCompare(b);
    const sorters = {
      scheduled: (a, b) => byStr(a.scheduledDate || '9999-99', b.scheduledDate || '9999-99'),
      closedNew: (a, b) => byStr(b.closeDate || '', a.closeDate || ''),
      closedOld: (a, b) => byStr(a.closeDate || '9999', b.closeDate || '9999'),
      lid: (a, b) => String(a.lid || '').localeCompare(String(b.lid || ''), undefined, { numeric: true }),
      name: (a, b) => byStr(a.name, b.name),
      // Unlinked/no-snapshot-yet jobs sort last rather than first.
      fsStatus: (a, b) => {
        if (!a.fsStatus && !b.fsStatus) return 0;
        if (!a.fsStatus) return 1;
        if (!b.fsStatus) return -1;
        return byStr(a.fsStatus, b.fsStatus);
      },
    };
    return [...filtered].sort(sorters[sortBy] || sorters.scheduled);
  }, [jobs, extraJobs, viewingTerminal, filter, query, jobTech, jobType, jobFsStatus, closedFrom, closedTo, sortBy]);

  // Re-attaches on every shown.length change (not just mount) - the sentinel
  // <div> only exists in the DOM once shown.length > visibleCount, so a plain
  // mount-only effect could miss it entirely if the list started out short and
  // only grew past the cap later.
  useEffect(() => {
    const el = scrollSentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) setVisibleCount((c) => c + 50);
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [shown.length]);

  return (
    <>
      <div className="topline" />
      <header className="bar">
        <div className="wordmark">
          <img className="wordmark-logo" src="/icon-192.png" alt="CRS" />
          <div><h1>CRS Helper</h1></div>
        </div>
        <div className="bar-spacer" />
        <NotesMenu notes={notes} onRefresh={loadNotes} onNewNote={() => openNewNote()} onOpenNote={openNote} />
        <button className="refresh" onClick={() => setManageTechsOpen(true)} title="Add, edit, remove technicians, or set their board password">Manage Techs</button>
        {user.isAdmin && <button className="refresh" onClick={() => setOfficeUsersOpen(true)} title="Manage office users, passwords, and roles">Office Users</button>}
        <button
          className="refresh"
          onClick={() => {
            load();
            if (tab === 'requests') {
              loadRequests();
              if (previousRequestsLoaded) loadPreviousRequests();
            }
            if (tab === 'accounts') {
              api.getAccounts().then(setAccounts).catch((e) => flash(`Accounts error: ${e.message}`));
            }
            if (tab === 'quotes') {
              api.getQuotes(quotesView === 'needs' ? undefined : quotesView).then(setQuotes).catch((e) => flash(`Quotes error: ${e.message}`));
            }
            if (tab === 'parts') {
              api.getPartsInventory().then(setInventoryGroups).catch((e) => flash(`Parts error: ${e.message}`));
            }
            if (tab === 'usage') {
              setUsageRefresh((k) => k + 1);
            }
          }}
          title="Reload from Salesforce"
        >↻ Refresh</button>
        <div className="synced">
          <span className="dot" />
          <span className="lbl">Live · Salesforce</span>
          <SyncedAgo lastSync={lastSync} />
        </div>
        <button className="acct-avatar" onClick={() => setAccountOpen(true)} title={`${user.name} - account`} aria-label="Account">
          {initials(user.name)}
        </button>
      </header>

      <nav className="tabs">
        <button className={`tab ${tab === 'jobs' ? 'active' : ''}`} onClick={() => setTab('jobs')}>Outstanding Jobs</button>
        <button className={`tab ${tab === 'schedule' ? 'active' : ''}`} onClick={() => setTab('schedule')}>Tech Schedule</button>
        <button className={`tab ${tab === 'requests' ? 'active' : ''}`} onClick={() => setTab('requests')}>Requests</button>
        <button className={`tab ${tab === 'contacts' ? 'active' : ''}`} onClick={() => setTab('contacts')}>Contacts</button>
        <button className={`tab ${tab === 'accounts' ? 'active' : ''}`} onClick={() => setTab('accounts')}>Accounts</button>
        <button className={`tab ${tab === 'quotes' ? 'active' : ''}`} onClick={() => setTab('quotes')}>Quotes</button>
        <button className={`tab ${tab === 'parts' ? 'active' : ''}`} onClick={() => setTab('parts')}>Parts</button>
        {user.isAdmin && <button className={`tab ${tab === 'billing' ? 'active' : ''}`} onClick={() => setTab('billing')}>Billing</button>}
        {user.isAdmin && <button className={`tab ${tab === 'expense' ? 'active' : ''}`} onClick={() => setTab('expense')}>Expense Tracking</button>}
        {user.isAdmin && <button className={`tab ${tab === 'usage' ? 'active' : ''}`} onClick={() => setTab('usage')}>Usage</button>}
      </nav>

      <main>
        {loading && tab === 'jobs' && (
          <div className="jobs">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="job">
                <div className="stripe skel-block" />
                <div className="body">
                  <div className="row1">
                    <span className="skel-block" style={{ width: 140, height: 15 }} />
                    <span className="skel-block" style={{ width: 60, height: 15 }} />
                  </div>
                  <div className="meta">
                    <span className="skel-block" style={{ width: '55%', height: 12 }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        {loading && tab === 'schedule' && (
          <div>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="skel-block" style={{ height: 40, marginBottom: 8 }} />
            ))}
          </div>
        )}
        {error && <div className="state err">Couldn't reach the API: {error}<br /><small>Check the Worker's Salesforce secrets and SF_LOGIN_URL.</small></div>}

        {!loading && !error && tab === 'jobs' && (
          <section>
            <div className="view-head">
              <div><h2>Outstanding field work</h2></div>
            </div>

            <div className="searchbox">
              <span className="si">⌕</span>
              <input
                className="searchinput"
                type="text"
                placeholder="Search jobs by name or address…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            <div className="rangefilter">
              <span className="rl">Closed</span>
              <DatePicker value={closedFrom} onChange={setClosedFrom} placeholder="From" />
              <span className="dash">-</span>
              <DatePicker value={closedTo} onChange={setClosedTo} placeholder="To" />
              <FilterSelect
                resetOnSelect
                value=""
                placeholder="Range preset"
                ariaLabel="Closed date range preset"
                options={[
                  ['ytd', 'Year to date'],
                  ['thisMonth', 'This month'],
                  ['lastMonth', 'Last month'],
                ]}
                onChange={(value) => {
                  const today = new Date();
                  if (value === 'ytd') {
                    setClosedFrom(isoOf(startOfYear(today)));
                    setClosedTo(todayIso());
                  } else if (value === 'thisMonth') {
                    setClosedFrom(isoOf(startOfMonth(today)));
                    setClosedTo(todayIso());
                  } else if (value === 'lastMonth') {
                    const start = startOfPreviousMonth(today);
                    const end = new Date(start);
                    end.setMonth(end.getMonth() + 1);
                    end.setDate(0);
                    setClosedFrom(isoOf(start));
                    setClosedTo(isoOf(end));
                  }
                }}
              />
              <button
                className="clearrange"
                onClick={() => { setClosedFrom(''); setClosedTo(''); }}
                disabled={!closedFrom && !closedTo}
              >Clear dates</button>
              {!closedFrom && !closedTo && <span className="rangestate">showing all time</span>}
            </div>
            <div className="datehint">Board loads opportunities by status; these dates only filter by Closed Date.</div>

            <div className="sortbar">
              <div className="sortgrp">
                <span className="rl">Sort</span>
                <FilterSelect
                  value={sortBy}
                  onChange={setSortBy}
                  ariaLabel="Sort jobs"
                  options={[
                    ['scheduled', 'Scheduled date'],
                    ['closedNew', 'closed - newest'],
                    ['closedOld', 'closed - oldest'],
                    ['lid', 'LID'],
                    ['name', 'Job name'],
                    ['fsStatus', 'FS status'],
                  ]}
                />
              </div>
              <div className="sortgrp">
                <span className="rl">Tech</span>
                <FilterSelect
                  value={jobTech}
                  onChange={setJobTech}
                  ariaLabel="Filter by tech"
                  options={[
                    ['all', 'All'],
                    ['unassigned', 'Unassigned'],
                    ...techs.map((t) => [t.id, t.name]),
                  ]}
                />
              </div>
              {typeTree.length > 0 && (
                <div className="sortgrp">
                  <span className="rl">Type</span>
                  <TypeFilterMenu value={jobType} tree={typeTree} onChange={setJobType} />
                </div>
              )}
              <div className="sortgrp">
                <span className="rl">FS status</span>
                <FilterSelect
                  value={jobFsStatus}
                  onChange={setJobFsStatus}
                  ariaLabel="Filter by FS status"
                  options={[
                    ['all', 'All'],
                    ['unlinked', 'Unlinked'],
                    ...fsStatuses.map((s) => [s, s]),
                  ]}
                />
              </div>
            </div>

            {/* Per direction 2026-08-28: the full chip row wrapped across
                several lines on a phone, pushing the actual job list below
                the fold before a user ever saw one. Not a scroll fix (the
                same "no scrolling" rule applies to a horizontally-scrolling
                chip strip too) -- a single compact dropdown covers the same
                ground in one row's worth of height. Desktop keeps the
                original chip row untouched; only one of these two ever
                shows at a time (styles.css). */}
            <div className="filters filters-desktop">
              {statuses.map(([s, count]) => (
                <button key={s} className={`chip ${filter === s ? 'on' : ''}`} onClick={() => setFilter(s)}>
                  {s === 'all' ? 'All outstanding' : s}<span className="ct">{count}</span>
                </button>
              ))}
              <span className="chipdiv" />
              {TERMINAL_STATUSES.map((s) => (
                <button key={s} className={`chip term ${filter === s ? 'on' : ''}`} onClick={() => setFilter(s)} title="Completed in Field Squared - view only">
                  {s}{filter === s && !extraLoading && <span className="ct">{shown.length}</span>}
                </button>
              ))}
            </div>
            <div className="filters-mobile">
              <FilterSelect
                value={filter}
                onChange={setFilter}
                ariaLabel="Filter by status"
                options={[
                  ...statuses.map(([s, count]) => [s, s === 'all' ? `All outstanding (${count})` : `${s} (${count})`]),
                  ...TERMINAL_STATUSES.map((s) => [s, `${s}${filter === s && !extraLoading ? ` (${shown.length})` : ''}`]),
                ]}
              />
            </div>

            <div className="jobs">
              {viewingTerminal && extraLoading && <LoadingDots label="Loading completed jobs…" />}
              {!extraLoading && shown.length === 0 && <div className="empty">{query.trim() ? 'No jobs match that search.' : 'Nothing here.'}</div>}
              {!extraLoading && shown.slice(0, visibleCount).map((job) => (
                <JobCard
                  key={job.id}
                  job={job}
                  readOnly={viewingTerminal}
                  techs={techs}
                  fsLinkForJob={fsLink.jobId === job.id ? fsLink : null}
                  pendingAddForJob={pendingAdd.jobId === job.id ? pendingAdd : null}
                  jobNotes={notesByJobId.get(job.id) || []}
                  onOpenNote={openNote}
                  onDeleteNote={deleteNote}
                  onToggleDone={toggleDone}
                  onAssignmentDateChange={setAssignmentDate}
                  onAssignmentTimeChange={setAssignmentTime}
                  onAssignmentEndTimeChange={setAssignmentEndTime}
                  onUnassign={unassign}
                  onAssign={assign}
                  onSetStatus={setStatus}
                  onOpenFsLink={openFsLink}
                  onCloseFsLink={closeFsLink}
                  onFsLinkChange={setFsLink}
                  onPendingAddChange={setPendingAdd}
                  onSearchFs={searchFs}
                  onConfirmFsLink={confirmFsLink}
                />
              ))}
              {!extraLoading && visibleCount < shown.length && <div ref={scrollSentinelRef} className="scroll-sentinel" />}
            </div>
          </section>
        )}

        {!loading && !error && tab === 'schedule' && <Schedule jobs={jobs} techs={techs} onJobClick={setSelectedJobId} onAssign={assign} />}
        {tab === 'requests' && (
          <RequestsTab
            requests={scheduleRequests}
            jobs={jobs}
            loading={requestsLoading}
            onApprove={approveRequest}
            onCounter={counterRequest}
            onDeny={denyRequest}
            previousRequests={previousRequests}
            previousLoading={previousRequestsLoading}
            previousLoaded={previousRequestsLoaded}
            onLoadPrevious={loadPreviousRequests}
          />
        )}
        {tab === 'contacts' && (
          <ContactsTab
            contacts={contacts}
            loading={contactsLoading}
            accounts={accounts}
            onRefresh={async () => { const c = await api.getContacts(); setContacts(c); }}
            onUpdateContact={updateContact}
          />
        )}
        {tab === 'accounts' && (
          <AccountsTab
            accounts={accounts}
            loading={accountsLoading}
            contacts={contacts}
            onRefresh={async () => { const a = await api.getAccounts(); setAccounts(a); }}
            onUpdateAccount={updateAccount}
            onUpdateContact={updateContact}
          />
        )}
        {tab === 'quotes' && (
          <QuotesTab
            quotes={quotes}
            loading={quotesLoading}
            quotesView={quotesView}
            onViewChange={setQuotesView}
            onStatusChange={updateQuoteStatus}
            onSend={sendQuote}
            onReview={reviewQuote}
            users={emailUsers}
            usersLoaded={emailUsersLoaded}
            onLoadUsers={loadEmailUsers}
          />
        )}
        {tab === 'parts' && (
          <PartsTab
            groups={inventoryGroups}
            loading={inventoryLoading}
            jobs={jobs}
            techs={techs}
            catalog={catalog}
            serviceStock={serviceStock}
            onRefresh={refreshInventory}
            onUpdateRow={updateInventoryRow}
          />
        )}
        {tab === 'billing' && user.isAdmin && <BillingReconciliation />}
        {tab === 'expense' && user.isAdmin && <ExpenseTrackingTab />}
        {tab === 'usage' && user.isAdmin && <UsageDashboard refreshKey={usageRefresh} />}
      </main>

      {toast && <div className="toast">{toast}<span className="tsf">→ Salesforce</span></div>}

      {draftJob && (
        <div className="modal-backdrop" onClick={cancelModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="modal-header">
              <div className="modal-title-row">
                <OppLink className="jname" id={draftJob.id} name={draftJob.name} />
                {draftJob.id && (
                  <a
                    className="sf-open-link"
                    href={oppUrl(draftJob.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open this Opportunity in Salesforce"
                  >
                    ↗ Salesforce
                  </a>
                )}
                {draftJob.lid && <span className="lidtag">LID {draftJob.lid}</span>}
                {draftJob.fsTaskId
                  ? <span className="fs-badge linked" title={`FS task: ${draftJob.fsTaskId}`}>⬡ FS</span>
                  : <button className="fs-badge unlinked fs-attach-btn" title="Attach Field Squared job" onClick={() => fsLink.jobId === draftJob.id ? closeFsLink() : openFsLink(draftJob.id)}>⬡ Attach FS</button>}
                <FsDriftBadge job={draftJob} />
                <FilterSelect
                  value={draftJob.status}
                  onChange={(v) => setDraftJob((d) => ({ ...d, status: v }))}
                  options={[
                    ...(draftJob.status && !assignableStatusesFor(draftJob.recordType).includes(draftJob.status) ? [[draftJob.status, draftJob.status]] : []),
                    ...assignableStatusesFor(draftJob.recordType).map((s) => [s, s]),
                  ]}
                  placeholder="Pick a status…"
                  triggerClassName={`statussel-pill ${draftJob.status ? statusClass(draftJob.status) : 'unset'}`}
                  ariaLabel="Job status"
                />
              </div>
              <button className="modal-close" onClick={cancelModal} aria-label="Close">×</button>
            </div>
            <div className="modal-body">
              {fsLink.jobId === draftJob.id && (
                <div className="fs-attach-panel">
                  <div className="fs-attach-header">
                    <span className="fs-attach-title">Search Field Squared</span>
                    <button className="fs-attach-close" onClick={closeFsLink} aria-label="Close">×</button>
                  </div>
                  <div className="fs-attach-row">
                    <input
                      className="fs-attach-input"
                      type="text"
                      placeholder="Type part of the FS job name…"
                      value={fsLink.query}
                      onChange={(e) => setFsLink((s) => ({ ...s, query: e.target.value }))}
                      onKeyDown={(e) => e.key === 'Enter' && searchFs(fsLink.query)}
                      autoFocus
                    />
                    <button className="fs-btn-search" onClick={() => searchFs(fsLink.query)} disabled={fsLink.searching || fsLink.query.trim().length < 3}>
                      {fsLink.searching ? '…' : 'Search'}
                    </button>
                  </div>
                  {fsLink.error && <div className="fs-attach-error">{fsLink.error}</div>}
                  {fsLink.matches !== null && fsLink.matches.length === 0 && (
                    <div className="fs-attach-empty">No FS tasks found with that name.</div>
                  )}
                  {fsLink.matches && fsLink.matches.map((m) => (
                    <div className="fs-attach-result" key={m.externalId}>
                      <div className="fs-result-info">
                        <div className="fs-result-name">{m.name}</div>
                        <div className="fs-result-meta">{m.taskType} · {m.status}</div>
                      </div>
                      <button className="fs-btn-link" onClick={() => confirmFsLink(draftJob.id, m.externalId, m.name)}>Link</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="meta">
                <span><span className="ic">◍</span>{draftJob.address || 'No address'}</span>
                {draftJob.closeDate && <span className="created">Close Date {fmtDate(draftJob.closeDate)}</span>}
                <span className="nextlabel">Next scheduled</span>
                <span className="dateinput ro" title="Next scheduled assignment date">
                  {nextScheduledAssignmentDate(draftJob) ? fmtDate(nextScheduledAssignmentDate(draftJob)) : '-'}
                </span>
                {nextScheduledAssignmentDate(draftJob)
                  ? <span className="created">Scheduled {fmtDate(nextScheduledAssignmentDate(draftJob))}</span>
                  : <span className="unsched-tag">None</span>}
              </div>
              <div className="assignlist">
                {draftJob.assignments.length === 0 && <span className="unassigned-tag">No techs assigned</span>}
                {draftJob.assignments.map((a) => {
                  const cls = a.completed ? 'done' : (!a.workDate ? 'unscheduled' : '');
                  return (
                    <div className={`assignrow ${cls}`} key={a.assignmentId}>
                      <button
                        className="check"
                        onClick={() => setDraftJob((d) => {
                          const nowCompleted = !a.completed;
                          return {
                            ...d,
                            // Marking a tech's work as done shouldn't let a
                            // stale/auto-derived status silently carry
                            // through to Save -- force a fresh, deliberate
                            // pick instead.
                            status: nowCompleted ? '' : d.status,
                            assignments: d.assignments.map((x) => x.assignmentId === a.assignmentId ? { ...x, completed: nowCompleted } : x),
                          };
                        })}
                        title={a.completed ? 'Worked this day - click to reopen' : 'Mark as worked (freezes the date)'}
                        aria-label="Toggle done"
                      >{a.completed ? '✓' : '○'}</button>
                      <span className="aname">{a.technicianName || 'Tech'}</span>
                      <DatePicker
                        className="dp-adate"
                        value={a.workDate || ''}
                        onChange={(v) => setDraftJob((d) => ({ ...d, assignments: d.assignments.map((x) => x.assignmentId === a.assignmentId ? { ...x, workDate: v || null } : x) }))}
                        placeholder="Date"
                      />
                      <TimePicker
                        className="atime"
                        value={a.startTime || '07:00'}
                        onChange={(v) => setDraftJob((d) => ({ ...d, assignments: d.assignments.map((x) => x.assignmentId === a.assignmentId ? { ...x, startTime: v || '07:00' } : x) }))}
                        title="Start time"
                        disabled={a.completed}
                      />
                      <TimePicker
                        className="atime"
                        value={a.endTime || ''}
                        onChange={(v) => setDraftJob((d) => ({ ...d, assignments: d.assignments.map((x) => x.assignmentId === a.assignmentId ? { ...x, endTime: v || null } : x) }))}
                        title="End time"
                        placeholder="End"
                        disabled={a.completed}
                        clearable
                      />
                      {!a.workDate && !a.completed && <span className="untag">unscheduled</span>}
                      <button
                        className="x"
                        onClick={() => setDraftJob((d) => ({
                          ...d,
                          // Same reasoning as the completed toggle -- removing
                          // a tech can just as easily invalidate the current
                          // status, so force a fresh pick here too.
                          status: '',
                          assignments: d.assignments.filter((x) => x.assignmentId !== a.assignmentId),
                        }))}
                        aria-label="Remove"
                      >×</button>
                    </div>
                  );
                })}
                <div>
                  <TechMultiSelect
                    techs={techs}
                    value={draftPendingAdd.techIds}
                    onChange={(next) => setDraftPendingAdd((p) => ({ ...p, techIds: next, date: p.date || draftJob.scheduledDate || '' }))}
                  />
                  {draftPendingAdd.techIds?.length > 0 && (
                    <div className="inline-add">
                      <DatePicker className="dp-adate" value={draftPendingAdd.date || ''} onChange={(v) => setDraftPendingAdd((p) => ({ ...p, date: v }))} placeholder="Date" />
                      <TimePicker
                        className="atime"
                        value={draftPendingAdd.time || '07:00'}
                        onChange={(v) => setDraftPendingAdd((p) => ({ ...p, time: v }))}
                        title="Start time"
                        quickPicks={deriveTimeQuickPicks(draftJob.assignments)}
                      />
                      <TimePicker
                        className="atime"
                        value={draftPendingAdd.endTime || ''}
                        onChange={(v) => setDraftPendingAdd((p) => ({ ...p, endTime: v }))}
                        title="End time (required)"
                        placeholder="End"
                      />
                      <button
                        className="add-btn"
                        disabled={!draftPendingAdd.endTime}
                        title={!draftPendingAdd.endTime ? 'Pick an end time first' : undefined}
                        onClick={() => {
                          const { techIds, date, time, endTime } = draftPendingAdd;
                          // One staged _new_ assignment per selected tech, all sharing
                          // the same date/time -- saveModal creates each on Save.
                          const stamp = Date.now();
                          setDraftJob((d) => ({
                            ...d,
                            assignments: [...d.assignments, ...techIds.map((techId, i) => ({
                              assignmentId: `_new_${stamp}_${i}`,
                              technicianId: techId,
                              technicianName: techs.find((t) => t.id === techId)?.name || '',
                              workDate: date || null,
                              startTime: time || '07:00',
                              endTime: endTime || null,
                              completed: false,
                              _new: true,
                            }))],
                          }));
                          setDraftPendingAdd({ techIds: [], date: '', time: '', endTime: '' });
                        }}
                      >Add</button>
                      <button className="cancel-btn" onClick={() => setDraftPendingAdd({ techIds: [], date: '', time: '', endTime: '' })}>Cancel</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="modal-save-btn" onClick={saveModal} disabled={!draftJob.status}>Save changes</button>
              <button className="modal-cancel-btn" onClick={cancelModal}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {manageTechsOpen && (
        <ManageTechsModal onClose={() => setManageTechsOpen(false)} onChanged={refreshTechs} />
      )}

      {accountOpen && (
        <AccountMenu
          user={user}
          onClose={() => setAccountOpen(false)}
          onLoggedOut={() => { setAccountOpen(false); onLoggedOut(); }}
        />
      )}

      {officeUsersOpen && user.isAdmin && (
        <OfficeUsersModal meName={user.name} onClose={() => setOfficeUsersOpen(false)} />
      )}

      {editingNote && (
        <NoteEditModal note={editingNote} jobs={jobs} onSaved={afterNoteChange} onDeleted={afterNoteChange} onClose={() => setEditingNote(null)} />
      )}
    </>
  );
}

// First non-blank line is the title shown in the notes list; the rest (if any)
// is a short preview snippet. Mirrors how Claude Code titles a chat from its
// first message - no separate title field to keep in sync.
function noteTitleAndPreview(text) {
  const lines = (text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const title = lines[0] || 'Untitled note';
  const preview = lines.slice(1).join(' ');
  return { title, preview };
}

// Small "N notes" badge shown on a job card only when that job has at least
// one linked note (Opportunity_Specific__c). Clicking it opens a small
// preview popup (title + snippet per note, reusing NotesMenu's own
// .notes-pop* styling); clicking a note in that popup hands off to the same
// shared NoteEditModal the header Notes menu uses (via onOpenNote, passed
// down from App) -- there's a single modal instance, not one per badge.
function JobNotesBadge({ notes, onOpenNote, onDeleteNote }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const popRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, bottom: null, left: 0, maxHeight: 320 });

  useEffect(() => {
    if (!open) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const POP_WIDTH = 280;
    const GAP = 6;
    const EDGE = 8;
    const CEILING = 320;
    let left = rect.left;
    if (left + POP_WIDTH > window.innerWidth - EDGE) left = window.innerWidth - POP_WIDTH - EDGE;
    if (left < EDGE) left = EDGE;
    const spaceBelow = window.innerHeight - rect.bottom - GAP - EDGE;
    const spaceAbove = rect.top - GAP - EDGE;
    if (spaceBelow >= spaceAbove) {
      setPos({ top: rect.bottom + GAP, bottom: null, left, maxHeight: Math.max(0, Math.min(CEILING, spaceBelow)) });
    } else {
      setPos({ top: null, bottom: window.innerHeight - rect.top + GAP, left, maxHeight: Math.max(0, Math.min(CEILING, spaceAbove)) });
    }
  }, [open]);

  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (popRef.current?.contains(e.target)) return; setOpen(false); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, [open]);

  return (
    <div className="job-notes-wrap" ref={wrapRef}>
      <button
        type="button"
        className="job-notes-badge"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title={`${notes.length} note${notes.length === 1 ? '' : 's'} on this job`}
      >
        Notes
      </button>
      {open && createPortal(
        <div
          className="notes-pop job-notes-pop"
          ref={popRef}
          style={{ left: pos.left, maxHeight: pos.maxHeight, ...(pos.bottom != null ? { bottom: pos.bottom } : { top: pos.top }) }}
        >
          <div className="notes-pop-list">
            {notes.map((note) => {
              const { title, preview } = noteTitleAndPreview(note.text);
              return (
                <div className="notes-pop-row" key={note.id}>
                  <button
                    className="notes-pop-item"
                    onClick={(e) => { e.stopPropagation(); setOpen(false); onOpenNote(note); }}
                  >
                    <span className="notes-pop-title">{title}</span>
                    {preview && <span className="notes-pop-preview">{preview}</span>}
                  </button>
                  <button
                    type="button"
                    className="notes-pop-delete"
                    title="Delete note"
                    aria-label="Delete note"
                    onClick={(e) => { e.stopPropagation(); onDeleteNote(note.id); }}
                  >×</button>
                </div>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// Header "Notes" button + dropdown: a shared (all-users) team scratchpad,
// stored in Salesforce (Dispatch_Note__c) rather than localStorage since
// everyone on the board should see the same list. `notes`/`onRefresh` are
// owned by App (shared with the per-job notes badges below), and clicking a
// note here hands off to App's single shared NoteEditModal via `onOpenNote`/
// `onNewNote` rather than owning its own editing state.
function NotesMenu({ notes, onRefresh, onNewNote, onOpenNote }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, bottom: null, left: 0, maxHeight: 420 });
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);
  const popRef = useRef(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((n) => noteTitleAndPreview(n.text).title.toLowerCase().includes(q));
  }, [notes, query]);

  // Re-pull on every open, not just on mount, since other dispatchers may
  // have added/edited notes since this tab last loaded. Flips above the
  // trigger and clamps maxHeight the same way DatePicker/SearchableSelect/
  // TimePicker do, so this popup can't run off the bottom of the viewport.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    onRefresh();
    const rect = wrapRef.current.getBoundingClientRect();
    const POP_WIDTH = 320;
    const GAP = 6;
    const EDGE = 8;
    const CEILING = 420;
    let left = rect.left;
    if (left + POP_WIDTH > window.innerWidth - EDGE) left = window.innerWidth - POP_WIDTH - EDGE;
    if (left < EDGE) left = EDGE;
    const spaceBelow = window.innerHeight - rect.bottom - GAP - EDGE;
    const spaceAbove = rect.top - GAP - EDGE;
    if (spaceBelow >= spaceAbove) {
      setPos({ top: rect.bottom + GAP, bottom: null, left, maxHeight: Math.max(0, Math.min(CEILING, spaceBelow)) });
    } else {
      setPos({ top: null, bottom: window.innerHeight - rect.top + GAP, left, maxHeight: Math.max(0, Math.min(CEILING, spaceAbove)) });
    }
  }, [open, onRefresh]);

  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (popRef.current?.contains(e.target)) return; setOpen(false); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, [open]);

  const openNew = () => { setOpen(false); onNewNote(); };
  const openExisting = (note) => { setOpen(false); onOpenNote(note); };

  return (
    <div className="notes-menu-wrap" ref={wrapRef}>
      <button className="refresh" onClick={() => setOpen((o) => !o)} title="Shared team notes - visible to everyone on the board">
        Notes{notes.length > 0 ? ` (${notes.length})` : ''}
      </button>
      {open && createPortal(
        <div
          className="notes-pop"
          ref={popRef}
          style={{ left: pos.left, maxHeight: pos.maxHeight, ...(pos.bottom != null ? { bottom: pos.bottom } : { top: pos.top }) }}
        >
          <div className="notes-pop-head">
            <span>Team notes</span>
            <button className="notes-new-btn" onClick={openNew}>+ New note</button>
          </div>
          {notes.length > 0 && (
            <div className="notes-pop-search-wrap">
              <input
                className="notes-pop-search"
                type="text"
                placeholder="Filter by name…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
            </div>
          )}
          <div className="notes-pop-list">
            {notes.length === 0 && (
              <div className="notes-pop-empty">No notes yet - click "+ New note" to add one.</div>
            )}
            {notes.length > 0 && filtered.length === 0 && (
              <div className="notes-pop-empty">No notes match "{query}".</div>
            )}
            {filtered.map((note) => {
              const { title, preview } = noteTitleAndPreview(note.text);
              return (
                <button className="notes-pop-item" key={note.id} onClick={() => openExisting(note)}>
                  <span className="notes-pop-title-row">
                    <span className="notes-pop-title">{title}</span>
                    {note.opportunitySpecific && note.opportunityName && (
                      <OppLink className="notes-pop-job-tag" id={note.opportunityId} name={note.opportunityName} />
                    )}
                  </span>
                  {preview && <span className="notes-pop-preview">{preview}</span>}
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function NoteEditModal({ note, jobs, onSaved, onDeleted, onClose }) {
  const [text, setText] = useState(note.text);
  const [opportunityId, setOpportunityId] = useState(note.opportunityId || '');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState(null);

  // Search set is the currently-loaded outstanding jobs. If this note is
  // linked to a job that's fallen off that list (closed, etc.), append it
  // synthetically from the note's own record so the picker still shows it.
  const jobOptions = useMemo(() => {
    const base = jobs.map((j) => [j.id, j.lid ? `${j.name} - LID ${j.lid}` : j.name]);
    if (note.opportunityId && !base.some(([id]) => id === note.opportunityId)) {
      base.push([note.opportunityId, note.opportunityName || 'Linked opportunity']);
    }
    return base;
  }, [jobs, note.opportunityId, note.opportunityName]);

  const save = async () => {
    const trimmed = text.trim();
    if (!trimmed) { setErr('Note text is required'); return; }
    setSaving(true);
    setErr(null);
    try {
      if (note.isNew) {
        trackUsage('note_add');
        await api.addNote(trimmed, opportunityId || null);
      } else {
        await api.updateNote(note.id, { text: trimmed, opportunityId: opportunityId || null });
      }
      onSaved();
    } catch (e) {
      setErr(e.message);
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setErr(null);
    try {
      await api.removeNote(note.id);
      onDeleted();
    } catch (e) {
      setErr(e.message);
      setDeleting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-notes" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title-row"><span className="jname">{note.isNew ? 'New note' : 'Edit note'}</span></div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          <p className="tech-links-hint">Shared with everyone on the board. The first line becomes the title.</p>
          <textarea
            className="notes-textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a note or to-do…"
            rows={16}
            autoFocus
          />
          <div className="notes-job-link">
            {/* Checkbox is purely derived from whether an opportunity is picked below - it's never toggled directly. */}
            <label className="notes-job-check">
              <input type="checkbox" checked={!!opportunityId} disabled readOnly />
              <span>Belongs to a specific opportunity</span>
            </label>
            <SearchableSelect
              value={opportunityId}
              onChange={setOpportunityId}
              options={jobOptions}
              placeholder="Search for an opportunity…"
            />
          </div>
          {err && <div className="notes-pop-err">{err}</div>}
        </div>
        <div className="modal-footer">
          {!note.isNew && (
            <button className="modal-cancel-btn" onClick={remove} disabled={deleting || saving}>
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          )}
          <div className="modal-footer-spacer" />
          <button className="modal-cancel-btn" onClick={onClose} disabled={saving || deleting}>Cancel</button>
          <button className="modal-save-btn" onClick={save} disabled={saving || deleting || !text.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Add/edit/remove technicians, including a hand-picked hex color per tech
// (shown on the /tv warehouse calendar - a tech with no color set there
// falls back to a deterministic auto-generated one). "Remove" is a soft
// delete (Active__c = false via PATCH /technicians/:id) rather than an SF
// record delete, since Job_Assignment__c/Schedule_Request__c both hold
// lookups to Technician__c - removed techs stay listed here (with a
// "Removed" badge) so they can be reactivated.
function ManageTechsModal({ onClose, onChanged }) {
  const [techs, setTechs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fsUsers, setFsUsers] = useState([]);
  const [fsUsersLoading, setFsUsersLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState({ name: '', fsUserId: '', color: '' });
  const [newName, setNewName] = useState('');
  const [newFsId, setNewFsId] = useState('');
  const [newColor, setNewColor] = useState('#2563eb');
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const t = await api.getTechnicians({ all: true });
      setTechs([...t].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (e) {
      alert(`Could not load technicians: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    setFsUsersLoading(true);
    api.getFsUsers()
      .then(({ users }) => setFsUsers(users))
      .catch(() => {})
      .finally(() => setFsUsersLoading(false));
  }, []);

  const fsUserOptions = useMemo(() =>
    fsUsers.map((u) => [u.externalId, u.userType ? `${u.name} - ${u.userType}` : u.name])
  , [fsUsers]);

  const startEdit = (t) => {
    setEditingId(t.id);
    setDraft({ name: t.name, fsUserId: t.fsUserId || '', color: t.color || '' });
  };

  const saveEdit = async (id) => {
    if (!draft.name.trim()) return;
    setBusyId(id);
    try {
      await api.updateTechnician(id, { name: draft.name.trim(), fsUserId: draft.fsUserId || null, color: draft.color || null });
      setEditingId(null);
      await reload();
      onChanged?.();
    } catch (e) {
      alert(`Could not save: ${e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const toggleActive = async (t) => {
    setBusyId(t.id);
    try {
      await api.updateTechnician(t.id, { active: !t.active });
      await reload();
      onChanged?.();
    } catch (e) {
      alert(`Could not update: ${e.message}`);
    } finally {
      setBusyId(null);
    }
  };

  // Password modal state (explicit in-app modal, not window.prompt).
  const [pwTech, setPwTech] = useState(null);
  const [pwValue, setPwValue] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwErr, setPwErr] = useState(null);

  const openPassword = (t) => { setPwTech(t); setPwValue(''); setPwErr(null); };

  // Blank clears the password, so the tech falls back to the default until they
  // set their own in the app.
  const savePassword = async () => {
    if (!pwTech) return;
    setPwBusy(true);
    setPwErr(null);
    try {
      await api.updateTechnician(pwTech.id, { password: pwValue.trim() });
      setPwTech(null);
    } catch (e) {
      setPwErr(e.message || 'Could not set password');
    } finally {
      setPwBusy(false);
    }
  };

  const submitAdd = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      trackUsage('tech_add');
      await api.addTechnician(newName.trim(), newFsId || null, newColor || null);
      setNewName('');
      setNewFsId('');
      setNewColor('#2563eb');
      await reload();
      onChanged?.();
    } catch (e) {
      alert(`Could not add tech: ${e.message}`);
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-manage-techs" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title-row"><span className="jname">Manage technicians</span></div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          {loading ? (
            <LoadingDots label="Loading technicians…" inline />
          ) : (
            <div className="manage-techs-list">
              {techs.map((t) => (
                <div className={`manage-tech-row ${t.active ? '' : 'mt-inactive'}`} key={t.id}>
                  {editingId === t.id ? (
                    <>
                      <input
                        className="mt-color-input"
                        type="color"
                        value={draft.color || '#64748b'}
                        onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}
                        title="Pick a color"
                      />
                      <input
                        className="req-note-input mt-name-input"
                        type="text"
                        value={draft.name}
                        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                        autoFocus
                      />
                      {fsUsersLoading ? (
                        <LoadingDots label="Loading FS roster…" inline />
                      ) : (
                        <SearchableSelect
                          value={draft.fsUserId}
                          onChange={(v) => setDraft((d) => ({ ...d, fsUserId: v }))}
                          options={fsUserOptions}
                          placeholder="FS account…"
                        />
                      )}
                      <button className="req-btn approve" onClick={() => saveEdit(t.id)} disabled={busyId === t.id || !draft.name.trim()}>
                        {busyId === t.id ? 'Saving…' : 'Save'}
                      </button>
                      <button className="req-btn" onClick={() => setEditingId(null)} disabled={busyId === t.id}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <span className="mt-swatch" style={{ background: t.color || '#3a4552' }} />
                      <span className="mt-name">{t.name}</span>
                      {!t.active && <span className="mt-inactive-badge">Removed</span>}
                      <button className="req-btn" onClick={() => startEdit(t)} disabled={busyId === t.id}>Edit</button>
                      <button className="req-btn" onClick={() => openPassword(t)} disabled={busyId === t.id}>Password</button>
                      <button className="req-btn deny" onClick={() => toggleActive(t)} disabled={busyId === t.id}>
                        {busyId === t.id ? '…' : t.active ? 'Remove' : 'Reactivate'}
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="manage-tech-add">
            <span className="req-field-label">Add technician</span>
            <div className="manage-tech-row">
              <input
                className="mt-color-input"
                type="color"
                value={newColor}
                onChange={(e) => setNewColor(e.target.value)}
                title="Pick a color"
              />
              <input
                className="req-note-input mt-name-input"
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Full name, matching Salesforce"
              />
              {fsUsersLoading ? (
                <LoadingDots label="Loading FS roster…" inline />
              ) : (
                <SearchableSelect
                  value={newFsId}
                  onChange={setNewFsId}
                  options={fsUserOptions}
                  placeholder="FS account (optional)…"
                />
              )}
              <button className="req-btn approve" onClick={submitAdd} disabled={adding || !newName.trim()}>
                {adding ? 'Adding…' : 'Add'}
              </button>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-cancel-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>

    {pwTech && (
      <div className="modal-backdrop" onClick={() => !pwBusy && setPwTech(null)}>
        <div className="modal modal-sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
          <div className="modal-header">
            <div className="modal-title-row"><span className="jname">Board password - {pwTech.name}</span></div>
            <button className="modal-close" onClick={() => setPwTech(null)} aria-label="Close" disabled={pwBusy}>×</button>
          </div>
          <div className="modal-body">
            <label className="req-field req-field-wide">
              <span className="req-field-label">New password</span>
              <input
                className="req-note-input"
                type="text"
                value={pwValue}
                onChange={(e) => setPwValue(e.target.value)}
                placeholder="Leave blank to reset to the default"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') savePassword(); }}
              />
            </label>
            <p className="tech-links-hint">Office-visible on purpose. Blank resets this tech to the default password until they set their own in the app.</p>
            {pwErr && <p className="req-error">{pwErr}</p>}
          </div>
          <div className="modal-footer">
            <button className="modal-save-btn" onClick={savePassword} disabled={pwBusy}>
              {pwBusy ? 'Saving…' : (pwValue.trim() ? 'Set password' : 'Reset to default')}
            </button>
            <button className="modal-cancel-btn" onClick={() => setPwTech(null)} disabled={pwBusy}>Cancel</button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

// Shared anchored-popover mechanics for the filter-bar dropdowns: opens a
// position:fixed panel from the trigger's rect (flipping above when there's more
// room below), and closes on outside-click / scroll / resize. Mirrors the idiom
// in SearchableSelect / DatePicker so the filter dropdowns float above any
// overflow:auto ancestor instead of being clipped.
function useAnchoredPopover(minWidth = 180) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, bottom: null, left: 0, width: minWidth, maxHeight: 340 });
  const wrapRef = useRef(null);
  const popRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const width = Math.max(rect.width, minWidth);
    let left = rect.left;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    if (left < 8) left = 8;
    const GAP = 4, EDGE = 8, CEILING = 340;
    const below = window.innerHeight - rect.bottom - GAP - EDGE;
    const above = rect.top - GAP - EDGE;
    if (below >= above) setPos({ top: rect.bottom + GAP, bottom: null, left, width, maxHeight: Math.max(0, Math.min(CEILING, below)) });
    else setPos({ top: null, bottom: window.innerHeight - rect.top + GAP, left, width, maxHeight: Math.max(0, Math.min(CEILING, above)) });
  }, [open, minWidth]);

  useEffect(() => {
    if (!open) return;
    const down = (e) => { if (wrapRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return; setOpen(false); };
    const close = (e) => { if (popRef.current?.contains(e.target)) return; setOpen(false); };
    document.addEventListener('mousedown', down);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { document.removeEventListener('mousedown', down); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);

  return { open, setOpen, pos, wrapRef, popRef };
}

// Custom CSS dropdown replacing a native <select> in the filter bar. `options`
// is [value, label][]. When `resetOnSelect` (the Range preset "action" select),
// the trigger always shows `placeholder` and selecting fires onChange without
// retaining a value.
function FilterSelect({ value, onChange, options, placeholder, resetOnSelect = false, ariaLabel, triggerClassName = '' }) {
  const { open, setOpen, pos, wrapRef, popRef } = useAnchoredPopover(180);
  const current = resetOnSelect ? null : options.find(([v]) => v === value);
  const label = current ? current[1] : (placeholder ?? '');
  return (
    <div className="fsel-wrap" ref={wrapRef}>
      <button type="button" className={`fsel-trigger ${current ? '' : 'placeholder'} ${triggerClassName}`.trim()} aria-label={ariaLabel} onClick={() => setOpen((o) => !o)}>
        <span className="fsel-val">{label}</span>
        <span className="fsel-caret" aria-hidden>▾</span>
      </button>
      {open && createPortal(
        <div className="fsel-menu scroll" ref={popRef}
          style={{ left: pos.left, minWidth: pos.width, maxHeight: pos.maxHeight, ...(pos.bottom != null ? { bottom: pos.bottom } : { top: pos.top }) }}>
          {options.map(([v, l]) => (
            <button key={v} type="button" className={`fsel-opt ${!resetOnSelect && v === value ? 'sel' : ''}`}
              onClick={() => { onChange(v); setOpen(false); }}>{l}</button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

// Cascading Type filter. `tree` = [{ category, subtypes:[rawOppType…] }]. Value
// is 'all', a category ('Job'), or `${category}::${rawOppType}`. Clicking a
// category selects the WHOLE category and closes; hovering a category reveals its
// subtypes in a flyout to the right; clicking a subtype narrows to that value.
function TypeFilterMenu({ value, tree, onChange }) {
  const { open, setOpen, pos, wrapRef, popRef } = useAnchoredPopover(150);
  const [activeCat, setActiveCat] = useState(null);
  const [flip, setFlip] = useState(false);

  useEffect(() => { if (!open) setActiveCat(null); }, [open]);

  let label = 'All types';
  if (value !== 'all') {
    const [cat, sub] = value.split('::');
    label = sub ? `${cat} · ${cleanSubLabel(cat, sub)}` : cat;
  }

  const pick = (v) => { onChange(v); setOpen(false); };
  const onEnterCat = (category, hasSub) => {
    setActiveCat(hasSub ? category : null);
    if (hasSub && popRef.current) {
      const r = popRef.current.getBoundingClientRect();
      setFlip(r.right + 200 > window.innerWidth - 8); // flyout would overflow → open left
    }
  };

  return (
    <div className="fsel-wrap" ref={wrapRef}>
      <button type="button" className="fsel-trigger" aria-label="Type filter" onClick={() => setOpen((o) => !o)}>
        <span className="fsel-val">{label}</span>
        <span className="fsel-caret" aria-hidden>▾</span>
      </button>
      {open && createPortal(
        <div className="fsel-menu" ref={popRef}
          style={{ left: pos.left, minWidth: pos.width, ...(pos.bottom != null ? { bottom: pos.bottom } : { top: pos.top }) }}
          onMouseLeave={() => setActiveCat(null)}>
          <button type="button" className={`fsel-opt ${value === 'all' ? 'sel' : ''}`}
            onMouseEnter={() => setActiveCat(null)} onClick={() => pick('all')}>All types</button>
          {tree.map(({ category, subtypes }) => {
            const hasSub = subtypes.length > 0;
            const catSelected = value === category || value.startsWith(`${category}::`);
            return (
              <div key={category} className="fsel-catrow" onMouseEnter={() => onEnterCat(category, hasSub)}>
                <button type="button" className={`fsel-opt ${hasSub ? 'has-sub' : ''} ${catSelected ? 'sel' : ''}`}
                  onClick={() => pick(category)}>{category}</button>
                {hasSub && activeCat === category && (
                  <div className={`fsel-sub ${flip ? 'flip-left' : ''}`}>
                    {subtypes.map((sub) => (
                      <button key={sub} type="button" className={`fsel-opt ${value === `${category}::${sub}` ? 'sel' : ''}`}
                        onClick={() => pick(`${category}::${sub}`)}>{cleanSubLabel(category, sub)}</button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}

// App-specific multi-select for adding assignments: pick several techs in one
// go, each becoming its own Job_Assignment__c with the shared date/time. Unlike
// the single-select filter menus, the menu STAYS OPEN while toggling checkboxes,
// and the trigger always shows who's currently selected (which also fixes the
// job/calendar modal's old bug of not showing the picked tech). `value` is a
// techId[]; `triggerClassName` lets it wear the .addtech pill or a full field.
function TechMultiSelect({ value, onChange, techs, placeholder = '+ Add assignment', triggerClassName = 'addtech' }) {
  const { open, setOpen, pos, wrapRef, popRef } = useAnchoredPopover(200);
  const selected = value || [];
  const names = selected.map((id) => techs.find((t) => t.id === id)?.name).filter(Boolean);
  // Collapse to a count at 2+ so the trigger stays compact and never pushes the
  // inline date/time row onto a second line (full list is in the hover title).
  const label = names.length === 0 ? placeholder
    : names.length === 1 ? names[0]
    : `${names.length} selected`;
  const toggle = (id) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="techms-wrap" ref={wrapRef}>
      <button type="button" title={names.length ? names.join(', ') : undefined} className={`${triggerClassName} techms-trigger ${selected.length ? 'has-sel' : ''}`} onClick={() => setOpen((o) => !o)}>
        <span className="techms-val">{label}</span>
        <span className="techms-caret" aria-hidden>▾</span>
      </button>
      {open && createPortal(
        <div className="techms-menu" ref={popRef}
          style={{ left: pos.left, minWidth: pos.width, maxHeight: pos.maxHeight, ...(pos.bottom != null ? { bottom: pos.bottom } : { top: pos.top }) }}>
          {techs.map((t) => {
            const on = selected.includes(t.id);
            return (
              <button key={t.id} type="button" role="menuitemcheckbox" aria-checked={on}
                className={`techms-opt ${on ? 'on' : ''}`} onClick={() => toggle(t.id)}>
                <span className="techms-check" aria-hidden>{on ? '✓' : ''}</span>{t.name}
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}

const SearchableSelect = React.memo(function SearchableSelect({ value, onChange, options, placeholder }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, bottom: null, left: 0, width: 260, maxHeight: 280 });
  const [visibleCount, setVisibleCount] = useState(30);
  const wrapRef = useRef(null);
  const popRef = useRef(null);
  const sentinelRef = useRef(null);

  // Portaled to <body> and fixed-positioned from the trigger's own coordinates,
  // same fix as DatePicker uses -- otherwise an ancestor with overflow:auto
  // (e.g. a scrollable modal body) clips the dropdown instead of letting it
  // float above everything. Flips above the trigger (anchored with `bottom`
  // instead of `top`) when there's more room there than below, and always
  // caps `maxHeight` to whichever side it lands on so it never runs off the
  // viewport regardless of how many options match.
  useEffect(() => {
    if (!open) return;
    const rect = wrapRef.current.getBoundingClientRect();
    // Floor lowered from 340 to 230 -- per direction 2026-08-27, a second,
    // real cause behind "inputs extend across almost the whole modal" on
    // top of the .req-field stretch bug fixed separately: .ss-input is only
    // 180px wide, but this floor forced the dropdown panel itself to render
    // at least 340px wide regardless -- nearly double the trigger, and
    // close to the FULL WIDTH of a .modal-sm (max-width 420px). That's not
    // an invisible-hitbox illusion, it's the panel genuinely rendering that
    // wide with its own visible background. 230px still gives real room
    // over the 180px input for longer option labels (which already ellipsis
    // via .ss-option's text-overflow, so some truncation on long names was
    // already the accepted baseline, not a new tradeoff) without dominating
    // a small modal.
    const POP_WIDTH = Math.max(rect.width, 230);
    let left = rect.left;
    if (left + POP_WIDTH > window.innerWidth - 8) left = window.innerWidth - POP_WIDTH - 8;
    if (left < 8) left = 8;

    const GAP = 4;
    const EDGE = 8;
    const CEILING = 280;
    const spaceBelow = window.innerHeight - rect.bottom - GAP - EDGE;
    const spaceAbove = rect.top - GAP - EDGE;

    if (spaceBelow >= spaceAbove) {
      setPos({ top: rect.bottom + GAP, bottom: null, left, width: POP_WIDTH, maxHeight: Math.max(0, Math.min(CEILING, spaceBelow)) });
    } else {
      setPos({ top: null, bottom: window.innerHeight - rect.top + GAP, left, width: POP_WIDTH, maxHeight: Math.max(0, Math.min(CEILING, spaceAbove)) });
    }
  }, [open]);

  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    // Scrolling the dropdown's own option list also fires a window-level
    // capture 'scroll' event -- ignore that one so scrolling through matches
    // doesn't immediately close the dropdown. Only an ancestor (e.g. a
    // scrollable list sitting next to this component, like ManageTechs' or
    // Contacts') scrolling underneath it should close it -- the body-scroll
    // lock below already rules out plain page scroll as a cause.
    // ALSO ignore wrapRef -- confirmed live 2026-08-24, the real bug behind
    // an "exact match doesn't show" report: once typed/pasted text exceeds
    // the visible width of `.ss-input`, the browser auto-scrolls the text
    // box to keep the caret visible, which fires a genuine native `scroll`
    // event ON THE INPUT ITSELF. Capture-phase listeners on window still see
    // it even though 'scroll' doesn't bubble, so without this guard, typing
    // or pasting anything wide enough to overflow the box closed the
    // dropdown instantly -- nothing to do with an ancestor container
    // scrolling at all.
    const close = (e) => { if (popRef.current?.contains(e.target) || wrapRef.current?.contains(e.target)) return; setOpen(false); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);

  // Lock background scroll while open so the page/modal behind the dropdown
  // can't scroll out from under it -- without this, a wheel scroll over a
  // modal shorter than its own scroll area bubbles straight through to
  // <body>, which both looks broken and trips the listener above.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, [open]);

  // Caps how many matches are mounted at once, reusing the Contacts-tab /
  // outstanding-jobs-list infinite-scroll idiom (visibleCount + an
  // IntersectionObserver on a .scroll-sentinel div), but at a smaller 30/30
  // batch since this dropdown only ever shows ~4-5 rows before its own
  // scrollbar kicks in. Resets to 30 both on a new search (fresh first batch,
  // same as Contacts resetting on filter change) and whenever the dropdown
  // re-opens, so scroll position from a previous open/close cycle doesn't
  // linger -- one effect keyed on both covers both triggers.
  useEffect(() => { setVisibleCount(30); }, [open, query]);

  const selectedLabel = options.find(([id]) => id === value)?.[1] ?? null;

  // Memoized since scroll-driven visibleCount bumps now re-render this
  // component independent of options/query -- without this, each of those
  // re-renders would redo a full filter() pass for no reason (matters most
  // for the opportunity-picker call sites, which can have dozens-to-hundreds
  // of options).
  const matches = useMemo(
    () => options.filter(([, label]) => label.toLowerCase().includes(query.toLowerCase())),
    [options, query]
  );

  // .ss-dropdown is its own small position:fixed scrollable box, not the
  // viewport -- unlike the Jobs/Contacts lists' sentinels, which rely on the
  // *default* IntersectionObserver root (the viewport) with a generous
  // rootMargin. Defaulting `root` here would mean "within 200px of the
  // browser window edge," unrelated to the sentinel's position inside this
  // popup, so `root` must be the dropdown element itself.
  useEffect(() => {
    if (!open) return;
    const el = sentinelRef.current;
    const root = popRef.current;
    if (!el || !root) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) setVisibleCount((c) => c + 30);
    }, { root, rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [open, matches.length]);

  if (value) {
    return (
      <button className="ss-selected" onClick={() => onChange('')}>
        {selectedLabel}<span className="ss-clear">×</span>
      </button>
    );
  }

  return (
    <div className="ss-wrap" ref={wrapRef}>
      <input
        className="ss-input"
        type="text"
        placeholder={placeholder}
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
      />
      {open && createPortal(
        <div
          className="ss-dropdown"
          ref={popRef}
          style={{ left: pos.left, width: pos.width, maxHeight: pos.maxHeight, ...(pos.bottom != null ? { bottom: pos.bottom } : { top: pos.top }) }}
        >
          {matches.length === 0
            ? <div className="ss-empty">No matches</div>
            : matches.slice(0, visibleCount).map(([id, label]) => (
                <button key={id} className="ss-option" title={label} onMouseDown={() => { onChange(id); setQuery(''); setOpen(false); }}>
                  {label}
                </button>
              ))}
          {visibleCount < matches.length && <div ref={sentinelRef} className="scroll-sentinel" />}
        </div>,
        document.body
      )}
    </div>
  );
});

// Searchable multi-select - merges SearchableSelect's search-as-you-type
// filtering (App.jsx:2744) with TechMultiSelect's chip/toggle multi-select UX
// (App.jsx:2709), via the same useAnchoredPopover hook both already use.
// Neither existing component covers "searchable + multi" on its own; built
// for the Create PO opportunity picker, which can legitimately span several
// jobs at once.
function OppMultiSelect({ value, onChange, options, placeholder = 'Search & select opportunities…' }) {
  const { open, setOpen, pos, wrapRef, popRef } = useAnchoredPopover(340);
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(40);
  const selected = value || [];
  const toggle = (id) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const matches = useMemo(
    () => options.filter(([, label]) => label.toLowerCase().includes(query.toLowerCase())),
    [options, query]
  );
  useEffect(() => { setVisibleCount(40); }, [open, query]);
  const selectedLabels = selected.map((id) => [id, options.find(([oid]) => oid === id)?.[1]]).filter(([, l]) => l);

  return (
    <div className="oppms-wrap" ref={wrapRef}>
      <button type="button" className={`oppms-trigger ${selected.length ? 'has-sel' : ''}`} onClick={() => setOpen((o) => !o)}>
        <span className="oppms-val">
          {selected.length === 0 ? placeholder : selected.length === 1 ? selectedLabels[0]?.[1] : `${selected.length} opportunities selected`}
        </span>
        <span className="oppms-caret" aria-hidden>▾</span>
      </button>
      {selected.length > 0 && (
        <div className="oppms-chips">
          {selectedLabels.map(([id, label]) => (
            <span className="oppms-chip" key={id}>
              {label}
              <button type="button" onClick={() => toggle(id)} aria-label={`Remove ${label}`}>×</button>
            </span>
          ))}
        </div>
      )}
      {open && createPortal(
        <div className="oppms-menu" ref={popRef}
          style={{ left: pos.left, width: pos.width, maxHeight: pos.maxHeight, ...(pos.bottom != null ? { bottom: pos.bottom } : { top: pos.top }) }}>
          <input
            className="oppms-search"
            type="text"
            autoFocus
            placeholder="Search opportunities…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="oppms-list">
            {matches.length === 0
              ? <div className="ss-empty">No matches</div>
              : matches.slice(0, visibleCount).map(([id, label]) => {
                  const on = selected.includes(id);
                  return (
                    <button key={id} type="button" role="menuitemcheckbox" aria-checked={on}
                      className={`oppms-opt ${on ? 'on' : ''}`} onClick={() => toggle(id)}>
                      <span className="oppms-check" aria-hidden>{on ? '✓' : ''}</span>{label}
                    </button>
                  );
                })}
            {visibleCount < matches.length && (
              <button type="button" className="oppms-more" onClick={() => setVisibleCount((c) => c + 40)}>Show more…</button>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// Custom calendar dropdown replacing native <input type="date"> everywhere in the
// app - the native picker can't be restyled to match the rest of the site, so
// this renders its own month grid instead. `value`/`onChange` are ISO date
// strings ('YYYY-MM-DD' or '' for empty), same contract as a date input.
const DatePicker = React.memo(function DatePicker({ value, onChange, placeholder = 'Select date', className = '', clearable = true }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, bottom: null, left: 0, maxHeight: undefined });
  const [viewMonth, setViewMonth] = useState(() => {
    const d = value ? new Date(value + 'T00:00:00') : new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const wrapRef = useRef(null);
  const popRef = useRef(null);

  // Popup is portaled to <body> and fixed-positioned from the trigger's own
  // coordinates - cards like .job use overflow:hidden for their rounded status
  // stripe, which would otherwise clip an absolutely-positioned dropdown. Flips
  // above the trigger (anchored with `bottom` instead of `top`) when there's
  // more room there than below, and caps `maxHeight` to whichever side it
  // lands on so the calendar grid never runs off the viewport.
  useEffect(() => {
    if (!open) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const POP_WIDTH = 250;
    let left = rect.left;
    if (left + POP_WIDTH > window.innerWidth - 8) left = window.innerWidth - POP_WIDTH - 8;
    if (left < 8) left = 8;

    const GAP = 6;
    const EDGE = 8;
    const CEILING = 420;
    const spaceBelow = window.innerHeight - rect.bottom - GAP - EDGE;
    const spaceAbove = rect.top - GAP - EDGE;

    if (spaceBelow >= spaceAbove) {
      setPos({ top: rect.bottom + GAP, bottom: null, left, maxHeight: Math.max(0, Math.min(CEILING, spaceBelow)) });
    } else {
      setPos({ top: null, bottom: window.innerHeight - rect.top + GAP, left, maxHeight: Math.max(0, Math.min(CEILING, spaceAbove)) });
    }
  }, [open]);

  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Scrolling/resizing while open would leave the popup floating over the wrong
  // spot (its position isn't re-measured live), so just close it instead --
  // except for scroll events from inside the popup's own scrollable area
  // (only reachable in constrained viewports now that it can be height-capped).
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (popRef.current?.contains(e.target)) return; setOpen(false); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);

  // Lock background scroll while open, same reasoning as SearchableSelect.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, [open]);

  // Jump the visible month back to the selected (or current) date every time it opens.
  useEffect(() => {
    if (!open) return;
    const d = value ? new Date(value + 'T00:00:00') : new Date();
    setViewMonth(new Date(d.getFullYear(), d.getMonth(), 1));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const todayIso = isoOf(startOfDay(new Date()));

  const cells = useMemo(() => {
    const last = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0);
    const gridStart = startOfWeek(viewMonth);
    const gridEnd = addDays(startOfWeek(last), 6);
    const total = Math.round((gridEnd - gridStart) / 86400000) + 1;
    return Array.from({ length: total }, (_, i) => addDays(gridStart, i));
  }, [viewMonth]);

  const pick = (d) => { onChange(isoOf(d)); setOpen(false); };
  const shiftMonth = (dir) => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + dir, 1));

  return (
    <div className={`dp-wrap ${className}`} ref={wrapRef}>
      <button type="button" className={`dp-trigger ${value ? '' : 'empty'}`} onClick={() => setOpen((o) => !o)}>
        <span className="dp-ic">📅</span>
        <span className="dp-val">{value ? fmtDate(value) : placeholder}</span>
        {clearable && value && (
          <span className="dp-clear" onClick={(e) => { e.stopPropagation(); onChange(''); }} role="button" aria-label="Clear date">×</span>
        )}
      </button>
      {open && createPortal(
        <div
          className="dp-pop"
          ref={popRef}
          style={{ left: pos.left, maxHeight: pos.maxHeight, ...(pos.bottom != null ? { bottom: pos.bottom } : { top: pos.top }) }}
        >
          <div className="dp-head">
            <button type="button" className="dp-nav" onClick={() => shiftMonth(-1)} aria-label="Previous month">‹</button>
            <span className="dp-month">{viewMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
            <button type="button" className="dp-nav" onClick={() => shiftMonth(1)} aria-label="Next month">›</button>
          </div>
          <div className="dp-grid">
            {WEEKDAY_LETTERS.map((w, i) => <div className="dp-wd" key={i}>{w}</div>)}
            {cells.map((d) => {
              const iso = isoOf(d);
              const cls = [
                d.getMonth() !== viewMonth.getMonth() ? 'out' : '',
                iso === todayIso ? 'today' : '',
                iso === value ? 'sel' : '',
              ].filter(Boolean).join(' ');
              return (
                <button type="button" key={iso} className={`dp-day ${cls}`} onClick={() => pick(d)}>
                  {d.getDate()}
                </button>
              );
            })}
          </div>
          <div className="dp-foot">
            <button type="button" className="dp-today-btn" onClick={() => pick(new Date())}>Today</button>
            {clearable && <button type="button" className="dp-clear-btn" onClick={() => { onChange(''); setOpen(false); }}>Clear</button>}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
});

// Multi-select variant of DatePicker, used for "Add time off" where a
// dispatcher picks several days off at once (mirrors chalkboard's own
// multi-date time-off picker) -- same portal/positioning/scroll-lock
// treatment as DatePicker, but `value` is an array of ISO date strings and
// clicking a day toggles it in/out of that array instead of picking-and-
// closing. The picker stays open across taps so several days can be picked
// in one sitting; the footer "Done" button just closes it, it doesn't submit.
const MultiDatePicker = React.memo(function MultiDatePicker({ value, onChange, placeholder = 'Select date(s)', className = '' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, bottom: null, left: 0, maxHeight: undefined });
  const [viewMonth, setViewMonth] = useState(() => {
    const d = value[0] ? new Date(value[0] + 'T00:00:00') : new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const wrapRef = useRef(null);
  const popRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const POP_WIDTH = 250;
    let left = rect.left;
    if (left + POP_WIDTH > window.innerWidth - 8) left = window.innerWidth - POP_WIDTH - 8;
    if (left < 8) left = 8;

    const GAP = 6;
    const EDGE = 8;
    const CEILING = 420;
    const spaceBelow = window.innerHeight - rect.bottom - GAP - EDGE;
    const spaceAbove = rect.top - GAP - EDGE;

    if (spaceBelow >= spaceAbove) {
      setPos({ top: rect.bottom + GAP, bottom: null, left, maxHeight: Math.max(0, Math.min(CEILING, spaceBelow)) });
    } else {
      setPos({ top: null, bottom: window.innerHeight - rect.top + GAP, left, maxHeight: Math.max(0, Math.min(CEILING, spaceAbove)) });
    }
  }, [open]);

  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (popRef.current?.contains(e.target)) return; setOpen(false); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, [open]);

  // Only jump the visible month on open if nothing's selected yet -- once
  // days are picked, re-opening shouldn't yank the view away from whatever
  // month the dispatcher was browsing.
  useEffect(() => {
    if (!open || value.length > 0) return;
    setViewMonth(new Date());
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const todayIso = isoOf(startOfDay(new Date()));

  const cells = useMemo(() => {
    const last = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0);
    const gridStart = startOfWeek(viewMonth);
    const gridEnd = addDays(startOfWeek(last), 6);
    const total = Math.round((gridEnd - gridStart) / 86400000) + 1;
    return Array.from({ length: total }, (_, i) => addDays(gridStart, i));
  }, [viewMonth]);

  const toggle = (d) => {
    const iso = isoOf(d);
    onChange(value.includes(iso) ? value.filter((v) => v !== iso) : [...value, iso].sort());
  };
  const shiftMonth = (dir) => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + dir, 1));

  const label = value.length === 0 ? placeholder : value.length === 1 ? fmtDate(value[0]) : `${value.length} days selected`;

  return (
    <div className={`dp-wrap ${className}`} ref={wrapRef}>
      <button type="button" className={`dp-trigger ${value.length === 0 ? 'empty' : ''}`} onClick={() => setOpen((o) => !o)}>
        <span className="dp-ic">📅</span>
        <span className="dp-val">{label}</span>
      </button>
      {open && createPortal(
        <div
          className="dp-pop"
          ref={popRef}
          style={{ left: pos.left, maxHeight: pos.maxHeight, ...(pos.bottom != null ? { bottom: pos.bottom } : { top: pos.top }) }}
        >
          <div className="dp-head">
            <button type="button" className="dp-nav" onClick={() => shiftMonth(-1)} aria-label="Previous month">‹</button>
            <span className="dp-month">{viewMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
            <button type="button" className="dp-nav" onClick={() => shiftMonth(1)} aria-label="Next month">›</button>
          </div>
          <div className="dp-grid">
            {WEEKDAY_LETTERS.map((w, i) => <div className="dp-wd" key={i}>{w}</div>)}
            {cells.map((d) => {
              const iso = isoOf(d);
              const cls = [
                d.getMonth() !== viewMonth.getMonth() ? 'out' : '',
                iso === todayIso ? 'today' : '',
                value.includes(iso) ? 'sel' : '',
              ].filter(Boolean).join(' ');
              return (
                <button type="button" key={iso} className={`dp-day ${cls}`} onClick={() => toggle(d)}>
                  {d.getDate()}
                </button>
              );
            })}
          </div>
          <div className="dp-foot">
            <span className="dp-count">{value.length} day{value.length === 1 ? '' : 's'} selected</span>
            <button type="button" className="dp-today-btn" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
});

// Every 30 minutes across the full 24-hour day for TimePicker's scrollable
// preset list -- the directly-typeable text field above it already covers
// any exact HH:MM, so this is just quick-scan convenience, not the only way
// to enter a time.
const TIME_SLOTS = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2);
  const m = (i % 2) * 30;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
});

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Distinct start times other techs already have on a job, for TimePicker's
// quick-pick chips when adding a NEW assignment -- groups existing sibling
// assignments by startTime (skipping ones without one yet) and collects
// every tech name sharing that time, sorted earliest-first.
function deriveTimeQuickPicks(assignments) {
  const byTime = new Map();
  assignments.forEach((a) => {
    if (!a.startTime) return;
    if (!byTime.has(a.startTime)) byTime.set(a.startTime, []);
    byTime.get(a.startTime).push(a.technicianName || 'Tech');
  });
  return [...byTime.entries()]
    .sort(([t1], [t2]) => t1.localeCompare(t2))
    .map(([time, techNames]) => ({ time, techNames }));
}

// Custom time dropdown replacing native <input type="time"> for job-assignment
// (and time-off / schedule-request) start/end times -- modeled directly on
// DatePicker (portaled position:fixed panel, same flip-above/clamp-height/
// outside-click/scroll-close/body-lock handling) so it's visually and
// behaviorally consistent with the DatePicker sitting right next to it in
// every assignment row. Unlike a plain preset list, a directly-typeable
// HH:MM field is included so the app doesn't lose the native input's full
// 24-hour, any-minute range -- the TIME_SLOTS list below it is a quick-pick
// convenience, not the only way in. `value` may be '' (some call sites have
// no sensible default, e.g. an unset end time) -- `placeholder` is shown
// instead of forcing a fallback value inside the component itself, since
// each call site already knows whether it wants to default to something
// like '07:00' or leave it genuinely blank. `onChange(hhmm)` fires only when
// a selection is actually finalized (preset click, quick-pick click, or
// Enter/blur on the text field with a valid value) -- never on every
// keystroke. `quickPicks` (optional): [{ time: 'HH:MM', techNames: string[] }].
const TimePicker = React.memo(function TimePicker({ value, onChange, quickPicks, disabled = false, title, className = '', placeholder = '--:--', clearable = false }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, bottom: null, left: 0, maxHeight: undefined });
  const [text, setText] = useState(value || '');
  const wrapRef = useRef(null);
  const popRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const POP_WIDTH = 240;
    let left = rect.left;
    if (left + POP_WIDTH > window.innerWidth - 8) left = window.innerWidth - POP_WIDTH - 8;
    if (left < 8) left = 8;

    const GAP = 6;
    const EDGE = 8;
    const CEILING = 320;
    const spaceBelow = window.innerHeight - rect.bottom - GAP - EDGE;
    const spaceAbove = rect.top - GAP - EDGE;

    if (spaceBelow >= spaceAbove) {
      setPos({ top: rect.bottom + GAP, bottom: null, left, maxHeight: Math.max(0, Math.min(CEILING, spaceBelow)) });
    } else {
      setPos({ top: null, bottom: window.innerHeight - rect.top + GAP, left, maxHeight: Math.max(0, Math.min(CEILING, spaceAbove)) });
    }
  }, [open]);

  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (popRef.current?.contains(e.target)) return; setOpen(false); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, [open]);

  // Re-sync the typeable text field to the live `value` every time the
  // dropdown opens, so it never shows stale text left over from a previous
  // open/close cycle or an external change to `value` while it was closed.
  useEffect(() => {
    if (!open) return;
    setText(value || '');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (v) => { onChange(v); setOpen(false); };

  const commitTyped = () => {
    const t = text.trim();
    if (TIME_RE.test(t)) onChange(t);
    else setText(value || '');
  };

  return (
    <div className={`tp-wrap ${className}`} ref={wrapRef}>
      <button type="button" className={className} onClick={() => setOpen((o) => !o)} disabled={disabled} title={title}>
        {value || placeholder}
        {clearable && value && (
          <span className="tp-clear" onClick={(e) => { e.stopPropagation(); onChange(''); }} role="button" aria-label="Clear time">×</span>
        )}
      </button>
      {open && createPortal(
        <div
          className="tp-pop"
          ref={popRef}
          style={{ left: pos.left, maxHeight: pos.maxHeight, ...(pos.bottom != null ? { bottom: pos.bottom } : { top: pos.top }) }}
        >
          <input
            className="tp-text"
            type="text"
            inputMode="numeric"
            placeholder="HH:MM"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commitTyped}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { commitTyped(); setOpen(false); }
              if (e.key === 'Escape') setOpen(false);
            }}
            autoFocus
          />
          {quickPicks?.length > 0 && (
            <div className="tp-quick">
              {quickPicks.map((q) => (
                <button
                  type="button"
                  key={q.time}
                  className="tp-chip"
                  title={q.techNames.join(', ')}
                  onMouseDown={(e) => { e.preventDefault(); commit(q.time); }}
                >
                  {q.time} · {q.techNames.join(', ')}
                </button>
              ))}
            </div>
          )}
          <div className="tp-list">
            {TIME_SLOTS.map((t) => (
              <button
                type="button"
                key={t}
                className={`tp-option ${t === value ? 'sel' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); commit(t); }}
              >
                {t}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
});

function ContactsTab({ contacts, loading, accounts: allAccounts, onRefresh, onUpdateContact }) {
  const [search, setSearch] = useState('');
  const [parentFilter, setParentFilter] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [lidFilter, setLidFilter] = useState('');
  // Infinite scroll, mirroring the outstanding-jobs list's own mechanism
  // (see the top-level `visibleCount`/`scrollSentinelRef` in App()) --
  // contacts are already fully fetched client-side, so this only caps how
  // many rows are mounted, no extra fetch involved.
  const [visibleCount, setVisibleCount] = useState(50);
  const contactsSentinelRef = useRef(null);
  const [expanded, setExpanded] = useState(new Set());
  const [changingContact, setChangingContact] = useState(null); // accountId being reassigned
  const [pickerQuery, setPickerQuery] = useState('');
  const [saving, setSaving] = useState(false);
  // Editing now happens in ContactInfoModal (a real Edit button, same
  // component AccountsTab already uses) -- per direction 2026-08-28,
  // replacing the old per-field click-to-edit-in-place cells below, which
  // also had a real bug: the phone/email links' preventDefault (needed so a
  // click always opened the editor instead of following the link) meant
  // clicking a number to call it, or an email to mail it, silently did
  // nothing.
  const [viewingContactId, setViewingContactId] = useState(null);
  const viewingContact = viewingContactId ? contacts.find((c) => c.id === viewingContactId) : null;

  const toggle = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const contactOptions = useMemo(() =>
    contacts
      .map((c) => [c.id, c.name, c.company])
      .sort((a, b) => a[1].localeCompare(b[1]))
  , [contacts]);

  const handleChangeContact = async (accountId, contactId) => {
    setSaving(true);
    try {
      await api.updateAccountContact(accountId, contactId);
      setChangingContact(null);
      setPickerQuery('');
      await onRefresh();
    } catch (e) {
      alert(`Failed to update contact: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const parents = useMemo(() => {
    const map = new Map();
    contacts.forEach((c) => c.accounts.forEach((a) => { if (a.parentId && a.parentName) map.set(a.parentId, a.parentName); }));
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [contacts]);

  const accounts = useMemo(() => {
    const map = new Map();
    contacts.forEach((c) => c.accounts.forEach((a) => { if (a.id && a.name) map.set(a.id, a.name); }));
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [contacts]);

  const lids = useMemo(() => {
    const set = new Set();
    contacts.forEach((c) => c.accounts.forEach((a) => { if (a.lid != null && a.lid !== '') set.add(String(a.lid)); }));
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [contacts]);

  const filtered = useMemo(() => contacts.filter((c) => {
    if (parentFilter && !c.accounts.some((a) => a.parentId === parentFilter)) return false;
    if (accountFilter && !c.accounts.some((a) => a.id === accountFilter)) return false;
    if (lidFilter && !c.accounts.some((a) => String(a.lid) === lidFilter)) return false;
    if (search.trim() && !fuzzyNameMatch(search, c.name)) return false;
    return true;
  }), [contacts, search, parentFilter, accountFilter, lidFilter]);

  const hasFilter = search || parentFilter || accountFilter || lidFilter;

  // A new search/filter is a new list - start from the top, same as the
  // jobs list does.
  useEffect(() => {
    setVisibleCount(50);
  }, [search, parentFilter, accountFilter, lidFilter]);

  useEffect(() => {
    const el = contactsSentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) setVisibleCount((c) => c + 50);
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [filtered.length]);

  return (
    <section>
      <div className="view-head">
        <div><h2>Contacts</h2><p>{loading ? <LoadingDots label="Loading…" inline /> : `${contacts.length} contacts from Salesforce`}</p></div>
      </div>

      <div className="contacts-toolbar">
        <div className="searchbox" style={{ marginBottom: 0 }}>
          <span className="si">⌕</span>
          <input
            className="searchinput"
            type="text"
            placeholder="Search by name (typos OK)…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <SearchableSelect
          value={parentFilter}
          onChange={setParentFilter}
          options={parents}
          placeholder="Management company…"
        />
        <SearchableSelect
          value={accountFilter}
          onChange={setAccountFilter}
          options={accounts}
          placeholder="Building…"
        />
        <SearchableSelect
          value={lidFilter}
          onChange={setLidFilter}
          options={lids.map((l) => [l, `LID ${l}`])}
          placeholder="LID…"
        />
        {hasFilter && (
          <button className="clearrange" onClick={() => { setSearch(''); setParentFilter(''); setAccountFilter(''); setLidFilter(''); }}>
            Clear filters
          </button>
        )}
        {!loading && <span className="contact-count">{filtered.length} shown</span>}
      </div>

      {loading && (
        <div className="contacts-wrap contacts-screen">
          <table className="contacts-table">
            <thead>
              <tr><th>Name</th><th>Buildings</th><th>Phone</th><th>Email</th><th></th></tr>
            </thead>
            <tbody>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <tr key={i}>
                  <td><span className="skel-block" style={{ width: 120, height: 13, display: 'inline-block' }} /></td>
                  <td><span className="skel-block" style={{ width: 80, height: 13, display: 'inline-block' }} /></td>
                  <td><span className="skel-block" style={{ width: 90, height: 13, display: 'inline-block' }} /></td>
                  <td><span className="skel-block" style={{ width: 140, height: 13, display: 'inline-block' }} /></td>
                  <td><span className="skel-block" style={{ width: 44, height: 13, display: 'inline-block' }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!loading && filtered.length === 0 && (
        <div className="empty">{hasFilter ? 'No contacts match those filters.' : 'No contacts found.'}</div>
      )}
      {!loading && filtered.length > 0 && (
        <div className="contacts-wrap contacts-screen">
          <table className="contacts-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Buildings</th>
                <th>Phone</th>
                <th>Email</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, visibleCount).map((c) => (
                <tr key={c.id}>
                  <td>
                    <div className="contact-name">{c.name}</div>
                    {c.company && <div className="contact-title">{c.company}</div>}
                    {c.title && <div className="contact-title">{c.title}</div>}
                  </td>
                  <td>
                    {c.accounts.length === 0
                      ? <span className="na">-</span>
                      : <div className="contact-buildings">
                          <button className="buildings-toggle" onClick={() => toggle(c.id)}>
                            <span className="buildings-chevron">{expanded.has(c.id) ? '▾' : '▸'}</span>
                            <span>{c.accounts.length} {c.accounts.length === 1 ? 'building' : 'buildings'}</span>
                          </button>
                          {/* Cascade (App.jsx) -- always mounted (not
                              `expanded.has(c.id) &&`) so open/close is a real
                              animated transition, not an instant appear/
                              disappear. Per direction 2026-08-28: "a very
                              flowy feel... not clunky." */}
                          <Cascade open={expanded.has(c.id)}>
                            {c.accounts.map((a) => (
                              <div key={a.id} className="contact-building-row">
                                <div className="contact-building-meta">
                                  <span className="contact-building-name">{a.name}</span>
                                  {a.lid && <span className="lidtag">LID {a.lid}</span>}
                                </div>
                                <button
                                  className="change-contact-btn"
                                  onClick={() => {
                                    setChangingContact(changingContact === a.id ? null : a.id);
                                    setPickerQuery('');
                                  }}
                                >
                                  Change contact
                                </button>
                                {changingContact === a.id && (
                                  <div className="inline-contact-picker">
                                    <input
                                      className="icp-input"
                                      type="text"
                                      placeholder="Search contacts…"
                                      value={pickerQuery}
                                      onChange={(e) => setPickerQuery(e.target.value)}
                                      autoFocus
                                    />
                                    <div className="icp-list">
                                      {contactOptions
                                        .filter(([, name]) => !pickerQuery.trim() || fuzzyNameMatch(pickerQuery, name))
                                        .slice(0, 8)
                                        .map(([id, name, company]) => (
                                          <button
                                            key={id}
                                            className="icp-option"
                                            disabled={saving}
                                            onClick={() => handleChangeContact(a.id, id)}
                                          >
                                            <span className="icp-name">{name}</span>
                                            {company && <span className="icp-company">{company}</span>}
                                          </button>
                                        ))}
                                    </div>
                                    <button className="icp-cancel" onClick={() => { setChangingContact(null); setPickerQuery(''); }}>
                                      Cancel
                                    </button>
                                  </div>
                                )}
                              </div>
                            ))}
                          </Cascade>
                        </div>}
                  </td>
                  <td>
                    {!c.phone && !c.mobile && !c.fax
                      ? <span className="na">-</span>
                      : <div className="contact-numbers">
                          {c.phone && <div className="contact-number-row"><span className="contact-number-tag">Phone</span><a href={`tel:${c.phone}`} className="contact-link">{formatPhone(c.phone)}</a></div>}
                          {c.mobile && <div className="contact-number-row"><span className="contact-number-tag">Mobile</span><a href={`tel:${c.mobile}`} className="contact-link">{formatPhone(c.mobile)}</a></div>}
                          {c.fax && <div className="contact-number-row"><span className="contact-number-tag">Fax</span>{formatPhone(c.fax)}</div>}
                        </div>}
                  </td>
                  <td>
                    {c.email ? <a href={`mailto:${c.email}`} className="contact-link">{c.email}</a> : <span className="na">-</span>}
                  </td>
                  <td>
                    <button type="button" className="contact-edit-btn" onClick={() => setViewingContactId(c.id)}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {visibleCount < filtered.length && <div ref={contactsSentinelRef} className="scroll-sentinel" />}
        </div>
      )}
      {viewingContact && (
        <ContactInfoModal
          contact={viewingContact}
          accounts={allAccounts}
          onUpdateContact={onUpdateContact}
          onClose={() => setViewingContactId(null)}
        />
      )}
    </section>
  );
}

// Lists every contact whose standard AccountId lookup points at this account
// (plus the legacy Property_Contact_Name__c contact, tagged, if it's not
// already in that set) - modeled directly on NotesMenu's portaled-popup
// pattern (position/click-outside/scroll-lock effects, .notes-pop* CSS).
function AccountContactsMenu({ accountId, contacts, contactDirectory, propertyContactId, propertyContactName, onOpenContact, onLinkContact }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, bottom: null, left: 0, maxHeight: 420 });
  const [linking, setLinking] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const wrapRef = useRef(null);
  const popRef = useRef(null);

  const allContacts = useMemo(() => {
    if (propertyContactId && !contacts.some((c) => c.id === propertyContactId)) {
      return [...contacts, { id: propertyContactId, name: propertyContactName, title: null, __isPropertyContact: true }];
    }
    return contacts;
  }, [contacts, propertyContactId, propertyContactName]);

  // Only offer contacts not already shown in this account's own list - picking
  // an already-linked one would just be a same-value no-op.
  const linkedIds = useMemo(() => new Set(allContacts.map((c) => c.id)), [allContacts]);
  const contactOptions = useMemo(() =>
    contactDirectory
      .filter((c) => !linkedIds.has(c.id))
      .map((c) => [c.id, c.name, c.company])
      .sort((a, b) => a[1].localeCompare(b[1]))
  , [contactDirectory, linkedIds]);

  useEffect(() => {
    if (!open) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const POP_WIDTH = 320;
    const GAP = 6;
    const EDGE = 8;
    const CEILING = 420;
    let left = rect.left;
    if (left + POP_WIDTH > window.innerWidth - EDGE) left = window.innerWidth - POP_WIDTH - EDGE;
    if (left < EDGE) left = EDGE;
    const spaceBelow = window.innerHeight - rect.bottom - GAP - EDGE;
    const spaceAbove = rect.top - GAP - EDGE;
    if (spaceBelow >= spaceAbove) {
      setPos({ top: rect.bottom + GAP, bottom: null, left, maxHeight: Math.max(0, Math.min(CEILING, spaceBelow)) });
    } else {
      setPos({ top: null, bottom: window.innerHeight - rect.top + GAP, left, maxHeight: Math.max(0, Math.min(CEILING, spaceAbove)) });
    }
  }, [open]);

  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (popRef.current?.contains(e.target)) return; setOpen(false); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, [open]);

  // Reset the in-progress picker whenever the popup itself closes, so
  // reopening it doesn't resume a stale in-flight link.
  useEffect(() => {
    if (!open) { setLinking(false); setPickerQuery(''); }
  }, [open]);

  const openContact = (contact) => { setOpen(false); onOpenContact(contact.id); };

  const commitLink = async (contactId) => {
    setSaving(true);
    try {
      await onLinkContact(accountId, contactId);
      setLinking(false);
      setPickerQuery('');
    } catch (e) {
      alert(`Failed to link contact: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="notes-menu-wrap" ref={wrapRef}>
      <button className="buildings-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="buildings-chevron">{open ? '▾' : '▸'}</span>
        <span>Account Contacts{allContacts.length > 0 ? ` (${allContacts.length})` : ''}</span>
      </button>
      {open && createPortal(
        <div
          className="notes-pop"
          ref={popRef}
          style={{ left: pos.left, maxHeight: pos.maxHeight, ...(pos.bottom != null ? { bottom: pos.bottom } : { top: pos.top }) }}
        >
          <div className="notes-pop-head">
            <span>Account Contacts</span>
            <button className="notes-new-btn" onClick={() => { setLinking((v) => !v); setPickerQuery(''); }}>
              + Add contact
            </button>
          </div>
          {linking && (
            <div className="inline-contact-picker">
              <input
                className="icp-input"
                type="text"
                placeholder="Search contacts…"
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                autoFocus
              />
              <div className="icp-list">
                {contactOptions
                  .filter(([, name]) => !pickerQuery.trim() || fuzzyNameMatch(pickerQuery, name))
                  .slice(0, 8)
                  .map(([id, name, company]) => (
                    <button
                      key={id}
                      className="icp-option"
                      disabled={saving}
                      onClick={() => commitLink(id)}
                    >
                      <span className="icp-name">{name}</span>
                      {company && <span className="icp-company">{company}</span>}
                    </button>
                  ))}
              </div>
              <button className="icp-cancel" onClick={() => { setLinking(false); setPickerQuery(''); }}>
                Cancel
              </button>
            </div>
          )}
          <div className="notes-pop-list">
            {allContacts.length === 0 && (
              <div className="notes-pop-empty">No contacts linked to this account.</div>
            )}
            {allContacts.map((c) => (
              <button className="notes-pop-item" key={c.id} onClick={() => openContact(c)}>
                <span className="notes-pop-title-row">
                  <span className="notes-pop-title">{c.name}</span>
                  {c.id === propertyContactId && <span className="notes-pop-job-tag">Property contact</span>}
                </span>
                {c.title && <span className="notes-pop-preview">{c.title}</span>}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// AP contact - a single-value Contact lookup living directly on the Account,
// but backed by one of two different SF fields depending on the account's own
// kind: Accounts_Payable_Contact_Name__c for management/Customer accounts,
// AP_Contact__c for LID/property accounts (a LID account's AP contact can
// genuinely differ from its parent management company's, so this never
// inherits/copies from the parent - each account reads and writes its own
// field). Unlike AccountContactsMenu, this menu also owns the reassignment
// picker (same inline search-and-pick UI the old Property Contact block used
// to have).
function PaymentContactMenu({ account, contacts, onOpenContact, onChangeAccountContact }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, bottom: null, left: 0, maxHeight: 420 });
  const [changingField, setChangingField] = useState(null); // 'apManagement' | 'apLid' | null
  const [pickerQuery, setPickerQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const wrapRef = useRef(null);
  const popRef = useRef(null);

  // Which literal SF field this account's AP contact writes to - the backend
  // (GET /accounts) already resolved apContactId/apContactName using the same
  // RecordType check, so this just has to agree with that for writes.
  const apField = account.recordType === 'LID_Account' ? 'apLid' : 'apManagement';

  const contactOptions = useMemo(() =>
    contacts
      .map((c) => [c.id, c.name, c.company])
      .sort((a, b) => a[1].localeCompare(b[1]))
  , [contacts]);

  useEffect(() => {
    if (!open) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const POP_WIDTH = 320;
    const GAP = 6;
    const EDGE = 8;
    const CEILING = 420;
    let left = rect.left;
    if (left + POP_WIDTH > window.innerWidth - EDGE) left = window.innerWidth - POP_WIDTH - EDGE;
    if (left < EDGE) left = EDGE;
    const spaceBelow = window.innerHeight - rect.bottom - GAP - EDGE;
    const spaceAbove = rect.top - GAP - EDGE;
    if (spaceBelow >= spaceAbove) {
      setPos({ top: rect.bottom + GAP, bottom: null, left, maxHeight: Math.max(0, Math.min(CEILING, spaceBelow)) });
    } else {
      setPos({ top: null, bottom: window.innerHeight - rect.top + GAP, left, maxHeight: Math.max(0, Math.min(CEILING, spaceAbove)) });
    }
  }, [open]);

  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (popRef.current?.contains(e.target)) return; setOpen(false); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, [open]);

  // Reset the in-progress picker whenever the popup itself closes, so
  // reopening it doesn't resume a stale in-flight edit.
  useEffect(() => {
    if (!open) { setChangingField(null); setPickerQuery(''); }
  }, [open]);

  const commitChange = async (field, contactId) => {
    setSaving(true);
    try {
      await onChangeAccountContact(account.id, field, contactId);
      setChangingField(null);
      setPickerQuery('');
    } catch (e) {
      alert(`Failed to update contact: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const renderRow = (label, field, contactId, contactName) => (
    <div className="notes-pop-item" key={field} style={{ cursor: 'default' }}>
      <span className="notes-pop-title-row">
        <span className="notes-pop-title">{label}</span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {contactName
          ? <button className="linklike" onClick={() => { setOpen(false); onOpenContact(contactId); }}>{contactName}</button>
          : <span className="na">-</span>}
        <button
          className="change-contact-btn"
          onClick={() => {
            setChangingField(changingField === field ? null : field);
            setPickerQuery('');
          }}
        >
          Change contact
        </button>
      </span>
      {changingField === field && (
        <div className="inline-contact-picker">
          <input
            className="icp-input"
            type="text"
            placeholder="Search contacts…"
            value={pickerQuery}
            onChange={(e) => setPickerQuery(e.target.value)}
            autoFocus
          />
          <div className="icp-list">
            {contactOptions
              .filter(([, name]) => !pickerQuery.trim() || fuzzyNameMatch(pickerQuery, name))
              .slice(0, 8)
              .map(([id, name, company]) => (
                <button
                  key={id}
                  className="icp-option"
                  disabled={saving}
                  onClick={() => commitChange(field, id)}
                >
                  <span className="icp-name">{name}</span>
                  {company && <span className="icp-company">{company}</span>}
                </button>
              ))}
          </div>
          <button className="icp-cancel" onClick={() => { setChangingField(null); setPickerQuery(''); }}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="notes-menu-wrap" ref={wrapRef}>
      <button className="buildings-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="buildings-chevron">{open ? '▾' : '▸'}</span>
        <span>Payment Contact</span>
      </button>
      {open && createPortal(
        <div
          className="notes-pop"
          ref={popRef}
          style={{ left: pos.left, maxHeight: pos.maxHeight, ...(pos.bottom != null ? { bottom: pos.bottom } : { top: pos.top }) }}
        >
          <div className="notes-pop-head">
            <span>Payment Contact</span>
          </div>
          <div className="notes-pop-list">
            {renderRow('AP Contact', apField, account.apContactId, account.apContactName)}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function AccountsTab({ accounts, loading, contacts, onRefresh, onUpdateAccount, onUpdateContact }) {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [lidFilter, setLidFilter] = useState('');
  // Filters which management-company dropdowns show - unlike the other
  // filters above, it never narrows the accounts *inside* a matching group.
  const [companyFilter, setCompanyFilter] = useState('');
  const [showOverdue, setShowOverdue] = useState(false);
  const [showReadyToBill, setShowReadyToBill] = useState(false);
  const [expanded, setExpanded] = useState(new Set());
  // Id only, not a snapshot - so if the account is edited while the modal's
  // open, it re-derives the latest record from `accounts` on every render
  // instead of showing stale data (same reasoning as viewingContactId
  // below). Replaces the old per-field click-to-edit-in-place cells (was
  // `editing`/startEdit/commitEdit/editableCell) -- per direction
  // 2026-08-28, same change already made for ContactsTab: a real Edit
  // button opening AccountInfoModal, not click-to-edit on scattered fields.
  const [editingAccountId, setEditingAccountId] = useState(null);
  // Id only, not a snapshot - so if the contact is edited (in this popup or
  // elsewhere) while it's open, the popup re-derives the latest record from
  // `contactsById` on every render instead of showing stale data.
  const [viewingContactId, setViewingContactId] = useState(null);
  // { accountId, kind: 'unpaid' | 'readyToBill' } | null - id-based for the
  // same reason as viewingContactId above.
  const [viewingBilling, setViewingBilling] = useState(null);

  const handleChangeAccountContact = useCallback(async (accountId, field, contactId) => {
    await api.updateAccountContact(accountId, contactId, field);
    await onRefresh();
  }, [onRefresh]);

  const handleLinkAccountContact = useCallback((accountId, contactId) => onUpdateContact(contactId, { accountId }), [onUpdateContact]);

  const toggle = useCallback((id) => setExpanded((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  }), []);

  const contactsById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const viewingContact = viewingContactId ? contactsById.get(viewingContactId) ?? null : null;
  const viewingBillingAccount = viewingBilling ? accounts.find((a) => a.id === viewingBilling.accountId) ?? null : null;
  const editingAccount = editingAccountId ? accounts.find((a) => a.id === editingAccountId) ?? null : null;

  // Contacts whose standard AccountId lookup points at each account, grouped
  // once (not filtered per row) to avoid an O(n²) scan over the full contacts
  // list on every render.
  const contactsByAccountId = useMemo(() => {
    const map = new Map();
    for (const c of contacts) {
      if (!c.accountId) continue;
      const arr = map.get(c.accountId) ?? [];
      arr.push(c);
      map.set(c.accountId, arr);
    }
    return map;
  }, [contacts]);

  const types = useMemo(() => {
    const set = new Set();
    accounts.forEach((a) => { if (a.type) set.add(a.type); });
    return [...set].sort((x, y) => x.localeCompare(y));
  }, [accounts]);

  const lids = useMemo(() => {
    const set = new Set();
    accounts.forEach((a) => { if (a.lid != null && a.lid !== '') set.add(String(a.lid)); });
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [accounts]);

  const overdueCount = useMemo(() => accounts.filter((a) => a.unpaidJobs?.length > 0).length, [accounts]);
  const readyToBillCount = useMemo(() => accounts.filter((a) => a.readyToBillJobs?.length > 0).length, [accounts]);

  const filtered = useMemo(() => accounts.filter((a) => {
    if (typeFilter && a.type !== typeFilter) return false;
    if (lidFilter && String(a.lid) !== lidFilter) return false;
    if (search.trim()) {
      const haystack = [a.name, a.street, a.city, a.state, a.zip].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(search.trim().toLowerCase())) return false;
    }
    // Both on = intersection (account must qualify for both), not union.
    if (showOverdue && !(a.unpaidJobs?.length > 0)) return false;
    if (showReadyToBill && !(a.readyToBillJobs?.length > 0)) return false;
    return true;
  }), [accounts, search, typeFilter, lidFilter, showOverdue, showReadyToBill]);

  const hasFilter = search || typeFilter || lidFilter || companyFilter || showOverdue || showReadyToBill;

  // Once a name/address search narrows things down to a small, unambiguous
  // set of accounts, auto-expand their management-company group(s) instead
  // of making the dispatcher click open an accordion to see the very thing
  // the search just found.
  const searchNarrowed = search.trim().length > 0 && filtered.length > 0 && filtered.length <= 5;

  // A management company is just an Account like any other - it can carry
  // its own unpaidJobs/readyToBillJobs (billed directly to the company, not
  // to one of its buildings). Grouping purely by `a.parentId` would only
  // ever place an account as a *child*; it'd never recognize that an
  // account's own id might *be* a group key, burying the company's own
  // billing data under "No Management Company." managementCompanyIds is
  // built from the full `accounts` list (not `filtered`) purely to *identify*
  // which accounts are companies - whether one actually shows as its own
  // group's anchor still depends on it passing the current filter, same as
  // any other account (an account that doesn't match the filter shouldn't
  // linger at the top of a group just because one of its children did).
  const managementCompanyIds = useMemo(() => {
    const set = new Set();
    accounts.forEach((a) => { if (a.parentId) set.add(a.parentId); });
    return set;
  }, [accounts]);

  const groups = useMemo(() => {
    const map = new Map(); // key -> { key, name, accounts: [] }
    const ensure = (key, name) => {
      if (!map.has(key)) map.set(key, { key, name, accounts: [] });
      return map.get(key);
    };

    for (const a of filtered) {
      // Not exclusive: an account can be both a child of its own parent AND
      // the management company anchoring its own children's group.
      if (managementCompanyIds.has(a.id)) ensure(a.id, a.name).accounts.push({ ...a, __isManagementCompany: true });
      if (a.parentId) ensure(a.parentId, a.parentName).accounts.push(a);
      else if (!managementCompanyIds.has(a.id)) ensure('UNASSIGNED', 'No Management Company').accounts.push(a);
    }

    const list = [...map.values()];
    list.sort((x, y) => x.key === 'UNASSIGNED' ? 1 : y.key === 'UNASSIGNED' ? -1 : x.name.localeCompare(y.name));
    return list;
  }, [filtered, managementCompanyIds]);

  // Picks which dropdowns show, at the group level only - a matching
  // group's accounts are never narrowed by this, unlike the filters above.
  const visibleGroups = useMemo(() => {
    if (!companyFilter.trim()) return groups;
    const q = companyFilter.trim().toLowerCase();
    return groups.filter((g) => g.name.toLowerCase().includes(q));
  }, [groups, companyFilter]);

  // Windowed rendering of the group list itself - mirrors the Jobs list /
  // Contacts tab / SearchableSelect pattern so typing a broad query doesn't
  // force every management-company header (and its badge-count math) to
  // mount at once.
  const [visibleGroupCount, setVisibleGroupCount] = useState(30);
  const groupSentinelRef = useRef(null);

  useEffect(() => { setVisibleGroupCount(30); }, [visibleGroups.length]);

  useEffect(() => {
    const el = groupSentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) setVisibleGroupCount((c) => c + 30);
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [visibleGroups.length]);

  useEffect(() => {
    if (!viewingContactId) return;
    const onKey = (e) => { if (e.key === 'Escape') setViewingContactId(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [viewingContactId]);

  useEffect(() => {
    if (!viewingBilling) return;
    const onKey = (e) => { if (e.key === 'Escape') setViewingBilling(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [viewingBilling]);

  const addressLine = (a) => [a.street, [a.city, a.state].filter(Boolean).join(', '), a.zip].filter(Boolean).join(' ') || null;

  const renderAccountRow = useCallback((a) => (
    <React.Fragment key={a.id}>
      <tr>
        <td>
          <span className="contact-name">{search.trim() ? highlightMatch(a.name, search) : a.name}</span>
          {a.__isManagementCompany && <span className="mgmt-co-tag">Management Co.</span>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="buildings-toggle" onClick={() => toggle(a.id)}>
              <span className="buildings-chevron">{expanded.has(a.id) ? '▾' : '▸'}</span>
              <span>Account Details</span>
            </button>
            <AccountContactsMenu
              accountId={a.id}
              contacts={contactsByAccountId.get(a.id) ?? []}
              contactDirectory={contacts}
              propertyContactId={a.propertyContactId}
              propertyContactName={a.propertyContactName}
              onOpenContact={setViewingContactId}
              onLinkContact={handleLinkAccountContact}
            />
            <PaymentContactMenu
              account={a}
              contacts={contacts}
              onOpenContact={setViewingContactId}
              onChangeAccountContact={handleChangeAccountContact}
            />
            <button type="button" className="contact-edit-btn" onClick={() => setEditingAccountId(a.id)}>Edit</button>
          </div>
        </td>
        <td data-label="Type">{a.type ?? <span className="na">-</span>}</td>
        <td data-label="LID">{a.lid ? <span className="lidtag">LID {a.lid}</span> : <span className="na">-</span>}</td>
        <td data-label="Address">{addressLine(a) ? (search.trim() ? highlightMatch(addressLine(a), search) : addressLine(a)) : <span className="na">-</span>}</td>
        <td data-label="Phone">
          {a.phone ? <a href={`tel:${a.phone}`} className="contact-link">{formatPhone(a.phone)}</a> : <span className="na">-</span>}
        </td>
        <td data-label="Billing">
          {(a.unpaidJobs?.length > 0 || a.readyToBillJobs?.length > 0) ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
              {a.unpaidJobs?.length > 0 && (
                <button className="badge emergency badge-btn" onClick={() => setViewingBilling({ accountId: a.id, kind: 'unpaid' })}>
                  Overdue ({a.unpaidJobs.length})
                </button>
              )}
              {a.readyToBillJobs?.length > 0 && (
                <button className="badge dispatched badge-btn" onClick={() => setViewingBilling({ accountId: a.id, kind: 'readyToBill' })}>
                  Ready to Bill ({a.readyToBillJobs.length})
                </button>
              )}
            </div>
          ) : <span className="na">-</span>}
        </td>
      </tr>
      {/* Row/cell always mounted (not `expanded.has(a.id) &&`) so the tr/td
          stay real table elements on desktop -- the open/close animation
          lives entirely on the Cascade component inside the td, not on the
          table structure itself. Per direction 2026-08-28: "a very flowy
          feel... not clunky." */}
      {/* .account-detail-row, not .contact-building-row -- that class is
          already used elsewhere (the Contacts buildings-list <div>, a
          completely different element). CSS in this app is plain global
          imports, not component-scoped (see CLAUDE.md); reusing it here
          would have silently pulled in .contact-building-row's own
          display:flex styling onto this <tr>, fighting the table layout
          on desktop. */}
      <tr className="account-detail-row">
        <td colSpan={6}>
          <Cascade open={expanded.has(a.id)}>
            <div className="contact-building-meta" style={{ flexWrap: 'wrap', gap: '1.5rem' }}>
              <span>Street: {a.street || <span className="na">-</span>}</span>
              <span>City: {a.city || <span className="na">-</span>}</span>
              <span>State: {a.state || <span className="na">-</span>}</span>
              <span>Zip: {a.zip || <span className="na">-</span>}</span>
              <span>Website: {a.website || <span className="na">-</span>}</span>
              <span>Industry: {a.industry || <span className="na">-</span>}</span>
              <span>Management company: {a.parentName ?? <span className="na">-</span>}</span>
            </div>
          </Cascade>
        </td>
      </tr>
    </React.Fragment>
  ), [expanded, search, toggle, contactsByAccountId, contacts, handleLinkAccountContact, handleChangeAccountContact]);

  return (
    <section>
      <div className="view-head">
        <div><h2>Accounts</h2><p>{loading ? <LoadingDots label="Loading…" inline /> : `${accounts.length} accounts from Salesforce`}</p></div>
      </div>

      <div className="contacts-toolbar">
        <div className="searchbox" style={{ marginBottom: 0 }}>
          <span className="si">⌕</span>
          <input
            className="searchinput"
            type="text"
            placeholder="Search by name or address…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <SearchableSelect
          value={typeFilter}
          onChange={setTypeFilter}
          options={types.map((t) => [t, t])}
          placeholder="Type…"
        />
        <SearchableSelect
          value={lidFilter}
          onChange={setLidFilter}
          options={lids.map((l) => [l, `LID ${l}`])}
          placeholder="LID…"
        />
        <div className="searchbox" style={{ marginBottom: 0 }}>
          <span className="si">⌕</span>
          <input
            className="searchinput"
            type="text"
            placeholder="Search by management company…"
            value={companyFilter}
            onChange={(e) => setCompanyFilter(e.target.value)}
          />
        </div>
        <button className={`chip ${showOverdue ? 'on' : ''}`} onClick={() => setShowOverdue((v) => !v)}>
          Overdue<span className="ct">{overdueCount}</span>
        </button>
        <button className={`chip ${showReadyToBill ? 'on' : ''}`} onClick={() => setShowReadyToBill((v) => !v)}>
          Ready to Bill<span className="ct">{readyToBillCount}</span>
        </button>
        {hasFilter && (
          <button className="clearrange" onClick={() => { setSearch(''); setTypeFilter(''); setLidFilter(''); setCompanyFilter(''); setShowOverdue(false); setShowReadyToBill(false); }}>
            Clear filters
          </button>
        )}
        {!loading && <span className="contact-count">{filtered.length} shown</span>}
      </div>

      {loading && (
        <div className="contacts-wrap accounts-screen">
          <table className="contacts-table">
            <thead>
              <tr><th>Name</th><th>Type</th><th>LID</th><th>Address</th><th>Phone</th><th>Billing</th></tr>
            </thead>
            <tbody>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <tr key={i}>
                  <td><span className="skel-block" style={{ width: 120, height: 13, display: 'inline-block' }} /></td>
                  <td><span className="skel-block" style={{ width: 80, height: 13, display: 'inline-block' }} /></td>
                  <td><span className="skel-block" style={{ width: 50, height: 13, display: 'inline-block' }} /></td>
                  <td><span className="skel-block" style={{ width: 160, height: 13, display: 'inline-block' }} /></td>
                  <td><span className="skel-block" style={{ width: 90, height: 13, display: 'inline-block' }} /></td>
                  <td><span className="skel-block" style={{ width: 70, height: 13, display: 'inline-block' }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!loading && filtered.length === 0 && (
        <div className="empty">{hasFilter ? 'No accounts match those filters.' : 'No accounts found.'}</div>
      )}
      {!loading && filtered.length > 0 && visibleGroups.length === 0 && (
        <div className="empty">No management companies match “{companyFilter}”.</div>
      )}
      {!loading && filtered.length > 0 && visibleGroups.length > 0 && (
        <div className="mgmt-groups">
          {visibleGroups.slice(0, visibleGroupCount).map((g) => (
            <AccountGroupSection key={g.key} name={g.name} accounts={g.accounts} renderRow={renderAccountRow} forceOpen={searchNarrowed} />
          ))}
          {visibleGroupCount < visibleGroups.length && <div ref={groupSentinelRef} className="scroll-sentinel" />}
        </div>
      )}
      {viewingContact && (
        <ContactInfoModal
          contact={viewingContact}
          accounts={accounts}
          onUpdateContact={onUpdateContact}
          onClose={() => setViewingContactId(null)}
        />
      )}
      {viewingBilling && viewingBillingAccount && (
        <BillingJobsModal
          account={viewingBillingAccount}
          kind={viewingBilling.kind}
          onClose={() => setViewingBilling(null)}
        />
      )}
      {editingAccount && (
        <AccountInfoModal
          account={editingAccount}
          onUpdateAccount={onUpdateAccount}
          onClose={() => setEditingAccountId(null)}
        />
      )}
    </section>
  );
}

// Expand/collapse animation, JS-measured max-height rather than the pure-
// CSS grid-template-rows:0fr->1fr trick this used to be (found live
// 2026-08-28 that the CSS-only version could get visibly stuck partway
// through, in both directions, for some content -- the fr-unit
// interpolation it relies on isn't reliably hitting its true end state for
// every kind of content).
//
// Second bug, also found live 2026-08-28: Cascades can now nest (a row's
// own Account Details Cascade sits inside AccountGroupSection's group-level
// Cascade). The first version of this measured scrollHeight once at the
// moment of toggling, then released to a flat 'auto' after the transition
// settled -- fine for a leaf Cascade, but the OUTER one already has no
// reason to run its own effect again just because something nested inside
// it later grows, so it never re-measured and clipped the newly-expanded
// nested content instead of growing to fit it (confirmed live: the row's
// own scrollHeight measured correctly, non-zero, but nothing appeared --
// space for it simply wasn't there, wrong layer). ResizeObserver replaces
// the "measure once, then trust it" approach with continuous tracking:
// while open, max-height is kept in sync with the content's real size on
// every resize, not just at toggle time, so nested growth anywhere inside
// propagates outward automatically. transform-affecting animation on the
// observed element itself doesn't cause feedback loops -- ResizeObserver
// fires on border-box size changes, not on max-height/transform, and this
// component doesn't change the border-box size of the element IT observes
// (.cascade-panel-inner) in response to its own state, only of the parent
// .cascade-panel wrapper.
function Cascade({ open, children }) {
  const innerRef = useRef(null);
  // Always starts at '0px', even when `open` is already true on the very
  // first render (LazyCascade mounts Cascade fresh at the moment a group
  // is first opened) -- that's what makes that first open still animate
  // instead of the content just appearing already fully expanded.
  const [height, setHeight] = useState('0px');
  const isFirst = useRef(true);

  // Continuous sync while open -- see the note above. Deliberately not
  // running while closed: we WANT height clamped to 0 there regardless of
  // the (invisible) content's real size.
  useEffect(() => {
    const el = innerRef.current;
    if (!el || !open) return;
    const ro = new ResizeObserver(() => setHeight(`${el.scrollHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  // Handles the actual open/close transitions -- the ResizeObserver above
  // only starts tracking once this has already set a real starting height.
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    if (isFirst.current) {
      isFirst.current = false;
      // Mounting already-closed (the normal default for every row) -- stay
      // at 0px, nothing to animate. Real bug, found live 2026-08-28: this
      // used to run the full "closing" sequence unconditionally on every
      // mount, which meant every row flashed open then snapped shut the
      // instant it (or an ancestor group) first mounted.
      if (!open) return;
      setHeight(`${el.scrollHeight}px`);
      return;
    }
    if (open) {
      setHeight(`${el.scrollHeight}px`);
      return;
    }
    // Closing: max-height may currently be a stale/continuously-updated px
    // value from the ResizeObserver, which is fine to transition FROM
    // directly -- snap to the current real height (one paint), then flip
    // to 0 on the next frame so the browser has two real states to
    // interpolate between.
    setHeight(`${el.scrollHeight}px`);
    let raf1, raf2;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setHeight('0px'));
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [open]);

  return (
    <div className={`cascade-panel ${open ? 'expanded' : ''}`} style={{ maxHeight: height }}>
      <div ref={innerRef} className="cascade-panel-inner">{children}</div>
    </div>
  );
}

// Lazy-mounted Cascade -- for group toggles that can genuinely hold a lot
// of content (AccountGroupSection's "No Management Company" group alone
// can hold thousands of accounts; same shared .mgmt-group-header pattern
// is used by JobInvoiceRow and PartsTab's Opportunity groups too), always-
// mounting like ContactsTab/AccountsTab's small per-row expands do would
// mean every collapsed group on the page renders its content anyway, just
// visually hidden -- real cost for no visible benefit while collapsed.
// Renders nothing until `open` first goes true, then behaves exactly like
// a normal Cascade from then on -- Cascade's own open=false initial state
// (max-height '0px', not 'auto') is what makes that very first open still
// animate instead of the content just appearing already expanded.
function LazyCascade({ open, children }) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => { if (open && !mounted) setMounted(true); }, [open, mounted]);
  if (!mounted) return null;
  return <Cascade open={open}>{children}</Cascade>;
}

const AccountGroupSection = React.memo(function AccountGroupSection({ name, accounts, renderRow, forceOpen }) {
  const [open, setOpen] = useState(false);
  // Own visibleCount/sentinel, scoped to this group only - "No Management
  // Company" alone can hold thousands of accounts, while most groups are
  // small enough to just render in full once opened.
  const [visibleCount, setVisibleCount] = useState(50);
  // Callback ref, not useRef+useEffect(watching `open`) -- now that the
  // content renders through LazyCascade (below), the sentinel <div> can
  // take an extra render cycle to actually appear in the DOM after `open`
  // flips true (LazyCascade mounts on the frame after `open` becomes true,
  // not the same one). An effect keyed on `open` could fire before the
  // node exists and silently find `sentinelRef.current` still null. A
  // callback ref sidesteps the whole timing question -- React calls it
  // exactly when the node is actually attached/detached, however many
  // renders that took.
  const observerRef = useRef(null);
  const sentinelRef = useCallback((el) => {
    if (observerRef.current) { observerRef.current.disconnect(); observerRef.current = null; }
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) setVisibleCount((c) => c + 50);
    }, { rootMargin: '400px' });
    io.observe(el);
    observerRef.current = io;
  }, []);

  // A narrowed search (see searchNarrowed in AccountsTab) flips this true so
  // the group holding the match(es) opens itself - doesn't fight a manual
  // collapse afterward since it only fires on the false->true transition.
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  // Total overdue/ready-to-bill *jobs* across the group - counting invoices
  // instead used to make the badge vanish entirely for jobs that don't have
  // an Invoicing__c record on file yet, even though they still need billing.
  // Memoized because "No Management Company" can hold thousands of accounts
  // and this shouldn't re-run on every unrelated re-render.
  const overdueCount = useMemo(() => accounts.reduce((s, a) => s + (a.unpaidJobs?.length || 0), 0), [accounts]);
  const readyToBillCount = useMemo(() => accounts.reduce((s, a) => s + (a.readyToBillJobs?.length || 0), 0), [accounts]);

  return (
    <div className="mgmt-group">
      <button className="mgmt-group-header" onClick={() => setOpen((o) => !o)}>
        <span className="mgmt-group-chevron">{open ? '▾' : '▸'}</span>
        <span className="mgmt-group-name">{name}</span>
        <span className="mgmt-group-count">{accounts.length} {accounts.length === 1 ? 'account' : 'accounts'}</span>
        {overdueCount > 0 && <span className="badge emergency">Overdue {overdueCount}</span>}
        {readyToBillCount > 0 && <span className="badge dispatched">Ready to Bill {readyToBillCount}</span>}
      </button>
      {/* LazyCascade (above), not the plain always-mounted .cascade-panel
          pattern used for the small row-level expands elsewhere -- this
          group can hold thousands of accounts ("No Management Company"),
          so it stays unmounted until opened at least once instead of every
          collapsed group rendering up to 50 rows for nothing. */}
      <LazyCascade open={open}>
        <div className="contacts-wrap accounts-screen">
          <table className="contacts-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>LID</th>
                <th>Address</th>
                <th>Phone</th>
                <th>Billing</th>
              </tr>
            </thead>
            <tbody>
              {accounts.slice(0, visibleCount).map(renderRow)}
            </tbody>
          </table>
          {visibleCount < accounts.length && <div ref={sentinelRef} className="scroll-sentinel" />}
        </div>
      </LazyCascade>
    </div>
  );
});

function BillingJobsModal({ account, kind, onClose }) {
  const jobs = kind === 'unpaid' ? account.unpaidJobs : account.readyToBillJobs;
  const title = kind === 'unpaid' ? 'Overdue' : 'Ready to Bill';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title-row"><span className="jname">{title} - {account.name}</span></div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          {jobs.map((j) => <JobInvoiceRow key={j.id} job={j} />)}
        </div>
        <div className="modal-footer">
          <div className="modal-footer-spacer" />
          <button className="modal-cancel-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function JobInvoiceRow({ job }) {
  const [open, setOpen] = useState(false);
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [invoiceWarn, setInvoiceWarn] = useState(null);
  const flashInvoiceWarn = (msg) => { setInvoiceWarn(msg); setTimeout(() => setInvoiceWarn(null), 2600); };
  return (
    <div className="mgmt-group">
      <button className="mgmt-group-header" onClick={() => setOpen((o) => !o)}>
        <span className="mgmt-group-chevron">{open ? '▾' : '▸'}</span>
        <span className="mgmt-group-name" style={{ fontWeight: 400 }}><OppLink id={job.id} name={job.name} /></span>
        <span className="mgmt-group-count">{job.invoices.length} {job.invoices.length === 1 ? 'invoice' : 'invoices'}</span>
      </button>
      <LazyCascade open={open}>
        <div style={{ padding: '10px 14px' }}>
          <button
            type="button"
            className={`fs-badge inv-badge${job.fsTaskId ? '' : ' inv-badge-nofs'}`}
            title={job.fsTaskId ? 'Draft an invoice from Field Squared completion data' : 'Field Squared must be attached to this job before an invoice can be drafted'}
            onClick={() => job.fsTaskId ? setShowInvoiceModal(true) : flashInvoiceWarn('Field Squared must be attached to this job before an invoice can be drafted.')}
          >+ Create Invoice</button>
          {job.invoices.length === 0
            ? <div className="na">No invoice on file</div>
            : job.invoices.map((inv) => <InvoiceDetail key={inv.id} invoice={inv} />)}
        </div>
      </LazyCascade>
      {showInvoiceModal && <CreateInvoiceModal job={job} onClose={() => setShowInvoiceModal(false)} />}
      {invoiceWarn && <div className="toast">{invoiceWarn}</div>}
    </div>
  );
}

function InvoiceDetail({ invoice }) {
  const fields = [
    ['Invoice #', invoice.number],
    ['Invoice Date', fmtDate(invoice.date)],
    ['Amount', fmtCurrency(invoice.amount)],
    ['Status', invoice.status],
    ['Total Invoice', fmtCurrency(invoice.totalInvoice)],
    ['Next Expected Payment', fmtDate(invoice.nextExpectedPaymentDate)],
    ['AR Account', invoice.arAccount],
    ['AR Number', invoice.arNumber],
    ['% of Project', invoice.percentOfProject != null ? `${invoice.percentOfProject}%` : null],
    ['Billing Type', invoice.billingType],
  ];
  return (
    <div className="invoice-detail">
      {fields.map(([label, value]) => (
        <div key={label} className="invoice-detail-row">
          <span className="invoice-detail-label">{label}</span>
          <span className="invoice-detail-value">{value ?? <span className="na">-</span>}</span>
        </div>
      ))}
    </div>
  );
}

// Per direction 2026-08-28: a real "Edit" affordance, not click-to-edit-in-
// place on each field -- the old per-field version also had a real usability
// bug from it, not just a discoverability one: the phone/email links'
// onClick={e => e.preventDefault()} (needed so a click always opened the
// field's editor instead of following the tel:/mailto: link) meant clicking
// a contact's phone number to actually call it, or their email to actually
// mail them, silently did nothing. One Edit button now enters a single edit
// mode for the whole card; outside edit mode every link is a real, working
// link. Also adds Mobile/Fax -- confirmed live only Phone (72%), Mobile
// (26%), and Fax (25.5%, more real usage than expected) have meaningful
// fill rates across this org's 9,078 real Contacts; Home/Other/Assistant
// Phone are all under 1% and left out to avoid clutter.
function ContactInfoModal({ contact, accounts, onUpdateContact, onClose }) {
  const [editMode, setEditMode] = useState(false);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const accountOptions = useMemo(() =>
    accounts.map((a) => [a.id, a.name]).sort((x, y) => x[1].localeCompare(y[1]))
  , [accounts]);

  const enterEdit = () => {
    setForm({
      name: contact.name ?? '',
      title: contact.title ?? '',
      accountId: contact.accountId ?? '',
      phone: formatPhone(contact.phone) || '',
      mobile: formatPhone(contact.mobile) || '',
      fax: formatPhone(contact.fax) || '',
      email: contact.email ?? '',
    });
    setErr(null);
    setEditMode(true);
  };

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      await onUpdateContact(contact.id, {
        name: form.name.trim(),
        title: form.title.trim() || null,
        accountId: form.accountId || null,
        phone: form.phone || null,
        mobile: form.mobile || null,
        fax: form.fax || null,
        email: form.email.trim() || null,
      });
      setEditMode(false);
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const set = (field) => (v) => setForm((s) => ({ ...s, [field]: v }));
  const accountName = accounts.find((a) => a.id === contact.accountId)?.name ?? null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title-row"><span className="jname">{editMode ? 'Edit contact' : contact.name}</span></div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          {err && <div className="state err">{err}</div>}
          {!editMode ? (
            <>
              {contact.title && <div className="contact-title">{contact.title}</div>}
              {accountName && <div className="contact-title">{accountName}</div>}
              <div className="contact-view-rows">
                <div className="contact-view-row"><span className="contact-view-label">Phone</span>{contact.phone ? <a href={`tel:${contact.phone}`} className="contact-link">{formatPhone(contact.phone)}</a> : <span className="na">-</span>}</div>
                <div className="contact-view-row"><span className="contact-view-label">Mobile</span>{contact.mobile ? <a href={`tel:${contact.mobile}`} className="contact-link">{formatPhone(contact.mobile)}</a> : <span className="na">-</span>}</div>
                <div className="contact-view-row"><span className="contact-view-label">Fax</span>{contact.fax ? formatPhone(contact.fax) : <span className="na">-</span>}</div>
                <div className="contact-view-row"><span className="contact-view-label">Email</span>{contact.email ? <a href={`mailto:${contact.email}`} className="contact-link">{contact.email}</a> : <span className="na">-</span>}</div>
              </div>
            </>
          ) : (
            <>
              <label className="req-field req-field-wide">
                <span className="req-field-label">Name</span>
                <input className="req-note-input" autoFocus value={form.name} onChange={(e) => set('name')(e.target.value)} />
              </label>
              <label className="req-field req-field-wide">
                <span className="req-field-label">Title</span>
                <input className="req-note-input" value={form.title} onChange={(e) => set('title')(e.target.value)} />
              </label>
              <label className="req-field req-field-wide">
                <span className="req-field-label">Account</span>
                <SearchableSelect value={form.accountId} onChange={set('accountId')} options={accountOptions} placeholder="Search accounts…" />
              </label>
              <label className="req-field req-field-wide">
                <span className="req-field-label">Phone</span>
                <input className="req-note-input" type="tel" value={form.phone} onChange={(e) => set('phone')(formatPhone(e.target.value))} />
              </label>
              <label className="req-field req-field-wide">
                <span className="req-field-label">Mobile</span>
                <input className="req-note-input" type="tel" value={form.mobile} onChange={(e) => set('mobile')(formatPhone(e.target.value))} />
              </label>
              <label className="req-field req-field-wide">
                <span className="req-field-label">Fax</span>
                <input className="req-note-input" type="tel" value={form.fax} onChange={(e) => set('fax')(formatPhone(e.target.value))} />
              </label>
              <label className="req-field req-field-wide">
                <span className="req-field-label">Email</span>
                <input className="req-note-input" type="email" value={form.email} onChange={(e) => set('email')(e.target.value)} />
              </label>
            </>
          )}
        </div>
        <div className="modal-footer">
          {editMode ? (
            <>
              <button className="modal-cancel-btn" onClick={() => setEditMode(false)} disabled={saving}>Cancel</button>
              <div className="modal-footer-spacer" />
              <button className="modal-save-btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            </>
          ) : (
            <>
              <button className="modal-cancel-btn" onClick={enterEdit}>Edit</button>
              <div className="modal-footer-spacer" />
              <button className="modal-cancel-btn" onClick={onClose}>Close</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Mirrors ContactInfoModal directly below it -- same view/edit-mode toggle,
// same modal-sm/contact-view-row* CSS, added per direction 2026-08-28 to
// replace AccountsTab's old per-field click-to-edit-in-place cells (street/
// city/state/zip/website/industry/phone) with one real Edit button. Type,
// LID, and management company aren't included in the edit form -- they
// were never editable in the old click-to-edit cells either (plain display
// text, no onClick), so this isn't dropping any capability.
function AccountInfoModal({ account, onUpdateAccount, onClose }) {
  const [editMode, setEditMode] = useState(false);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const enterEdit = () => {
    setForm({
      street: account.street ?? '',
      city: account.city ?? '',
      state: account.state ?? '',
      zip: account.zip ?? '',
      phone: formatPhone(account.phone) || '',
      website: account.website ?? '',
      industry: account.industry ?? '',
    });
    setErr(null);
    setEditMode(true);
  };

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      await onUpdateAccount(account.id, {
        street: form.street.trim() || null,
        city: form.city.trim() || null,
        state: form.state.trim() || null,
        zip: form.zip.trim() || null,
        phone: form.phone || null,
        website: form.website.trim() || null,
        industry: form.industry.trim() || null,
      });
      setEditMode(false);
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const set = (field) => (v) => setForm((s) => ({ ...s, [field]: v }));
  const addressLine = [account.street, [account.city, account.state].filter(Boolean).join(', '), account.zip].filter(Boolean).join(' ') || null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title-row"><span className="jname">{editMode ? 'Edit account' : account.name}</span></div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          {err && <div className="state err">{err}</div>}
          {!editMode ? (
            <>
              {account.type && <div className="contact-title">{account.type}</div>}
              <div className="contact-view-rows">
                <div className="contact-view-row"><span className="contact-view-label">LID</span>{account.lid ? <span className="lidtag">LID {account.lid}</span> : <span className="na">-</span>}</div>
                <div className="contact-view-row"><span className="contact-view-label">Address</span>{addressLine ?? <span className="na">-</span>}</div>
                <div className="contact-view-row"><span className="contact-view-label">Phone</span>{account.phone ? <a href={`tel:${account.phone}`} className="contact-link">{formatPhone(account.phone)}</a> : <span className="na">-</span>}</div>
                <div className="contact-view-row"><span className="contact-view-label">Website</span>{account.website ? <a href={account.website.startsWith('http') ? account.website : `https://${account.website}`} target="_blank" rel="noreferrer" className="contact-link">{account.website}</a> : <span className="na">-</span>}</div>
                <div className="contact-view-row"><span className="contact-view-label">Industry</span>{account.industry || <span className="na">-</span>}</div>
                <div className="contact-view-row"><span className="contact-view-label">Management co.</span>{account.parentName ?? <span className="na">-</span>}</div>
              </div>
            </>
          ) : (
            <>
              <label className="req-field req-field-wide">
                <span className="req-field-label">Street</span>
                <input className="req-note-input" autoFocus value={form.street} onChange={(e) => set('street')(e.target.value)} />
              </label>
              <label className="req-field req-field-wide">
                <span className="req-field-label">City</span>
                <input className="req-note-input" value={form.city} onChange={(e) => set('city')(e.target.value)} />
              </label>
              <label className="req-field req-field-wide">
                <span className="req-field-label">State</span>
                <input className="req-note-input" value={form.state} onChange={(e) => set('state')(e.target.value)} />
              </label>
              <label className="req-field req-field-wide">
                <span className="req-field-label">Zip</span>
                <input className="req-note-input" value={form.zip} onChange={(e) => set('zip')(e.target.value)} />
              </label>
              <label className="req-field req-field-wide">
                <span className="req-field-label">Phone</span>
                <input className="req-note-input" type="tel" value={form.phone} onChange={(e) => set('phone')(formatPhone(e.target.value))} />
              </label>
              <label className="req-field req-field-wide">
                <span className="req-field-label">Website</span>
                <input className="req-note-input" value={form.website} onChange={(e) => set('website')(e.target.value)} />
              </label>
              <label className="req-field req-field-wide">
                <span className="req-field-label">Industry</span>
                <input className="req-note-input" value={form.industry} onChange={(e) => set('industry')(e.target.value)} />
              </label>
            </>
          )}
        </div>
        <div className="modal-footer">
          {editMode ? (
            <>
              <button className="modal-cancel-btn" onClick={() => setEditMode(false)} disabled={saving}>Cancel</button>
              <div className="modal-footer-spacer" />
              <button className="modal-save-btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            </>
          ) : (
            <>
              <button className="modal-cancel-btn" onClick={enterEdit}>Edit</button>
              <div className="modal-footer-spacer" />
              <button className="modal-cancel-btn" onClick={onClose}>Close</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ageLabel(hours) {
  if (hours == null) return '';
  if (hours < 1) return '<1h';
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.floor(hours / 24)}d ${Math.round(hours % 24)}h`;
}

function RequestRow({ req, jobs, onApprove, onCounter, onDeny }) {
  const [action, setAction] = useState(null); // 'approve' | 'counter' | 'deny' | null
  const [opportunityId, setOpportunityId] = useState('');
  const [counterDate, setCounterDate] = useState(req.proposedDate || '');
  const [counterStart, setCounterStart] = useState(req.proposedStart || '');
  const [counterEnd, setCounterEnd] = useState(req.proposedEnd || '');
  const [counterNote, setCounterNote] = useState('');
  const [denyNote, setDenyNote] = useState('');
  const [busy, setBusy] = useState(false);

  const jobOptions = useMemo(() => jobs.map((j) => [j.id, j.name]), [jobs]);

  const closePanel = () => { setAction(null); setOpportunityId(''); setCounterNote(''); setDenyNote(''); };

  const doApprove = async () => {
    if (req.isNewWo && !opportunityId) return;
    setBusy(true);
    try { await onApprove(req, req.isNewWo ? opportunityId : undefined); closePanel(); }
    catch { setBusy(false); }
  };

  const doCounter = async () => {
    if (!counterDate || !counterStart || !counterEnd) return;
    setBusy(true);
    try {
      await onCounter(req, { date: counterDate, start: counterStart, end: counterEnd, officeNote: counterNote.trim() || undefined });
      closePanel();
    } catch { setBusy(false); }
  };

  const doDeny = async () => {
    if (!denyNote.trim()) return;
    setBusy(true);
    try { await onDeny(req, denyNote.trim()); closePanel(); }
    catch { setBusy(false); }
  };

  const jobLabel = req.isTimeOff ? 'Time off' : req.isNewWo ? 'New WO Required' : (req.jobName || '-');
  const jobLabelCls = req.isTimeOff ? 'timeoff' : req.isNewWo ? 'newwo' : '';

  return (
    <div className="req-row">
      <div className="req-main">
        <div className="req-top">
          <span className="req-tech">{req.technicianName || 'Unknown tech'}</span>
          <span className={`req-job ${jobLabelCls}`}>{jobLabel}</span>
          <span className={`req-turn ${req.waitingOn}`}>{req.waitingOn === 'tech' ? 'Waiting on tech' : 'Waiting on office'}</span>
          <span className="req-age">{ageLabel(req.ageHours)} old</span>
        </div>
        <div className="req-window">
          <span className="ic">◷</span>
          {req.proposedDate ? fmtDate(req.proposedDate) : 'No date proposed'} · {req.proposedStart || '?'}–{req.proposedEnd || '?'}
        </div>
        {req.note && <div className="req-note">“{req.note}”</div>}
        {req.officeNote && <div className="req-officenote">Office: “{req.officeNote}”</div>}
      </div>

      <div className="req-actions">
        <button className={`req-btn approve ${action === 'approve' ? 'on' : ''}`} disabled={busy} onClick={() => setAction(action === 'approve' ? null : 'approve')}>Approve</button>
        <button className={`req-btn counter ${action === 'counter' ? 'on' : ''}`} disabled={busy} onClick={() => setAction(action === 'counter' ? null : 'counter')}>Counter</button>
        <button className={`req-btn deny ${action === 'deny' ? 'on' : ''}`} disabled={busy} onClick={() => setAction(action === 'deny' ? null : 'deny')}>Deny</button>
      </div>

      {action === 'approve' && (
        <div className="req-panel approve">
          <div className="req-panel-title">Approve this request</div>
          {req.isNewWo && (
            <label className="req-field req-field-wide">
              <span className="req-field-label">Real job</span>
              <SearchableSelect value={opportunityId} onChange={setOpportunityId} options={jobOptions} placeholder="Pick the opportunity…" />
            </label>
          )}
          <div className="req-panel-actions">
            <button className="add-btn" disabled={busy || (req.isNewWo && !opportunityId)} onClick={doApprove}>
              {busy ? 'Approving…' : 'Confirm approve'}
            </button>
            <button className="cancel-btn" onClick={closePanel} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}

      {action === 'counter' && (
        <div className="req-panel counter">
          <div className="req-panel-title">Counter-propose a new time</div>
          <div className="req-panel-row">
            <label className="req-field">
              <span className="req-field-label">Date</span>
              <DatePicker className="dp-req" value={counterDate} onChange={setCounterDate} placeholder="Date" clearable={false} />
            </label>
            <label className="req-field">
              <span className="req-field-label">Start</span>
              <TimePicker className="req-time" value={counterStart} onChange={setCounterStart} />
            </label>
            <label className="req-field">
              <span className="req-field-label">End</span>
              <TimePicker className="req-time" value={counterEnd} onChange={setCounterEnd} clearable />
            </label>
          </div>
          <label className="req-field req-field-wide">
            <span className="req-field-label">Note to technician (optional)</span>
            <input
              className="req-note-input"
              type="text"
              placeholder="e.g. Can you do a day earlier?"
              value={counterNote}
              onChange={(e) => setCounterNote(e.target.value)}
            />
          </label>
          <div className="req-panel-actions">
            <button className="add-btn" disabled={busy || !counterDate || !counterStart || !counterEnd} onClick={doCounter}>
              {busy ? 'Sending…' : 'Send counter'}
            </button>
            <button className="cancel-btn" onClick={closePanel} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}

      {action === 'deny' && (
        <div className="req-panel deny">
          <div className="req-panel-title">Deny this request</div>
          <label className="req-field req-field-wide">
            <span className="req-field-label">Reason (required)</span>
            <input
              className="req-note-input"
              type="text"
              placeholder="Let the technician know why"
              value={denyNote}
              onChange={(e) => setDenyNote(e.target.value)}
              autoFocus
            />
          </label>
          <div className="req-panel-actions">
            <button className="add-btn deny" disabled={busy || !denyNote.trim()} onClick={doDeny}>
              {busy ? 'Denying…' : 'Confirm deny'}
            </button>
            <button className="cancel-btn" onClick={closePanel} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function requestJobLabel(req) {
  return {
    label: req.isTimeOff ? 'Time off' : req.isNewWo ? 'New WO Required' : (req.jobName || '-'),
    cls: req.isTimeOff ? 'timeoff' : req.isNewWo ? 'newwo' : '',
  };
}

function PreviousRequestRow({ req }) {
  const { label, cls } = requestJobLabel(req);
  const statusCls = req.status === 'Approved' ? 'approved' : req.status === 'Denied' ? 'denied' : 'withdrawn';
  return (
    <div className="req-row prev">
      <div className="req-main">
        <div className="req-top">
          <span className="req-tech">{req.technicianName || 'Unknown tech'}</span>
          <span className={`req-job ${cls}`}>{label}</span>
          <span className={`req-resolved-status ${statusCls}`}>{req.status}</span>
          {req.resolvedAt && <span className="req-age">{fmtDateTime(req.resolvedAt)}</span>}
        </div>
        <div className="req-window">
          <span className="ic">◷</span>
          {req.proposedDate ? fmtDate(req.proposedDate) : 'No date proposed'} · {req.proposedStart || '?'}–{req.proposedEnd || '?'}
        </div>
        {req.note && <div className="req-note">“{req.note}”</div>}
        {req.status === 'Denied' && req.officeNote && <div className="req-officenote">Office: “{req.officeNote}”</div>}
      </div>
    </div>
  );
}

function RequestsTab({ requests, jobs, loading, onApprove, onCounter, onDeny, previousRequests, previousLoading, previousLoaded, onLoadPrevious }) {
  // Oldest first - age is the pressure that keeps the approve/counter/deny loop moving.
  const sorted = useMemo(() => [...requests].sort((a, b) => (b.ageHours || 0) - (a.ageHours || 0)), [requests]);
  const [activeOpen, setActiveOpen] = useState(true);
  // Previous requests are deliberately not part of the default view -- start
  // collapsed, and only fetch the (separately-queried) resolved history the
  // first time it's actually expanded.
  const [previousOpen, setPreviousOpen] = useState(false);

  const openPrevious = () => {
    setPreviousOpen((o) => !o);
    if (!previousLoaded) onLoadPrevious();
  };

  return (
    <section>
      <div className="view-head">
        <div><h2>Schedule requests</h2><p>Techs proposing dates/times for jobs and time off. Approve, counter, or deny.</p></div>
      </div>

      <div className="req-section">
        <button className="req-section-toggle" onClick={() => setActiveOpen((o) => !o)}>
          <span className={`req-section-chevron ${activeOpen ? 'open' : ''}`}>▸</span>
          <span>Active requests</span>
          {!loading && <span className="req-section-count">{sorted.length}</span>}
        </button>
        {activeOpen && (
          <>
            {loading && (
              <div className="req-list">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="req-row">
                    <div className="req-main">
                      <div className="req-top">
                        <span className="skel-block" style={{ width: 100, height: 13 }} />
                        <span className="skel-block" style={{ width: 70, height: 13 }} />
                      </div>
                      <div className="req-window">
                        <span className="skel-block" style={{ width: 160, height: 12 }} />
                      </div>
                    </div>
                    <div className="req-actions">
                      <span className="skel-block" style={{ width: 200, height: 30 }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!loading && sorted.length === 0 && <div className="empty">No open schedule requests.</div>}
            {!loading && sorted.length > 0 && (
              <div className="req-list">
                {sorted.map((req) => (
                  <RequestRow key={req.id} req={req} jobs={jobs} onApprove={onApprove} onCounter={onCounter} onDeny={onDeny} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="req-section">
        <button className="req-section-toggle" onClick={openPrevious}>
          <span className={`req-section-chevron ${previousOpen ? 'open' : ''}`}>▸</span>
          <span>Previous requests</span>
          {previousLoaded && <span className="req-section-count">{previousRequests.length}</span>}
        </button>
        {previousOpen && (
          <>
            {previousLoading && <LoadingDots label="Loading previous requests…" />}
            {!previousLoading && previousLoaded && previousRequests.length === 0 && (
              <div className="empty">No resolved requests yet.</div>
            )}
            {!previousLoading && previousRequests.length > 0 && (
              <div className="req-list">
                {previousRequests.map((req) => <PreviousRequestRow key={req.id} req={req} />)}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function rangeLabel(mode, anchor) {
  if (mode === 'month') return anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const s = startOfWeek(anchor), e = addDays(s, 6);
  const opt = { month: 'short', day: 'numeric' };
  return `${s.toLocaleDateString(undefined, opt)} – ${e.toLocaleDateString(undefined, opt)}`;
}

const CLOSED_LIST_STATUSES = ['Pending Customer Approval', 'Quoted', 'Parts ordered', 'Ready to be scheduled'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function Schedule({ jobs, techs, onJobClick, onAssign }) {
  const [mode, setMode] = useState('week');
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [techFilter, setTechFilter] = useState('all');
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [expandedMonths, setExpandedMonths] = useState(() => Array(12).fill(false));

  // Approved time off is invisible to the jobs API (the sentinel opp isn't in
  // jobStatusValues), so it's fetched separately here - once, shared by both
  // Week and Month views - for whichever range is currently in view.
  const [timeOff, setTimeOff] = useState([]);
  const [editingOff, setEditingOff] = useState(null);
  const [addingOff, setAddingOff] = useState(false);
  const [addingAssignment, setAddingAssignment] = useState(false);

  const timeOffRange = useMemo(() => {
    if (mode === 'week') {
      const s = startOfWeek(anchor);
      return [isoOf(s), isoOf(addDays(s, 6))];
    }
    // Month grid pads to full weeks, so a few days can spill into adjacent months.
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    const gridStart = startOfWeek(first);
    const gridEnd = addDays(startOfWeek(last), 6);
    return [isoOf(gridStart), isoOf(gridEnd)];
  }, [mode, anchor]);

  const loadTimeOff = useCallback(() => {
    const [start, end] = timeOffRange;
    return api.getTimeOff(start, end)
      .then((rows) => setTimeOff(rows))
      .catch(() => setTimeOff([]));
  }, [timeOffRange]);

  useEffect(() => { loadTimeOff(); }, [loadTimeOff]);

  const shift = (dir) => {
    const d = new Date(anchor);
    if (mode === 'week') d.setDate(d.getDate() + dir * 7);
    else d.setMonth(d.getMonth() + dir);
    setAnchor(startOfDay(d));
  };

  const closedJobs = useMemo(() => jobs
    .filter((j) => CLOSED_LIST_STATUSES.includes(j.status) && j.closeDate)
    .filter((j) => new Date(j.closeDate + 'T00:00:00').getFullYear() === year),
  [jobs, year]);

  const closedByMonth = useMemo(() => {
    const buckets = Array.from({ length: 12 }, () => []);
    closedJobs.forEach((j) => {
      const month = new Date(j.closeDate + 'T00:00:00').getMonth();
      buckets[month].push(j);
    });
    return buckets.map((items) => items.sort((a, b) => a.name.localeCompare(b.name)));
  }, [closedJobs]);

  const toggleMonth = (month) => setExpandedMonths((prev) => {
    const next = [...prev];
    next[month] = !next[month];
    return next;
  });

  useEffect(() => {
    setExpandedMonths(Array(12).fill(false));
  }, [year]);

  return (
    <section>
      <div className="schedule-layout">
        <div className="schedule-main">
      <div className="view-head">
        <div><h2>Who's on what</h2><p>Each tech's load by day. Empty cells are open.</p></div>
        <div className="view-head-actions">
          <button className="refresh" onClick={() => setAddingAssignment(true)}>+ Add Assignment</button>
          <button className="refresh" onClick={() => setAddingOff(true)}>+ Add Time Off</button>
        </div>
      </div>

      <div className="schedbar">
        <div className="navbtns">
          <button className="navbtn" onClick={() => shift(-1)} aria-label="Previous">‹</button>
          <button className="navbtn" onClick={() => setAnchor(startOfDay(new Date()))}>Today</button>
          <button className="navbtn" onClick={() => shift(1)} aria-label="Next">›</button>
        </div>
        <div className="rangelabel">{rangeLabel(mode, anchor)}</div>
        <FilterSelect
          value={techFilter}
          onChange={setTechFilter}
          options={[['all', 'All technicians'], ...techs.map((t) => [t.id, t.name])]}
          ariaLabel="Technician filter"
        />
        <div className="seg">
          <button className={`segbtn ${mode === 'week' ? 'on' : ''}`} onClick={() => setMode('week')}>Week</button>
          <button className={`segbtn ${mode === 'month' ? 'on' : ''}`} onClick={() => setMode('month')}>Month</button>
        </div>
      </div>

      {mode === 'week'
        ? <WeekGrid jobs={jobs} techs={techs} anchor={anchor} techFilter={techFilter} onJobClick={onJobClick} timeOff={timeOff} onEditOff={setEditingOff} />
        : <MonthGrid jobs={jobs} anchor={anchor} techFilter={techFilter} onJobClick={onJobClick} timeOff={timeOff} onEditOff={setEditingOff} />}
        </div>
        <aside className="closed-months-panel">
          <div className="panel-head">
            <div>
              <div className="panel-title">Unscheduled opportunities</div>
              <div className="panel-subtitle">{year}</div>
            </div>
            <div className="year-nav">
              <button className="year-btn" onClick={() => setYear((y) => y - 1)} aria-label="Previous year">‹</button>
              <button className="year-btn" onClick={() => setYear((y) => y + 1)} aria-label="Next year">›</button>
            </div>
          </div>
          {MONTHS.map((month, idx) => {
            const items = closedByMonth[idx] || [];
            return (
              <div className="month-group" key={month}>
                <button type="button" className="month-toggle" onClick={() => toggleMonth(idx)}>
                  <span>{month}</span>
                  <span className="month-count">{items.length}</span>
                </button>
                {expandedMonths[idx] && (
                  <div className="month-items">
                    {items.length === 0
                      ? <div className="month-empty">No closed jobs</div>
                      : items.map((job) => (
                        <div className="month-job" data-status={statusClass(job.status)} key={job.id}>
                          <div className="job-name">{job.name}</div>
                          <div className="job-meta">{job.lid ? `LID ${job.lid}` : ''}{job.status ? ` · ${job.status}` : ''}</div>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            );
          })}
        </aside>
      </div>
      {editingOff && (
        <TimeOffEditModal
          entry={editingOff}
          onClose={() => setEditingOff(null)}
          onChanged={loadTimeOff}
        />
      )}
      {addingOff && (
        <AddTimeOffModal
          techs={techs}
          onClose={() => setAddingOff(false)}
          onCreated={loadTimeOff}
        />
      )}
      {addingAssignment && (
        <AddAssignmentModal
          jobs={jobs}
          techs={techs}
          onClose={() => setAddingAssignment(false)}
          onAssign={onAssign}
        />
      )}
    </section>
  );
}

function AddAssignmentModal({ jobs, techs, onClose, onAssign }) {
  const [opportunityId, setOpportunityId] = useState('');
  const [technicianIds, setTechnicianIds] = useState([]);
  const [dates, setDates] = useState([]);
  const [time, setTime] = useState('07:00');
  const [endTime, setEndTime] = useState('');
  const [saving, setSaving] = useState(false);

  const jobOptions = useMemo(() => jobs.map((j) => [j.id, j.name]), [jobs]);

  // assign() (passed down as onAssign) already swallows its own errors and shows
  // a toast, same as JobCard's inline add-assignment flow -- so there's no local
  // error state here, and the modal always closes once the calls settle.
  //
  // One Job_Assignment__c per selected day (same pattern as AddTimeOffModal),
  // but chained sequentially rather than fired concurrently with
  // Promise.allSettled: onAssign returns the updated job so each call builds
  // on the previous one's result instead of re-adding onto a stale snapshot,
  // which would silently drop every day but the last.
  const save = async () => {
    if (!opportunityId || technicianIds.length === 0 || dates.length === 0 || !endTime) return;
    let job = jobs.find((j) => j.id === opportunityId);
    if (!job) return;
    setSaving(true);
    // One Job_Assignment__c per (tech × selected day), chained sequentially so
    // each onAssign builds on the previous returned job state.
    for (const technicianId of technicianIds) {
      for (const d of dates) {
        job = await onAssign(job, technicianId, d, time, endTime);
      }
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={() => !saving && onClose()}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title-row"><span className="jname">Add assignment</span></div>
          <button className="modal-close" onClick={onClose} aria-label="Close" disabled={saving}>×</button>
        </div>
        <div className="modal-body">
          <label className="req-field req-field-wide">
            <span className="req-field-label">Opportunity</span>
            <SearchableSelect value={opportunityId} onChange={setOpportunityId} options={jobOptions} placeholder="Pick the opportunity…" />
          </label>
          <label className="req-field req-field-wide">
            <span className="req-field-label">Technician(s)</span>
            <TechMultiSelect
              techs={techs}
              value={technicianIds}
              onChange={setTechnicianIds}
              placeholder="Select technician(s)…"
              triggerClassName="techms-field"
            />
          </label>
          <label className="req-field req-field-wide">
            <span className="req-field-label">Date(s)</span>
            <MultiDatePicker value={dates} onChange={setDates} placeholder="Select date(s)" />
          </label>
          <div className="req-panel-row">
            <label className="req-field">
              <span className="req-field-label">Start</span>
              <TimePicker className="req-time" value={time} onChange={setTime} />
            </label>
            <label className="req-field">
              <span className="req-field-label">End</span>
              <TimePicker className="req-time" value={endTime} onChange={setEndTime} placeholder="End" />
            </label>
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-save-btn" onClick={save} disabled={saving || !opportunityId || technicianIds.length === 0 || dates.length === 0 || !endTime}>
            {saving ? 'Adding…' : `Add assignment${technicianIds.length > 1 ? ` (${technicianIds.length} techs)` : ''}${dates.length > 1 ? ` · ${dates.length} days` : ''}`}
          </button>
          <button className="modal-cancel-btn" onClick={onClose} disabled={saving}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function AddTimeOffModal({ techs, onClose, onCreated }) {
  const [technicianId, setTechnicianId] = useState('');
  const [dates, setDates] = useState([]);
  const [start, setStart] = useState('08:00');
  const [end, setEnd] = useState('17:00');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  // One Job_Assignment__c per selected day -- same reasoning as chalkboard's
  // own multi-date time-off picker: there's no date-range field on the
  // object, so each day is its own independent create call, fired
  // concurrently. A day that fails doesn't block the others from saving.
  const save = async () => {
    if (!technicianId || dates.length === 0) return;
    setSaving(true);
    setErr(null);
    trackUsage('timeoff_add');
    const results = await Promise.allSettled(dates.map((d) => api.addTimeOff(technicianId, d, start, end)));
    const failed = results.map((r, i) => (r.status === 'rejected' ? dates[i] : null)).filter(Boolean);

    if (failed.length === dates.length) {
      setErr('Could not add time off. Nothing was saved.');
      setSaving(false);
      return;
    }
    if (failed.length > 0) {
      setErr(`Saved ${dates.length - failed.length} of ${dates.length} day(s) - failed: ${failed.join(', ')}.`);
      setSaving(false);
      await onCreated();
      return;
    }
    await onCreated();
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={() => !saving && onClose()}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title-row"><span className="jname">Add time off</span></div>
          <button className="modal-close" onClick={onClose} aria-label="Close" disabled={saving}>×</button>
        </div>
        <div className="modal-body">
          <label className="req-field req-field-wide">
            <span className="req-field-label">Technician</span>
            <FilterSelect
              value={technicianId}
              onChange={setTechnicianId}
              options={techs.map((t) => [t.id, t.name])}
              placeholder="Select a technician…"
              ariaLabel="Technician"
            />
          </label>
          <label className="req-field req-field-wide">
            <span className="req-field-label">Date(s)</span>
            <MultiDatePicker value={dates} onChange={setDates} placeholder="Select date(s)" />
          </label>
          <div className="req-panel-row">
            <label className="req-field">
              <span className="req-field-label">Start</span>
              <TimePicker className="req-time" value={start} onChange={setStart} />
            </label>
            <label className="req-field">
              <span className="req-field-label">End</span>
              <TimePicker className="req-time" value={end} onChange={setEnd} />
            </label>
          </div>
          {err && <div className="modal-form-error">{err}</div>}
        </div>
        <div className="modal-footer">
          <button className="modal-save-btn" onClick={save} disabled={saving || !technicianId || dates.length === 0}>
            {saving ? 'Adding…' : dates.length > 1 ? `Add time off (${dates.length} days)` : 'Add time off'}
          </button>
          <button className="modal-cancel-btn" onClick={onClose} disabled={saving}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function TimeOffEditModal({ entry, onClose, onChanged }) {
  const [date, setDate] = useState(entry.workDate || '');
  const [start, setStart] = useState(entry.startTime || '');
  const [end, setEnd] = useState(entry.endTime || '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateAssignment(entry.id, { workDate: date, startTime: start, endTime: end });
      await onChanged();
      onClose();
    } catch (e) {
      alert(`Could not save: ${e.message}`);
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    try {
      await api.removeAssignment(entry.id);
      await onChanged();
      onClose();
    } catch (e) {
      alert(`Could not remove: ${e.message}`);
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !saving && onClose()}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title-row"><span className="jname">Edit time off</span></div>
          <button className="modal-close" onClick={onClose} aria-label="Close" disabled={saving}>×</button>
        </div>
        <div className="modal-body">
          <div className="meta"><span className="jname">{entry.technicianName}</span></div>
          <label className="req-field req-field-wide">
            <span className="req-field-label">Date</span>
            <DatePicker value={date} onChange={setDate} placeholder="Date" clearable={false} />
          </label>
          <div className="req-panel-row">
            <label className="req-field">
              <span className="req-field-label">Start</span>
              <TimePicker className="req-time" value={start} onChange={setStart} />
            </label>
            <label className="req-field">
              <span className="req-field-label">End</span>
              <TimePicker className="req-time" value={end} onChange={setEnd} clearable />
            </label>
          </div>
        </div>
        <div className="modal-footer">
          <button className="unschedule" onClick={remove} disabled={saving}>Remove time off</button>
          <div className="modal-footer-spacer" />
          <button className="modal-save-btn" onClick={save} disabled={saving || !date}>{saving ? 'Saving…' : 'Save changes'}</button>
          <button className="modal-cancel-btn" onClick={onClose} disabled={saving}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function WeekGrid({ jobs, techs, anchor, techFilter, onJobClick, timeOff, onEditOff }) {
  const days = useMemo(() => {
    const s = startOfWeek(anchor);
    return Array.from({ length: 7 }, (_, i) => addDays(s, i));
  }, [anchor]);
  const todayIso = isoOf(startOfDay(new Date()));
  const rows = techFilter === 'all' ? techs : techs.filter((t) => t.id === techFilter);

  // Completed assignments collapse into a per-cell "✓N done" toggle by
  // default -- keyed by "techId|iso" rather than lifted to Schedule, since
  // nothing outside this grid needs it and remounting on Week/Month switch
  // already resets it to all-collapsed, which is the desired default.
  const [expandedCells, setExpandedCells] = useState(() => new Set());
  const toggleCell = (key) => setExpandedCells((prev) => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  // techId -> iso -> [{ name, startTime }], sorted by start time
  const grid = useMemo(() => {
    const m = {};
    jobs.forEach((job) => job.assignments.forEach((a) => {
      if (!a.workDate) return; // unscheduled assignment - not on the calendar
      ((m[a.technicianId] ||= {})[a.workDate] ||= []).push({ name: job.name, startTime: a.startTime || '07:00', jobId: job.id, completed: !!a.completed });
    }));
    // sort each cell by start time
    Object.values(m).forEach((byDate) =>
      Object.values(byDate).forEach((items) => items.sort((a, b) => a.startTime.localeCompare(b.startTime)))
    );
    return m;
  }, [jobs]);

  // techId -> iso -> time-off entry, overlaid on the calendar below. Indexed
  // from the `timeOff` prop (fetched once by the parent Schedule component
  // for whatever range - week or month - is currently in view).
  const timeOffByTechDate = useMemo(() => {
    const m = {};
    timeOff.forEach((r) => {
      if (!r.technicianId || !r.workDate) return;
      (m[r.technicianId] ||= {})[r.workDate] = r;
    });
    return m;
  }, [timeOff]);

  return (
    <>
    <div className="grid-wrap sched-desktop">
      <table className="sched">
        <thead>
          <tr>
            <th className="techcol">Technician</th>
            {days.map((d) => {
              const iso = isoOf(d);
              return <th key={iso} className={iso === todayIso ? 'todaycol' : ''}>{d.toLocaleDateString(undefined, { weekday: 'short' })} {d.getDate()}</th>;
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td className="techcol"><div className="tn">{t.name}</div></td>
              {days.map((d) => {
                const iso = isoOf(d);
                const items = grid[t.id]?.[iso] || [];
                const activeItems = items.filter((it) => !it.completed);
                const doneItems = items.filter((it) => it.completed);
                const off = timeOffByTechDate[t.id]?.[iso];
                const cellKey = `${t.id}|${iso}`;
                const showDone = expandedCells.has(cellKey);
                const cls = `${items.length || off ? '' : 'open'} ${iso === todayIso ? 'todaycol' : ''} ${off ? 'offcol' : ''}`.trim();
                return (
                  <td key={iso} className={cls}>
                    {off && (
                      <div className="offchip" title="Approved time off - click to edit" onClick={() => onEditOff(off)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onEditOff(off)}>
                        Off
                      </div>
                    )}
                    {items.length === 0 && !off && <span className="free">✓ Open</span>}
                    {activeItems.map((item, i) => (
                      <div className="jchip" key={i} onClick={() => onJobClick(item.jobId)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onJobClick(item.jobId)}>
                        <span className="jtime">{item.startTime}</span>
                        {item.name.split('—')[0].trim()}
                      </div>
                    ))}
                    {doneItems.length > 0 && (
                      <button
                        type="button"
                        className="done-toggle"
                        aria-expanded={showDone}
                        onClick={() => toggleCell(cellKey)}
                      >
                        <span>✓{doneItems.length} done</span>
                        <span className="done-toggle-chevron">{showDone ? '▾' : '▸'}</span>
                      </button>
                    )}
                    {showDone && doneItems.map((item, i) => (
                      <div className="jchip done" key={i} onClick={() => onJobClick(item.jobId)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onJobClick(item.jobId)}>
                        <span className="jdone-mark" title="Worked">✓</span>
                        <span className="jtime">{item.startTime}</span>
                        {item.name.split('—')[0].trim()}
                      </div>
                    ))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {/* Mobile-only (styles.css) -- per direction 2026-08-28, mirroring
        crs-board's own "All Techs" crew view (CrewBoard.tsx): one collapsed
        card per tech instead of a 7-day grid that only ever showed ~2 real
        columns on a phone. Same grid/timeOffByTechDate data, just
        restructured from "one cell per tech x day" into "one flat, sorted
        list of real entries per tech" -- an empty day just produces no
        entry here, unlike the grid where every day gets its own cell
        (mostly showing "Open"). */}
    <TechWeekList
      techs={rows}
      days={days}
      grid={grid}
      timeOffByTechDate={timeOffByTechDate}
      todayIso={todayIso}
      onJobClick={onJobClick}
      onEditOff={onEditOff}
    />
    </>
  );
}

// See WeekGrid's own comment above for why this exists. One card per tech,
// summary visible by default, tap to expand into every real slot (job or
// time off) across the visible week, in day order.
function TechWeekList({ techs, days, grid, timeOffByTechDate, todayIso, onJobClick, onEditOff }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const toggle = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const byTech = useMemo(() => techs.map((t) => {
    const entries = [];
    for (const d of days) {
      const iso = isoOf(d);
      const off = timeOffByTechDate[t.id]?.[iso];
      if (off) entries.push({ kind: 'off', iso, off });
      for (const item of (grid[t.id]?.[iso] || [])) entries.push({ kind: 'job', iso, ...item });
    }
    return { tech: t, entries };
  }), [techs, days, grid, timeOffByTechDate]);

  const dayLabel = (iso) => {
    if (iso === todayIso) return 'Today';
    return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' });
  };

  if (byTech.length === 0) return <div className="tech-week-empty">No technicians</div>;

  return (
    <div className="tech-week-list">
      {byTech.map(({ tech, entries }) => {
        const isOpen = expanded.has(tech.id);
        const activeCount = entries.filter((e) => e.kind === 'job' && !e.completed).length;
        const doneCount = entries.filter((e) => e.kind === 'job' && e.completed).length;
        const offCount = entries.filter((e) => e.kind === 'off').length;
        return (
          <div key={tech.id} className="tech-week-card">
            <button type="button" className="tech-week-head" onClick={() => toggle(tech.id)} aria-expanded={isOpen}>
              <span className="tech-week-name">{tech.name}</span>
              <span className="tech-week-summary">
                {entries.length === 0
                  ? <span className="tech-week-free">Open all week</span>
                  : (
                    <>
                      {activeCount > 0 && <span>{activeCount} job{activeCount === 1 ? '' : 's'}</span>}
                      {doneCount > 0 && <span>✓{doneCount} done</span>}
                      {offCount > 0 && <span>{offCount} off</span>}
                    </>
                  )}
              </span>
              <span className={`tech-week-chevron ${isOpen ? 'open' : ''}`}>›</span>
            </button>
            {/* Cascade (App.jsx) -- always mounted (not `isOpen &&`) so
                open/close is a real animated transition instead of an
                instant mount/unmount. Safe to use the full transform+
                opacity version here (unlike JobCard's mobile collapse
                below) -- these rows are plain onClick divs, no
                DatePicker/TimePicker/etc. inside that render their own
                position:fixed popovers. */}
            <Cascade open={isOpen}>
              <div className="tech-week-body">
                {entries.length === 0 && <div className="tech-week-empty-day">Nothing scheduled this week</div>}
                {entries.map((e, i) => e.kind === 'off' ? (
                  <div key={i} className="tech-week-row off" onClick={() => onEditOff(e.off)} role="button" tabIndex={0} onKeyDown={(ev) => ev.key === 'Enter' && onEditOff(e.off)}>
                    <span className="tech-week-row-day">{dayLabel(e.iso)}</span>
                    <span className="tech-week-row-info">Time off</span>
                  </div>
                ) : (
                  <div key={i} className={`tech-week-row ${e.completed ? 'done' : ''}`} onClick={() => onJobClick(e.jobId)} role="button" tabIndex={0} onKeyDown={(ev) => ev.key === 'Enter' && onJobClick(e.jobId)}>
                    <span className="tech-week-row-day">{dayLabel(e.iso)}</span>
                    <span className="tech-week-row-time">{e.startTime}</span>
                    <span className="tech-week-row-info">{e.completed ? '✓ ' : ''}{e.name.split('—')[0].trim()}</span>
                  </div>
                ))}
              </div>
            </Cascade>
          </div>
        );
      })}
    </div>
  );
}

function MonthGrid({ jobs, anchor, techFilter, onJobClick, timeOff, onEditOff }) {
  const todayIso = isoOf(startOfDay(new Date()));
  const month = anchor.getMonth();

  // A fully-completed job already drops out of `byDate` below (see
  // nextScheduledAssignmentDate) -- this only handles the mixed-completion
  // case, where completed techs' initials collapse into a per-job "✓N"
  // toggle by default. Keyed by job id, local to this grid (see WeekGrid's
  // matching expandedCells for the same reasoning).
  const [expandedJobs, setExpandedJobs] = useState(() => new Set());
  const toggleJob = (id) => setExpandedJobs((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const cells = useMemo(() => {
    const first = new Date(anchor.getFullYear(), month, 1);
    const last = new Date(anchor.getFullYear(), month + 1, 0);
    const gridStart = startOfWeek(first);
    const gridEnd = addDays(startOfWeek(last), 6);
    const total = Math.round((gridEnd - gridStart) / 86400000) + 1;
    return Array.from({ length: total }, (_, i) => addDays(gridStart, i));
  }, [anchor, month]);

  // iso -> [job], optionally narrowed to a single tech's jobs
  const byDate = useMemo(() => {
    const m = {};
    jobs.forEach((j) => {
      const date = nextScheduledAssignmentDate(j);
      if (!date) return;
      if (techFilter !== 'all' && !j.assignments.some((a) => a.technicianId === techFilter)) return;
      (m[date] ||= []).push(j);
    });
    return m;
  }, [jobs, techFilter]);

  // iso -> [time-off entry], same techFilter narrowing as jobs above
  const offByDate = useMemo(() => {
    const m = {};
    timeOff.forEach((r) => {
      if (!r.workDate) return;
      if (techFilter !== 'all' && r.technicianId !== techFilter) return;
      (m[r.workDate] ||= []).push(r);
    });
    return m;
  }, [timeOff, techFilter]);

  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div className="month">
      {WD.map((w) => <div className="wd" key={w}>{w}</div>)}
      {cells.map((d) => {
        const iso = isoOf(d);
        const out = d.getMonth() !== month;
        const items = byDate[iso] || [];
        const offItems = offByDate[iso] || [];
        return (
          <div className={`daycell ${out ? 'out' : ''} ${iso === todayIso ? 'today' : ''}`} key={iso}>
            <div className="daynum">{d.getDate()}</div>
            {offItems.map((r) => (
              <div className="dayoff" key={r.id} title={`${r.technicianName} - time off, click to edit`} onClick={() => onEditOff(r)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onEditOff(r)}>
                <span className="jn">{r.technicianName}</span>
              </div>
            ))}
            {items.map((j) => {
              const activeA = j.assignments.filter((a) => !a.completed);
              const doneA = j.assignments.filter((a) => a.completed);
              const showDone = expandedJobs.has(j.id);
              return (
                <div className="dayjob" data-status={statusClass(j.status)} key={j.id} title={j.name} onClick={() => onJobClick(j.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onJobClick(j.id)}>
                  <span className="jn">{j.name.split('—')[0].trim()}</span>
                  {activeA.length > 0 && <span className="inits">{activeA.map((a) => initials(a.technicianName)).join(' ')}</span>}
                  {showDone && doneA.length > 0 && <span className="inits inits-done">{doneA.map((a) => initials(a.technicianName)).join(' ')}</span>}
                  {doneA.length > 0 && (
                    <button
                      type="button"
                      className="done-toggle-mini"
                      aria-expanded={showDone}
                      aria-label={`${doneA.length} completed technician${doneA.length > 1 ? 's' : ''} hidden, toggle to show`}
                      onClick={(e) => { e.stopPropagation(); toggleJob(j.id); }}
                    >
                      ✓{doneA.length}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// Quotes with no due date sort after every dated quote, list-view only -
// the calendar view can't place them at all, so they're simply omitted there.
const quoteSortKey = (q) => q.dueDate || '9999-99-99';

// Own component (not inlined in QuotesTab's .map) so each row can hold its
// own expand state. Per direction 2026-08-30: name + type tag + status
// dropdown + 4 action buttons/badges all crammed into one .row1 was fine on
// desktop but started overlapping once the row narrowed on mobile -- same
// "collapse the extras behind a tap" fix already used for Outstanding
// Jobs' JobCard, reusing its exact .job-expand-toggle/.job-collapsible
// mechanism (display:contents on desktop, so this is a complete no-op
// there -- everything stays inline in .row1 exactly as before). Only the 4
// action buttons/badges are behind the toggle -- status stays visible
// without expanding (those were the two elements actually squeezing/
// overlapping; status alone reads fine at full width). Meta line (account/
// due date/review deadline) stays always-visible too, unlike JobCard --
// per direction, overflow/info-running-off was never a problem on this
// screen, only the buttons were.
function QuoteRow({ quote: q, users, usersLoaded, onLoadUsers, onStatusChange, onSend, onReview }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="job">
      <div className="stripe" data-status={statusClass(q.status)} />
      <div className="body">
        <div className="row1">
          <OppLink className="jname" id={q.id} name={q.name} />
          {q.opportunityType && <span className="quote-type">{q.opportunityType}</span>}
          {/* Per direction 2026-08-30: status stays visible without
              expanding -- only the 4 action buttons/badges below are what
              actually overlapped/squeezed, so only those are behind the
              toggle now. */}
          <QuoteStatusSelect status={q.status} onChange={(status) => onStatusChange(q, status)} />
          <div className={`job-collapsible ${expanded ? 'expanded' : ''}`}>
            <div className="job-collapsible-inner">
              <div className="quote-actions">
                <QuoteRecipientButton quote={q} label="Ready For Review" title="Send this quote for internal review" users={users} usersLoaded={usersLoaded} onLoadUsers={onLoadUsers} onConfirm={onReview} />
                <QuoteRecipientButton quote={q} label="Sent" title="Send this quote for customer approval" users={users} usersLoaded={usersLoaded} onLoadUsers={onLoadUsers} onConfirm={onSend} />
                <QuoteSystemsButton quote={q} />
                <QuoteDocumentsBadge quoteId={q.id} />
              </div>
            </div>
          </div>
          {/* Mobile-only (styles.css) -- desktop's .job-collapsible is
              display:contents, so this toggle has nothing to do there. */}
          <button type="button" className="job-expand-toggle" onClick={() => setExpanded((e) => !e)} aria-label={expanded ? 'Collapse quote actions' : 'Expand quote actions'} aria-expanded={expanded}>
            <span className="job-expand-chevron">{expanded ? '▾' : '▸'}</span>
          </button>
        </div>
        <div className="meta">
          {q.accountName && <span><span className="ic">◍</span>{q.accountName}</span>}
          <span className="created quote-due">{q.dueDate ? `Due ${fmtDate(q.dueDate)}` : 'No due date set'}</span>
          {q.reviewDeadline && <span className="created quote-review-deadline">Review by {fmtDateTime(q.reviewDeadline)}</span>}
        </div>
      </div>
    </div>
  );
}

function QuotesTab({ quotes, loading, quotesView, onViewChange, onStatusChange, onSend, onReview, users, usersLoaded, onLoadUsers }) {
  const [mode, setMode] = useState('list');
  const [calMode, setCalMode] = useState('month');
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [selectedQuote, setSelectedQuote] = useState(null);

  const sorted = useMemo(
    () => [...quotes].sort((a, b) => quoteSortKey(a).localeCompare(quoteSortKey(b))),
    [quotes]
  );

  // The calendar shows the consolidated set (all three segments) so it looks
  // the same no matter which Needs Quote / Ready for Review / Quote Sent
  // segment is selected. Fetched lazily the first time the calendar opens, and
  // re-fetched whenever `quotes` changes (i.e. after any status-change refetch
  // upstream) so the calendar stays in sync with actions taken in the list.
  const [calQuotes, setCalQuotes] = useState([]);
  useEffect(() => {
    if (mode !== 'calendar') return;
    let cancelled = false;
    api.getQuotes('all')
      .then((qs) => { if (!cancelled) setCalQuotes(qs); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [mode, quotes]);
  const calSorted = useMemo(
    () => [...calQuotes].sort((a, b) => quoteSortKey(a).localeCompare(quoteSortKey(b))),
    [calQuotes]
  );

  const shift = (dir) => {
    const d = new Date(anchor);
    if (calMode === 'week') d.setDate(d.getDate() + dir * 7);
    else d.setMonth(d.getMonth() + dir);
    setAnchor(startOfDay(d));
  };

  useEffect(() => {
    if (!selectedQuote) return;
    const onKey = (e) => { if (e.key === 'Escape') setSelectedQuote(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selectedQuote]);

  return (
    <section>
      <div className="view-head">
        <div>
          <h2>Quotes</h2>
          <p>{
            quotesView === 'sent' ? 'Opportunities a quote has been sent for, live from Salesforce.' :
            quotesView === 'review' ? 'Opportunities with a quote ready for internal review, live from Salesforce.' :
            'Opportunities awaiting a quote, live from Salesforce.'
          }</p>
        </div>
      </div>

      <div className="schedbar">
        <div className="seg quote-view-seg">
          <button className={`segbtn ${quotesView === 'needs' ? 'on' : ''}`} onClick={() => onViewChange('needs')}>Needs Quote</button>
          <button className={`segbtn ${quotesView === 'review' ? 'on' : ''}`} onClick={() => onViewChange('review')}>Ready for Review</button>
          <button className={`segbtn ${quotesView === 'sent' ? 'on' : ''}`} onClick={() => onViewChange('sent')}>Quote Sent</button>
        </div>
        {mode === 'calendar' && (
          <>
            <div className="navbtns">
              <button className="navbtn" onClick={() => shift(-1)} aria-label="Previous">‹</button>
              <button className="navbtn" onClick={() => setAnchor(startOfDay(new Date()))}>Today</button>
              <button className="navbtn" onClick={() => shift(1)} aria-label="Next">›</button>
            </div>
            <div className="rangelabel">{rangeLabel(calMode, anchor)}</div>
          </>
        )}
        <div className="schedbar-actions">
          {mode === 'calendar' && (
            <div className="seg">
              <button className={`segbtn ${calMode === 'week' ? 'on' : ''}`} onClick={() => setCalMode('week')}>Week</button>
              <button className={`segbtn ${calMode === 'month' ? 'on' : ''}`} onClick={() => setCalMode('month')}>Month</button>
            </div>
          )}
          <div className="seg">
            <button className={`segbtn ${mode === 'list' ? 'on' : ''}`} onClick={() => setMode('list')}>List</button>
            <button className={`segbtn ${mode === 'calendar' ? 'on' : ''}`} onClick={() => setMode('calendar')}>Calendar</button>
          </div>
        </div>
      </div>

      {loading && (
        <div className="jobs">
          {[0, 1, 2].map((i) => (
            <div key={i} className="job">
              <div className="stripe skel-block" />
              <div className="body">
                <div className="row1">
                  <span className="skel-block" style={{ width: 140, height: 15 }} />
                  <span className="skel-block" style={{ width: 60, height: 15 }} />
                </div>
                <div className="meta">
                  <span className="skel-block" style={{ width: '40%', height: 12 }} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && mode === 'list' && (
        sorted.length === 0 ? (
          <div className="empty">{
            quotesView === 'sent' ? 'No quotes have been sent yet.' :
            quotesView === 'review' ? 'No quotes are ready for review yet.' :
            'No quotes right now.'
          }</div>
        ) : (
          <div className="jobs">
            {sorted.map((q) => (
              <QuoteRow
                key={q.id}
                quote={q}
                users={users}
                usersLoaded={usersLoaded}
                onLoadUsers={onLoadUsers}
                onStatusChange={onStatusChange}
                onSend={onSend}
                onReview={onReview}
              />
            ))}
          </div>
        )
      )}

      {!loading && mode === 'calendar' && (
        <div className="quote-cal-legend">
          <span className="quote-cal-legend-item"><span className="quote-cal-dot due" />Due Date</span>
          <span className="quote-cal-legend-item"><span className="quote-cal-dot review" />Review Deadline</span>
        </div>
      )}
      {!loading && mode === 'calendar' && calMode === 'month' && (
        <QuotesMonthGrid quotes={calSorted} anchor={anchor} onQuoteClick={setSelectedQuote} />
      )}
      {!loading && mode === 'calendar' && calMode === 'week' && (
        <QuotesWeekGrid quotes={calSorted} anchor={anchor} onQuoteClick={setSelectedQuote} />
      )}

      {selectedQuote && (
        <QuoteDetailModal
          quote={selectedQuote}
          onClose={() => setSelectedQuote(null)}
          onStatusChange={(status) => {
            onStatusChange(selectedQuote, status);
            setSelectedQuote(null);
          }}
          onSend={(quote, recipientEmails) => {
            onSend(quote, recipientEmails);
            setSelectedQuote(null);
          }}
          onReview={(quote, recipientEmails) => {
            onReview(quote, recipientEmails);
            setSelectedQuote(null);
          }}
          users={users}
          usersLoaded={usersLoaded}
          onLoadUsers={onLoadUsers}
        />
      )}
    </section>
  );
}

function QuotesMonthGrid({ quotes, anchor, onQuoteClick }) {
  const todayIso = isoOf(startOfDay(new Date()));
  const month = anchor.getMonth();

  const cells = useMemo(() => {
    const first = new Date(anchor.getFullYear(), month, 1);
    const last = new Date(anchor.getFullYear(), month + 1, 0);
    const gridStart = startOfWeek(first);
    const gridEnd = addDays(startOfWeek(last), 6);
    const total = Math.round((gridEnd - gridStart) / 86400000) + 1;
    return Array.from({ length: total }, (_, i) => addDays(gridStart, i));
  }, [anchor, month]);

  // iso -> [{quote, kind}]; a quote contributes an entry per date it has set
  // (due date, review deadline, both, or neither) -- see quoteSortKey for
  // why quotes with no dueDate still appear in list view regardless.
  const byDate = useMemo(() => {
    const m = {};
    quotes.forEach((q) => {
      if (q.dueDate) (m[q.dueDate] ||= []).push({ quote: q, kind: 'due' });
      if (q.reviewDeadline) {
        const iso = isoOf(new Date(q.reviewDeadline));
        (m[iso] ||= []).push({ quote: q, kind: 'review' });
      }
    });
    return m;
  }, [quotes]);

  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <>
      <div className="month sched-desktop">
        {WD.map((w) => <div className="wd" key={w}>{w}</div>)}
        {cells.map((d) => {
          const iso = isoOf(d);
          const out = d.getMonth() !== month;
          const items = byDate[iso] || [];
          return (
            <div className={`daycell ${out ? 'out' : ''} ${iso === todayIso ? 'today' : ''}`} key={iso}>
              <div className="daynum">{d.getDate()}</div>
              {items.map(({ quote: q, kind }) => (
                <div
                  className="dayjob"
                  data-kind={kind}
                  key={`${q.id}-${kind}`}
                  title={kind === 'review' ? `Review deadline ${fmtDateTime(q.reviewDeadline)}: ${q.name}` : `Due ${fmtDate(q.dueDate)}: ${q.name}`}
                  onClick={() => onQuoteClick(q)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && onQuoteClick(q)}
                >
                  <span className="jn"><OppLink id={q.id} name={q.name} /></span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <QuotesAgendaList cells={cells} byDate={byDate} todayIso={todayIso} onQuoteClick={onQuoteClick} />
    </>
  );
}

// Mobile-only stand-in for the 7-column .month/.week grid above -- per
// direction 2026-08-30, same problem (and same fix) as Tech Schedule's own
// desktop grid: 7 columns squeeze unreadably on a phone. Skips days with
// nothing on them entirely (a month view otherwise mostly empty cells) --
// mirrors TechWeekList's own entries-only approach, not a padded grid.
function QuotesAgendaList({ cells, byDate, todayIso, onQuoteClick }) {
  const dayLabel = (iso) => {
    if (iso === todayIso) return 'Today';
    return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' });
  };
  const days = useMemo(() => cells
    .map((d) => { const iso = isoOf(d); return { iso, items: byDate[iso] || [] }; })
    .filter((d) => d.items.length > 0)
  , [cells, byDate]);

  return (
    <div className="quote-agenda-list">
      {days.length === 0 && <div className="tech-week-empty">Nothing due or in review this range.</div>}
      {days.map(({ iso, items }) => (
        <div key={iso} className={`quote-agenda-day ${iso === todayIso ? 'today' : ''}`}>
          <div className="quote-agenda-day-label">{dayLabel(iso)}</div>
          {items.map(({ quote: q, kind }) => (
            <div
              key={`${q.id}-${kind}`}
              className="quote-agenda-row"
              data-kind={kind}
              onClick={() => onQuoteClick(q)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && onQuoteClick(q)}
            >
              <span className="quote-agenda-kind">{kind === 'review' ? 'Review' : 'Due'}</span>
              <span className="quote-agenda-name">{q.name}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// Single-week strip -- reuses the .month grid's CSS (7 columns) with just one
// row of day cells instead of a full padded month.
function QuotesWeekGrid({ quotes, anchor, onQuoteClick }) {
  const todayIso = isoOf(startOfDay(new Date()));

  const cells = useMemo(() => {
    const s = startOfWeek(anchor);
    return Array.from({ length: 7 }, (_, i) => addDays(s, i));
  }, [anchor]);

  const byDate = useMemo(() => {
    const m = {};
    quotes.forEach((q) => {
      if (q.dueDate) (m[q.dueDate] ||= []).push({ quote: q, kind: 'due' });
      if (q.reviewDeadline) {
        const iso = isoOf(new Date(q.reviewDeadline));
        (m[iso] ||= []).push({ quote: q, kind: 'review' });
      }
    });
    return m;
  }, [quotes]);

  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <>
      <div className="month sched-desktop">
        {WD.map((w) => <div className="wd" key={w}>{w}</div>)}
        {cells.map((d) => {
          const iso = isoOf(d);
          const items = byDate[iso] || [];
          return (
            <div className={`daycell ${iso === todayIso ? 'today' : ''}`} key={iso}>
              <div className="daynum">{d.getDate()}</div>
              {items.map(({ quote: q, kind }) => (
                <div
                  className="dayjob"
                  data-kind={kind}
                  key={`${q.id}-${kind}`}
                  title={kind === 'review' ? `Review deadline ${fmtDateTime(q.reviewDeadline)}: ${q.name}` : `Due ${fmtDate(q.dueDate)}: ${q.name}`}
                  onClick={() => onQuoteClick(q)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && onQuoteClick(q)}
                >
                  <span className="jn"><OppLink id={q.id} name={q.name} /></span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <QuotesAgendaList cells={cells} byDate={byDate} todayIso={todayIso} onQuoteClick={onQuoteClick} />
    </>
  );
}

// Only the one dispatcher-driven transition this tab supports: moving a
// quote past the quoting stage once it's ready for the customer to sign off.
// A changed value flows through routes.js's normal PATCH /jobs/:id
// write-through, so an FS-linked opportunity gets pushed to FS too.
function QuoteStatusSelect({ status, onChange }) {
  // The wrapping stopPropagation still works for the portaled option menu --
  // createPortal content bubbles through the React tree (this component),
  // not the DOM tree, so a card row's own onClick below it never sees these.
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <FilterSelect
        value={status}
        onChange={onChange}
        options={[
          ['Needs Quote', 'Needs Quote'],
          ['Ready for Review', 'Ready for Review'],
          ['Pending Customer Approval', 'Pending Customer Approval'],
        ]}
        triggerClassName={`statussel-pill ${statusClass(status)}`}
        ariaLabel="Quote status"
      />
    </div>
  );
}

// Picks one or more Salesforce Users to notify, then moves the quote to
// Pending Customer Approval and emails them (sf.sendEmail in salesforce.js,
// Salesforce's own outbound mail rather than a third-party provider).
// The directory is fetched once, lazily, on first open -- shared across every
// button instance via the users/usersLoaded/onLoadUsers props lifted to App.
// Generalized from a single "Sent" button once "Review" needed the exact
// same recipient-picker shape -- label/title/onConfirm are the only things
// that differ between the two call sites.
function QuoteRecipientButton({ quote, label, title, users, usersLoaded, onLoadUsers, onConfirm }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState([]);
  const wrapRef = useRef(null);
  const popRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, bottom: null, left: 0, maxHeight: 380 });

  useEffect(() => {
    if (open && !usersLoaded) onLoadUsers();
  }, [open, usersLoaded, onLoadUsers]);

  useEffect(() => {
    if (!open) { setQuery(''); setSelected([]); }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const POP_WIDTH = 300;
    const GAP = 6;
    const EDGE = 8;
    const CEILING = 380;
    let left = rect.left;
    if (left + POP_WIDTH > window.innerWidth - EDGE) left = window.innerWidth - POP_WIDTH - EDGE;
    if (left < EDGE) left = EDGE;
    const spaceBelow = window.innerHeight - rect.bottom - GAP - EDGE;
    const spaceAbove = rect.top - GAP - EDGE;
    if (spaceBelow >= spaceAbove) {
      setPos({ top: rect.bottom + GAP, bottom: null, left, maxHeight: Math.max(0, Math.min(CEILING, spaceBelow)) });
    } else {
      setPos({ top: null, bottom: window.innerHeight - rect.top + GAP, left, maxHeight: Math.max(0, Math.min(CEILING, spaceAbove)) });
    }
  }, [open]);

  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (popRef.current?.contains(e.target)) return; setOpen(false); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, [open]);

  const toggleUser = (u) => {
    setSelected((prev) => prev.some((s) => s.id === u.id) ? prev.filter((s) => s.id !== u.id) : [...prev, u]);
  };

  // No slice cap here (unlike AccountContactsMenu's icp-list, which this is
  // otherwise modeled on) -- .icp-list already scrolls, and silently hiding
  // people past the Nth alphabetically is worse than a scrollbar for finding
  // an email recipient.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const selectedIds = new Set(selected.map((s) => s.id));
    return users
      .filter((u) => !selectedIds.has(u.id))
      .filter((u) => !q || fuzzyNameMatch(query, u.name) || u.email.toLowerCase().includes(q));
  }, [users, query, selected]);

  const handleSend = () => {
    onConfirm(quote, selected.map((u) => u.email));
    setOpen(false);
  };

  return (
    <div className="job-notes-wrap" ref={wrapRef}>
      <button
        type="button"
        className="job-notes-badge"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title={title}
      >
        {label}
      </button>
      {open && createPortal(
        <div
          className="notes-pop job-notes-pop"
          ref={popRef}
          style={{ left: pos.left, maxHeight: pos.maxHeight, ...(pos.bottom != null ? { bottom: pos.bottom } : { top: pos.top }) }}
        >
          <div className="inline-contact-picker">
            <input
              className="icp-input"
              type="text"
              placeholder="Search people to notify…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              autoFocus
            />
            {selected.length > 0 && (
              <div className="icp-chips">
                {selected.map((u) => (
                  <span className="icp-chip" key={u.id}>
                    {u.name}
                    <button type="button" onClick={(e) => { e.stopPropagation(); toggleUser(u); }} aria-label={`Remove ${u.name}`}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="icp-list">
              {!usersLoaded && <div className="notes-pop-empty"><LoadingDots inline /></div>}
              {usersLoaded && filtered.map((u) => (
                <button key={u.id} type="button" className="icp-option" onClick={(e) => { e.stopPropagation(); toggleUser(u); }}>
                  <span className="icp-name">{u.name}</span>
                  <span className="icp-company">{u.email}</span>
                </button>
              ))}
              {usersLoaded && filtered.length === 0 && selected.length === 0 && (
                <div className="notes-pop-empty">No matches</div>
              )}
            </div>
          </div>
          <button
            type="button"
            className="icp-send-btn"
            disabled={selected.length === 0}
            onClick={(e) => { e.stopPropagation(); handleSend(); }}
          >
            Send{selected.length > 0 ? ` to ${selected.length}` : ''}
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}

// System-type manufacturer info for a quote's account, in display order.
// The values come pre-loaded on the quote (shapeQuote in routes.js reads them
// off the linked Account), so this button just toggles a read-only modal --
// no fetch needed.
const QUOTE_SYSTEM_ROWS = [
  { key: 'fireAlarm', label: 'Fire Alarm' },
  { key: 'accessControl', label: 'Access Control' },
  { key: 'cctv', label: 'CCTV' },
  { key: 'intrusion', label: 'Intrusion' },
];

function QuoteSystemsButton({ quote }) {
  const [open, setOpen] = useState(false);
  const systems = quote.systems || {};

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="job-notes-badge"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title="Installed-system manufacturers on this account"
      >
        System Info
      </button>
      {open && createPortal(
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="modal-header">
              <div className="modal-title-row">
                <span className="jname">System Info</span>
                {quote.accountName && <span className="quote-type">{quote.accountName}</span>}
              </div>
              <button className="modal-close" onClick={() => setOpen(false)} aria-label="Close">×</button>
            </div>
            <div className="modal-body">
              <dl className="system-info">
                {QUOTE_SYSTEM_ROWS.map(({ key, label }) => (
                  <div className="system-info-row" key={key}>
                    <dt>{label}</dt>
                    <dd className={systems[key] ? '' : 'muted'}>{systems[key] || 'Not recorded'}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

function QuoteDetailModal({ quote, onClose, onStatusChange, onSend, onReview, users, usersLoaded, onLoadUsers }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title-row">
            <span className="jname">{quote.name}</span>
            {quote.opportunityType && <span className="quote-type">{quote.opportunityType}</span>}
            <QuoteStatusSelect status={quote.status} onChange={onStatusChange} />
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          <div className="meta">
            {quote.accountName && <span><span className="ic">◍</span>{quote.accountName}</span>}
            <span className="created quote-due">{quote.dueDate ? `Due ${fmtDate(quote.dueDate)}` : 'No due date set'}</span>
            {quote.reviewDeadline && <span className="created quote-review-deadline">Review by {fmtDateTime(quote.reviewDeadline)}</span>}
          </div>
          <div className="quote-actions">
            <QuoteRecipientButton quote={quote} label="Ready For Review" title="Send this quote for internal review" users={users} usersLoaded={usersLoaded} onLoadUsers={onLoadUsers} onConfirm={onReview} />
            <QuoteRecipientButton quote={quote} label="Sent" title="Send this quote for customer approval" users={users} usersLoaded={usersLoaded} onLoadUsers={onLoadUsers} onConfirm={onSend} />
            <QuoteDocumentsBadge quoteId={quote.id} />
          </div>
        </div>
      </div>
    </div>
  );
}

function QuoteDocumentsBadge({ quoteId }) {
  const [open, setOpen] = useState(false);
  const [docs, setDocs] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const wrapRef = useRef(null);
  const popRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, bottom: null, left: 0, maxHeight: 320 });

  // Fetched lazily per-badge on first open rather than prefetched for every
  // quote up front -- avoids N document queries firing just from loading the
  // tab, when most of them will never be opened.
  useEffect(() => {
    if (!open || loaded) return;
    api.getQuoteDocuments(quoteId)
      .then((d) => { setDocs(d); setLoaded(true); })
      .catch((e) => setLoadError(e.message));
  }, [open, loaded, quoteId]);

  useEffect(() => {
    if (!open) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const POP_WIDTH = 280;
    const GAP = 6;
    const EDGE = 8;
    const CEILING = 320;
    let left = rect.left;
    if (left + POP_WIDTH > window.innerWidth - EDGE) left = window.innerWidth - POP_WIDTH - EDGE;
    if (left < EDGE) left = EDGE;
    const spaceBelow = window.innerHeight - rect.bottom - GAP - EDGE;
    const spaceAbove = rect.top - GAP - EDGE;
    if (spaceBelow >= spaceAbove) {
      setPos({ top: rect.bottom + GAP, bottom: null, left, maxHeight: Math.max(0, Math.min(CEILING, spaceBelow)) });
    } else {
      setPos({ top: null, bottom: window.innerHeight - rect.top + GAP, left, maxHeight: Math.max(0, Math.min(CEILING, spaceAbove)) });
    }
  }, [open]);

  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (popRef.current?.contains(e.target)) return; setOpen(false); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, [open]);

  return (
    <div className="job-notes-wrap" ref={wrapRef}>
      <button
        type="button"
        className="job-notes-badge"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title="Notes and attachments on this opportunity"
      >
        Documents
      </button>
      {open && createPortal(
        <div
          className="notes-pop job-notes-pop"
          ref={popRef}
          style={{ left: pos.left, maxHeight: pos.maxHeight, ...(pos.bottom != null ? { bottom: pos.bottom } : { top: pos.top }) }}
        >
          <div className="notes-pop-list">
            {loadError && <div className="notes-pop-err">{loadError}</div>}
            {!loadError && !loaded && <div className="notes-pop-empty"><LoadingDots inline /></div>}
            {!loadError && loaded && docs.length === 0 && <div className="notes-pop-empty">No documents</div>}
            {!loadError && docs.map((doc) => (
              <div className="notes-pop-row" key={doc.id}>
                <a
                  className="notes-pop-item"
                  href={doc.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="notes-pop-title">{doc.name}</span>
                  {doc.lastModified && <span className="notes-pop-preview">{fmtDate(doc.lastModified.slice(0, 10))}</span>}
                </a>
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// Shared by AddInventoryModal/CheckoutModal - Service Stock unshifted onto
// the front (not pushed) so it sorts first in SearchableSelect's own
// order-preserving filter, mirroring how NoteEditModal prepends the
// currently-linked opportunity when it's missing from `jobs`.
function buildOppOptions(jobs, serviceStock) {
  const base = jobs.map((j) => [j.id, j.lid ? `${j.name} - LID ${j.lid}` : j.name]);
  if (serviceStock && !base.some(([id]) => id === serviceStock.id)) base.unshift([serviceStock.id, serviceStock.name]);
  return base;
}

function catalogOptionsFor(catalog) {
  return catalog.map((p) => [p.id, p.code ? `${p.code} - ${p.name}` : p.name]);
}

function PartsTab({ groups, loading, jobs, techs, catalog, serviceStock, onRefresh, onUpdateRow }) {
  const [addingInventory, setAddingInventory] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [creatingPO, setCreatingPO] = useState(false);
  const [search, setSearch] = useState('');

  // Filters each group's own rows down to matches on part # or name, then
  // drops any group left with zero matching rows -- same idea as AccountsTab's
  // `filtered`, but applied per-group since a part can exist under several
  // Opportunities at once and a search should surface all of them, not just
  // the first match.
  const searchTerm = search.trim().toLowerCase();
  const visibleGroups = useMemo(() => {
    if (!searchTerm) return groups;
    return groups
      .map((g) => ({
        ...g,
        rows: g.rows.filter((r) =>
          (r.productCode && r.productCode.toLowerCase().includes(searchTerm)) ||
          (r.productName && r.productName.toLowerCase().includes(searchTerm))
        ),
      }))
      .filter((g) => g.rows.length > 0);
  }, [groups, searchTerm]);

  return (
    <section>
      <div className="view-head">
        <div>
          <h2>Parts</h2>
          <p>{loading ? <LoadingDots label="Loading…" inline /> : `${groups.length} location${groups.length === 1 ? '' : 's'} with inventory on file`}</p>
        </div>
        <div className="view-head-actions">
          <div className="searchbox" style={{ marginBottom: 0 }}>
            <span className="si">⌕</span>
            <input
              className="searchinput"
              type="text"
              placeholder="Search by part # or name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button className="refresh" onClick={() => setCreatingPO(true)}>+ Create PO</button>
          <button className="refresh" onClick={() => setAddingInventory(true)}>+ Add Inventory</button>
          <button className="refresh" onClick={() => setCheckingOut(true)}>+ Part Checkout</button>
        </div>
      </div>

      {!loading && groups.length === 0 && <div className="state">No inventory on file yet.</div>}
      {!loading && groups.length > 0 && searchTerm && visibleGroups.length === 0 && (
        <div className="state">No parts match "{search.trim()}".</div>
      )}

      {visibleGroups.map((g) => (
        <InventoryGroupSection key={g.opportunityId} group={g} onUpdateRow={onUpdateRow} forceOpen={!!searchTerm} />
      ))}

      {addingInventory && (
        <AddInventoryModal
          jobs={jobs}
          catalog={catalog}
          serviceStock={serviceStock}
          onClose={() => setAddingInventory(false)}
          onSaved={async () => { setAddingInventory(false); await onRefresh(); }}
        />
      )}
      {checkingOut && (
        <CheckoutModal
          jobs={jobs}
          techs={techs}
          catalog={catalog}
          serviceStock={serviceStock}
          onClose={() => setCheckingOut(false)}
          onSaved={async () => { setCheckingOut(false); await onRefresh(); }}
        />
      )}
      {creatingPO && (
        <CreatePOModal
          jobs={jobs}
          serviceStock={serviceStock}
          onClose={() => setCreatingPO(false)}
        />
      )}
    </section>
  );
}

// One collapsible section per Opportunity, modeled on AccountGroupSection --
// Service Stock (isServiceStock) starts open since it's the busiest bucket,
// every other job starts collapsed. Inline quantity edit reuses ContactsTab's
// exact edit-cell convention (.contact-edit-row/-input/-save/-cancel,
// .contact-editable), including its no-rollback-on-failure behavior -- same
// as every other inline edit in this app (see updateContact/updateAccount).
const InventoryGroupSection = React.memo(function InventoryGroupSection({ group, onUpdateRow, forceOpen }) {
  const [open, setOpen] = useState(group.isServiceStock);
  const [editing, setEditing] = useState(null); // { rowId, value }

  // A search that's narrowed this group down to matching rows only (see
  // `search` in PartsTab) should show them without an extra click -- same
  // idea as AccountGroupSection's own forceOpen.
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  const startEdit = (row) => setEditing({ rowId: row.id, value: String(row.quantity) });

  const commitEdit = async () => {
    if (!editing) return;
    const { rowId, value } = editing;
    const n = Number(value);
    setEditing(null);
    if (Number.isNaN(n)) return;
    try {
      await onUpdateRow(rowId, { quantity: n });
    } catch (e) {
      alert(`Could not save: ${e.message}`);
    }
  };

  const onEditKey = (e) => {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') setEditing(null);
  };

  return (
    <div className="mgmt-group">
      <button className="mgmt-group-header" onClick={() => setOpen((o) => !o)}>
        <span className="mgmt-group-chevron">{open ? '▾' : '▸'}</span>
        <span className="mgmt-group-name"><OppLink id={group.opportunityId} name={group.opportunityName} /></span>
        {group.opportunityLid && <span className="lidtag">LID {group.opportunityLid}</span>}
        <span className="mgmt-group-count">{group.rows.length} part{group.rows.length === 1 ? '' : 's'}</span>
      </button>
      <LazyCascade open={open}>
        <div className="contacts-wrap">
          <table className="contacts-table">
            <thead>
              <tr>
                <th>Part #</th>
                <th>Name</th>
                <th>Qty</th>
                <th>Price</th>
                <th>PO #</th>
                <th>PO Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {group.rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.productCode || '-'}</td>
                  <td>{r.productName}</td>
                  <td>
                    {editing?.rowId === r.id
                      ? <div className="contact-edit-row">
                          <input
                            className="contact-edit-input"
                            autoFocus
                            type="number"
                            value={editing.value}
                            onChange={(e) => setEditing({ rowId: r.id, value: e.target.value })}
                            onKeyDown={onEditKey}
                          />
                          <button className="contact-edit-save" onClick={commitEdit}>Save</button>
                          <button className="contact-edit-cancel" onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                      : <span className="contact-editable" onClick={() => startEdit(r)}>{r.quantity}</span>}
                  </td>
                  <td>{r.price != null ? `$${Number(r.price).toFixed(2)}` : '-'}</td>
                  <td>{r.poNumber || '-'}</td>
                  <td>{r.poUploaded ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </LazyCascade>
    </div>
  );
});

// Add Inventory -- Opportunity + PO # / PO-uploaded are shared across the
// whole submission; each repeatable line only carries Product + Quantity.
// No precedent in this codebase for an add/remove-row multi-line form, built
// from scratch; everything else (SearchableSelect, .modal-form-error inline
// validation, .modal-save-btn/.modal-cancel-btn footer) reuses existing
// conventions.
function AddInventoryModal({ jobs, catalog, serviceStock, onClose, onSaved }) {
  const [opportunityId, setOpportunityId] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [poUploaded, setPoUploaded] = useState(false);
  const [lines, setLines] = useState([{ productId: '', quantity: '' }]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const oppOptions = useMemo(() => buildOppOptions(jobs, serviceStock), [jobs, serviceStock]);
  const catalogOptions = useMemo(() => catalogOptionsFor(catalog), [catalog]);

  const updateLine = (i, field, value) => setLines((ls) => ls.map((l, idx) => idx === i ? { ...l, [field]: value } : l));
  const addLine = () => setLines((ls) => [...ls, { productId: '', quantity: '' }]);
  const removeLine = (i) => setLines((ls) => (ls.length > 1 ? ls.filter((_, idx) => idx !== i) : ls));

  const save = async () => {
    setErr(null);
    if (!opportunityId) { setErr('Opportunity is required'); return; }
    const clean = lines.filter((l) => l.productId && Number(l.quantity) > 0);
    if (clean.length === 0) { setErr('At least one product + quantity line is required'); return; }
    setSaving(true);
    try {
      await api.addInventory(opportunityId, {
        poNumber: poNumber.trim() || null,
        poUploaded,
        lines: clean.map((l) => ({ productId: l.productId, quantity: Number(l.quantity) })),
      });
      await onSaved();
    } catch (e) {
      setErr(e.message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !saving && onClose()}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title-row"><span className="jname">Add Inventory</span></div>
          <button className="modal-close" onClick={onClose} aria-label="Close" disabled={saving}>×</button>
        </div>
        <div className="modal-body">
          <label className="req-field req-field-wide">
            <span className="req-field-label">Opportunity</span>
            <SearchableSelect value={opportunityId} onChange={setOpportunityId} options={oppOptions} placeholder="Pick the opportunity (or Service Stock)…" />
          </label>

          {lines.map((l, i) => (
            <div className="req-panel-row" key={i}>
              <label className="req-field req-field-wide">
                <span className="req-field-label">Product</span>
                <SearchableSelect value={l.productId} onChange={(v) => updateLine(i, 'productId', v)} options={catalogOptions} placeholder="Search parts…" />
              </label>
              <label className="req-field">
                <span className="req-field-label">Qty</span>
                <input className="req-note-input" type="number" min="0" value={l.quantity} onChange={(e) => updateLine(i, 'quantity', e.target.value)} />
              </label>
              {lines.length > 1 && (
                <button type="button" className="req-btn" onClick={() => removeLine(i)}>Remove</button>
              )}
            </div>
          ))}
          <button type="button" className="req-btn" onClick={addLine}>+ Add another part</button>

          <label className="req-field req-field-wide">
            <span className="req-field-label">PO #</span>
            <input className="req-note-input" type="text" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} />
          </label>
          <label className="notes-job-check">
            <input type="checkbox" checked={poUploaded} onChange={(e) => setPoUploaded(e.target.checked)} />
            <span>PO uploaded into opportunity</span>
          </label>

          {err && <div className="modal-form-error">{err}</div>}
        </div>
        <div className="modal-footer">
          <button className="modal-save-btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          <button className="modal-cancel-btn" onClick={onClose} disabled={saving}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// Part Checkout -- Opportunity/Checked-out-by/Checkout Date/Material Request #
// /Material Req Attached are shared across the whole submission; each
// repeatable line carries Product + Quantity + optional Flagged for Review.
// Save is gated on materialReqAttached being checked, per the explicit
// requirement -- there's no Salesforce-level enforcement of this anywhere,
// only this client-side gate plus the server's own input validation.
function CheckoutModal({ jobs, techs, catalog, serviceStock, onClose, onSaved }) {
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [opportunityId, setOpportunityId] = useState('');
  const [checkedOutById, setCheckedOutById] = useState('');
  const [checkoutDate, setCheckoutDate] = useState(todayIso);
  const [truckNumber, setTruckNumber] = useState('');
  const [materialRequestNumber, setMaterialRequestNumber] = useState('');
  const [materialReqAttached, setMaterialReqAttached] = useState(false);
  const [lines, setLines] = useState([{ productId: '', quantity: '', flaggedForReview: false }]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const oppOptions = useMemo(() => buildOppOptions(jobs, serviceStock), [jobs, serviceStock]);
  const catalogOptions = useMemo(() => catalogOptionsFor(catalog), [catalog]);

  const updateLine = (i, field, value) => setLines((ls) => ls.map((l, idx) => idx === i ? { ...l, [field]: value } : l));
  const addLine = () => setLines((ls) => [...ls, { productId: '', quantity: '', flaggedForReview: false }]);
  const removeLine = (i) => setLines((ls) => (ls.length > 1 ? ls.filter((_, idx) => idx !== i) : ls));

  const save = async () => {
    setErr(null);
    if (!opportunityId) { setErr('Opportunity is required'); return; }
    if (!checkedOutById) { setErr('Checked out by is required'); return; }
    if (!checkoutDate) { setErr('Checkout date is required'); return; }
    if (!truckNumber.trim()) { setErr('Truck number is required'); return; }
    if (!materialRequestNumber.trim()) { setErr('Material request # is required'); return; }
    if (!materialReqAttached) { setErr('Material req uploaded must be checked'); return; }
    const clean = lines.filter((l) => l.productId && Number(l.quantity) > 0);
    if (clean.length === 0) { setErr('At least one product + quantity line is required'); return; }
    setSaving(true);
    try {
      trackUsage('part_checkout');
      await api.checkoutParts(opportunityId, {
        checkedOutById,
        checkoutDate,
        truckNumber: truckNumber.trim(),
        materialRequestNumber: materialRequestNumber.trim(),
        materialReqAttached,
        lines: clean.map((l) => ({ productId: l.productId, quantity: Number(l.quantity), flaggedForReview: !!l.flaggedForReview })),
      });
      await onSaved();
    } catch (e) {
      setErr(e.message);
      setSaving(false);
    }
  };

  const canSave = opportunityId && checkedOutById && checkoutDate && truckNumber.trim() && materialRequestNumber.trim() && materialReqAttached
    && lines.some((l) => l.productId && Number(l.quantity) > 0);

  return (
    <div className="modal-backdrop" onClick={() => !saving && onClose()}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title-row"><span className="jname">Part Checkout</span></div>
          <button className="modal-close" onClick={onClose} aria-label="Close" disabled={saving}>×</button>
        </div>
        <div className="modal-body">
          <label className="req-field req-field-wide">
            <span className="req-field-label">Opportunity</span>
            <SearchableSelect value={opportunityId} onChange={setOpportunityId} options={oppOptions} placeholder="Pick the opportunity (or Service Stock)…" />
          </label>

          <div className="req-panel-row">
            <label className="req-field">
              <span className="req-field-label">Checked out by</span>
              <select className="techfilter" value={checkedOutById} onChange={(e) => setCheckedOutById(e.target.value)}>
                <option value="">Select a technician…</option>
                {techs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label className="req-field">
              <span className="req-field-label">Checkout date</span>
              <DatePicker value={checkoutDate} onChange={setCheckoutDate} placeholder="Checkout date" clearable={false} />
            </label>
            <label className="req-field">
              <span className="req-field-label">Truck number</span>
              <input className="req-note-input" type="text" value={truckNumber} onChange={(e) => setTruckNumber(e.target.value)} />
            </label>
          </div>

          <label className="req-field req-field-wide">
            <span className="req-field-label">Material request #</span>
            <input className="req-note-input" type="text" value={materialRequestNumber} onChange={(e) => setMaterialRequestNumber(e.target.value)} />
          </label>
          <label className="notes-job-check">
            <input type="checkbox" checked={materialReqAttached} onChange={(e) => setMaterialReqAttached(e.target.checked)} />
            <span>Material req uploaded to opportunity</span>
          </label>

          {lines.map((l, i) => (
            <div className="req-panel-row" key={i}>
              <label className="req-field req-field-wide">
                <span className="req-field-label">Product</span>
                <SearchableSelect value={l.productId} onChange={(v) => updateLine(i, 'productId', v)} options={catalogOptions} placeholder="Search parts…" />
              </label>
              <label className="req-field">
                <span className="req-field-label">Qty</span>
                <input className="req-note-input" type="number" min="0" value={l.quantity} onChange={(e) => updateLine(i, 'quantity', e.target.value)} />
              </label>
              <label className="notes-job-check">
                <input type="checkbox" checked={l.flaggedForReview} onChange={(e) => updateLine(i, 'flaggedForReview', e.target.checked)} />
                <span>Flag for review</span>
              </label>
              {lines.length > 1 && (
                <button type="button" className="req-btn" onClick={() => removeLine(i)}>Remove</button>
              )}
            </div>
          ))}
          <button type="button" className="req-btn" onClick={addLine}>+ Add another part</button>

          {err && <div className="modal-form-error">{err}</div>}
        </div>
        <div className="modal-footer">
          <button className="modal-save-btn" onClick={save} disabled={saving || !canSave}>{saving ? 'Saving…' : 'Check out'}</button>
          <button className="modal-cancel-btn" onClick={onClose} disabled={saving}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ===================== Create PO (QBO purchasing) =====================

// Cheap case-insensitive substring match used for "suggest, never auto-commit"
// vendor/project hints (see the purchase-order plan: QBO Vendor/Project names
// don't reliably string-match SF's) -- this only ever produces a clickable
// suggestion, never a preselected value.
function suggestMatch(needle, list, getLabel) {
  if (!needle) return null;
  const n = needle.toLowerCase();
  return list.find((item) => getLabel(item).toLowerCase().includes(n)) || null;
}

// One selected Opportunity's quote-pick row, for CreatePOModal's "quotes"
// step. Always shows every quote as an explicit choice -- even when there's
// only one -- per direction: no silent "most recent" auto-pick, since
// Awarded_Quote__c can't be trusted to identify the right one (confirmed
// live: it's a display string, not a working lookup).
function OppQuotePicker({ opp, value, onChange }) {
  return (
    <div className="po-opp-block">
      <div className="po-opp-head">
        <span className="po-opp-name">{opp.name}</span>
        {opp.lid && <span className="lidtag">LID {opp.lid}</span>}
      </div>
      {opp.quotes.length === 0 && (
        <div className="po-opp-noquote">No Salesforce quote found for this job - lines will be entered manually.</div>
      )}
      <div className="po-quote-list">
        {opp.quotes.map((q) => (
          <button key={q.id} type="button" className={`po-quote-opt ${value === q.id ? 'on' : ''}`} onClick={() => onChange(q.id)}>
            <span className="po-quote-check" aria-hidden>{value === q.id ? '✓' : ''}</span>
            <span className="po-quote-main">
              <span className="po-quote-num">#{q.quoteNumber || q.name}</span>
              <span className="po-quote-date">{q.createdDate ? q.createdDate.slice(0, 10) : ''}</span>
              <span className="po-quote-total">${Number(q.grandTotal || 0).toFixed(2)}</span>
            </span>
            {q.vendors.length > 0 && <span className="po-quote-vendors">{q.vendors.join(', ')}</span>}
          </button>
        ))}
        <button type="button" className={`po-quote-opt po-quote-manual ${value === 'manual' ? 'on' : ''}`} onClick={() => onChange('manual')}>
          <span className="po-quote-check" aria-hidden>{value === 'manual' ? '✓' : ''}</span>
          Enter lines manually for this job
        </button>
      </div>
    </div>
  );
}

// One opportunity's Project resolution, for CreatePOModal's "projects" step.
// If the Opportunity already carries a stored QBO_Project_Id__c (po-source's
// `qboProjectId`), that's used with no prompt -- it's the crosswalk the first
// PO against a job writes back, so every later one is instant. Only
// opportunities with no stored crosswalk reach the picker below.
// Runs before line/cost entry (see CreatePOModal's step order) -- resolving
// or creating the Project for every selected Opportunity up front, so the
// only thing left by the time the user reaches costs is the rate itself.
// Auto-loads silently when a crosswalk already exists (opp.qboProjectId);
// otherwise leads with a "doesn't exist yet, create it?" prompt (per
// direction), not a neutral existing-vs-new toggle -- "use an existing
// project instead" is offered as a secondary, collapsed escape hatch for the
// rarer case a real Project already exists in QBO but was never crosswalked.
function ProjectPickForOpp({ opp, projectsData, value, onChange }) {
  const [showExisting, setShowExisting] = useState(false);

  const existingName = useMemo(() => {
    if (!opp.qboProjectId) return null;
    return projectsData.projects.find((p) => p.id === opp.qboProjectId)?.name || opp.qboProjectId;
  }, [opp.qboProjectId, projectsData]);

  const projectOptions = useMemo(() => projectsData.projects.map((p) => [p.id, p.fullyQualifiedName]), [projectsData]);
  const parentOptions = useMemo(() => projectsData.parents.map((p) => [p.id, p.name]), [projectsData]);
  const suggestedParent = useMemo(
    () => (opp.accountName ? suggestMatch(opp.accountName, projectsData.parents, (p) => p.name) : null),
    [opp.accountName, projectsData]
  );

  // First render for an unresolved Opportunity: default straight into "new",
  // pre-filled with a sensible name/parent guess -- still fully editable,
  // and creation only actually happens once the user reaches Preview/Create.
  useEffect(() => {
    if (!existingName && !value) {
      onChange({ mode: 'new', displayName: opp.address?.street || opp.name, parentCustomerId: suggestedParent?.id || '' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingName, opp.id]);

  if (existingName) {
    return (
      <div className="po-opp-block">
        <div className="po-opp-head"><span className="po-opp-name">{opp.name}</span></div>
        <div className="po-project-existing">✓ Project loaded automatically: <strong>{existingName}</strong></div>
      </div>
    );
  }

  const mode = value?.mode || 'new';

  return (
    <div className="po-opp-block">
      <div className="po-opp-head"><span className="po-opp-name">{opp.name}</span></div>
      <div className="po-project-prompt">No QBO project found for this job yet - create it?</div>

      {mode === 'new' && (
        <div className="po-newproject">
          <label className="req-field req-field-wide">
            <span className="req-field-label">New project name</span>
            <input className="req-note-input" type="text" value={value?.displayName ?? ''} onChange={(e) => onChange({ mode: 'new', displayName: e.target.value, parentCustomerId: value?.parentCustomerId || '' })} />
          </label>
          <label className="req-field req-field-wide">
            <span className="req-field-label">Under QBO customer</span>
            <SearchableSelect value={value?.parentCustomerId || ''} onChange={(v) => onChange({ mode: 'new', displayName: value?.displayName ?? '', parentCustomerId: v })} options={parentOptions} placeholder="Search QBO customers…" />
          </label>
          {suggestedParent && !value?.parentCustomerId && (
            <button type="button" className="po-suggest" onClick={() => onChange({ mode: 'new', displayName: value?.displayName ?? '', parentCustomerId: suggestedParent.id })}>
              Suggested: {suggestedParent.name} · Use
            </button>
          )}
        </div>
      )}

      {!showExisting ? (
        <button type="button" className="po-suggest" onClick={() => { setShowExisting(true); onChange({ mode: 'existing', projectId: '' }); }}>
          Project already exists in QBO? Search for it instead
        </button>
      ) : (
        <>
          <SearchableSelect value={mode === 'existing' ? (value?.projectId || '') : ''} onChange={(v) => onChange({ mode: 'existing', projectId: v })} options={projectOptions} placeholder="Search QBO projects…" />
          <button type="button" className="po-suggest" onClick={() => { setShowExisting(false); onChange({ mode: 'new', displayName: opp.address?.street || opp.name, parentCustomerId: suggestedParent?.id || '' }); }}>
            Back to creating a new project
          </button>
        </>
      )}
    </div>
  );
}

const PO_STEP_ORDER = ['opps', 'quotes', 'projects', 'lines', 'preview'];

// "+ Create PO" -- multi-opportunity -> per-opp quote pick -> per-opp Project
// resolution -> auto-populated, vendor-grouped line pool -> preview -> create.
// Project resolution happens BEFORE line/cost entry (per direction) so the
// only manual work left on the lines screen is the rate itself -- SKU, item,
// and description all come prefilled from the quote. The largest modal in
// this cluster because a QBO PurchaseOrder is single-vendor but may
// legitimately draw lines from several jobs at once, each needing its own
// Project (QBO's per-job sub-Customer) stamped on its own lines -- see the
// purchase-order plan for the full design rationale.
function CreatePOModal({ jobs, serviceStock, onClose }) {
  const [step, setStep] = useState('opps');
  const [oppIds, setOppIds] = useState([]);
  const [poSource, setPoSource] = useState(null);
  const [quotePick, setQuotePick] = useState({}); // oppId -> quoteId | 'manual'
  const [lines, setLines] = useState([]); // [{key, opportunityId, description, quantity, unitCost}]
  const [qboVendors, setQboVendors] = useState([]);
  const [qboVendorId, setQboVendorId] = useState('');
  // SFDC_Vendor__c -- the real-world vendor object the org's own "CRS
  // Purchase Order" write-back links to, a completely separate system from
  // QBO's own Vendor above (no shared crosswalk field between them,
  // confirmed live 2026-08-26). Suggested by name-match once a QBO vendor is
  // picked, always user-confirmable, never auto-committed.
  const [sfdcVendors, setSfdcVendors] = useState([]);
  const [sfdcVendorId, setSfdcVendorId] = useState('');
  // Cost_Center__c -- a hard SF validation rule on "CRS Purchase Order"
  // requires this (found live 2026-08-21: create fails outright without
  // it). Only 11 real options, mostly vendor-named -- suggested by name
  // match the same way, but REQUIRED to submit (unlike the SFDC vendor
  // picker, which is optional) since the whole SF write-back predictably
  // fails without it.
  const [costCenters, setCostCenters] = useState([]);
  const [costCenterId, setCostCenterId] = useState('');
  const [qboProjectsData, setQboProjectsData] = useState({ projects: [], parents: [] });
  const [qboItems, setQboItems] = useState([]);
  const [projectChoice, setProjectChoice] = useState({}); // oppId -> {mode, projectId} | {mode, displayName, parentCustomerId}
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);

  const oppOptions = useMemo(() => buildOppOptions(jobs, serviceStock), [jobs, serviceStock]);
  const itemOptions = useMemo(() => qboItems.map((i) => [i.id, i.sku ? `${i.sku} - ${i.name}` : i.name]), [qboItems]);

  useEffect(() => {
    api.getQboVendors().then(setQboVendors).catch(() => {});
    api.getSfdcVendors().then(setSfdcVendors).catch(() => {});
    api.getCostCenters().then(setCostCenters).catch(() => {});
    api.getQboProjects().then(setQboProjectsData).catch(() => {});
    api.getQboItems().then(setQboItems).catch(() => {});
  }, []);

  // Suggest a matching SFDC_Vendor__c by name once a QBO Vendor is picked --
  // never overwrites a choice the user already made themselves.
  useEffect(() => {
    if (!qboVendorId || sfdcVendorId || sfdcVendors.length === 0) return;
    const qboVendorName = qboVendors.find((v) => v.id === qboVendorId)?.name;
    const suggested = suggestMatch(qboVendorName, sfdcVendors, (v) => v.name);
    if (suggested) setSfdcVendorId(suggested.id);
  }, [qboVendorId, sfdcVendors, qboVendors, sfdcVendorId]);

  // Suggest a matching Cost Center the same way -- confirmed live 2026-08-26,
  // 35/40 real records match their vendor's name exactly. Tries the SFDC
  // vendor name first (once picked), falling back to the QBO vendor name.
  useEffect(() => {
    if (costCenterId || costCenters.length === 0) return;
    const sfdcVendorName = sfdcVendors.find((v) => v.id === sfdcVendorId)?.name;
    const qboVendorName = qboVendors.find((v) => v.id === qboVendorId)?.name;
    const suggested = suggestMatch(sfdcVendorName, costCenters, (c) => c.name)
      || suggestMatch(qboVendorName, costCenters, (c) => c.name);
    if (suggested) setCostCenterId(suggested.id);
  }, [sfdcVendorId, qboVendorId, costCenters, sfdcVendors, qboVendors, costCenterId]);

  // Opportunities with zero quotes are always effectively "manual" -- stamp
  // that in as soon as poSource loads so quotesReady doesn't block on them.
  useEffect(() => {
    if (!poSource) return;
    setQuotePick((qp) => {
      let changed = false;
      const next = { ...qp };
      for (const o of poSource) {
        if (o.quotes.length === 0 && next[o.id] !== 'manual') { next[o.id] = 'manual'; changed = true; }
      }
      return changed ? next : qp;
    });
  }, [poSource]);

  const goBack = () => setStep((s) => PO_STEP_ORDER[Math.max(0, PO_STEP_ORDER.indexOf(s) - 1)]);

  const loadQuotes = async () => {
    setErr(null);
    setBusy(true);
    try {
      const data = await api.getPoSource(oppIds);
      setPoSource(data);
      setQuotePick({});
      setStep('quotes');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const quotesReady = poSource && poSource.every((o) => o.quotes.length === 0 || quotePick[o.id]);
  const oppById = useMemo(() => new Map((poSource || []).map((o) => [o.id, o])), [poSource]);

  const projectsReady = oppIds.every((oid) => {
    const opp = oppById.get(oid);
    if (opp?.qboProjectId) return true;
    const pc = projectChoice[oid];
    if (!pc) return false;
    return pc.mode === 'existing' ? !!pc.projectId : !!(pc.displayName?.trim() && pc.parentCustomerId);
  });

  // Runs after Project resolution (per direction: projects before costs).
  // Pools every material line the backend returns (already excludes
  // labor/overhead by Product2.Family server-side -- see purchaseOrders.js;
  // Vendor__c alone was too unreliable to gate on, only ~54% of real lines
  // carry one). SKU/item/description prefill for every line; the office
  // decides what actually belongs on THIS vendor's PO by removing rows, not
  // by an automated vendor gate. The QBO Vendor field still suggests the
  // most common vendor tag seen among the pooled lines, since a PO is
  // single-vendor in QBO -- but it's a suggestion, never a filter.
  const loadLines = async () => {
    setErr(null);
    setBusy(true);
    try {
      const quoteIds = Object.values(quotePick).filter((v) => v !== 'manual');
      const results = await Promise.all(quoteIds.map((qid) => api.getQuoteLines(qid)));
      const linesByQuoteId = new Map(quoteIds.map((qid, i) => [qid, results[i]]));
      const pooled = [];
      for (const o of poSource) {
        const pick = quotePick[o.id];
        if (pick === 'manual' || !pick) continue;
        for (const l of linesByQuoteId.get(pick) || []) pooled.push({ ...l, opportunityId: o.id, opportunityName: o.name });
      }
      setLines(
        pooled.map((l) => ({
          key: crypto.randomUUID(),
          opportunityId: l.opportunityId,
          // The Salesforce quote line this row came from -- shown fixed,
          // right next to the QBO item picker, so it's always visible which
          // real part is being added. sourceCode/sourceName are shown as two
          // distinct fields, never joined into one string -- everything
          // here is a real value pulled from an existing record, not
          // authored by this app.
          sourceCode: l.code,
          sourceName: l.name,
          sourceVendor: l.vendor,
          // Real, single field -- the matched QBO Item's own Description
          // when there's a match, else Salesforce's own Product2.Description
          // (see purchaseOrders.js) -- never a code+name concatenation.
          description: l.description,
          quantity: l.quantity || 1,
          unitCost: '',
          itemId: l.itemId || '',
          itemName: l.itemName || '',
          // No match -- offer to create this exact product as a new QBO Item
          // (per direction) instead of silently falling back to a generic
          // account line. Prefilled from Salesforce, fully editable. `code`
          // is the ONE field the user edits and becomes both the new Item's
          // Name and Sku (matching how real items in this org actually look
          // -- Name IS the SKU-like code on almost every one; a distinct Sku
          // is rare). Left blank (not silently filled with the long product
          // name) when Salesforce has no real code, so there's no confusing
          // fallback -- the user has to type a real one.
          newItem: l.itemId ? null : { productId: l.productId, code: l.code || '', description: l.description },
          searchingItem: false,
        }))
      );

      const vendorCounts = new Map();
      for (const l of pooled) if (l.vendor) vendorCounts.set(l.vendor, (vendorCounts.get(l.vendor) || 0) + 1);
      const topVendor = [...vendorCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (topVendor) {
        const suggested = suggestMatch(topVendor, qboVendors, (x) => x.name);
        if (suggested) setQboVendorId((cur) => cur || suggested.id);
      }
      setStep('lines');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const addManualLine = () => setLines((ls) => [...ls, {
    key: crypto.randomUUID(), opportunityId: oppIds.length === 1 ? oppIds[0] : '', sourceCode: null, sourceName: null, sourceVendor: null,
    description: '', quantity: 1, unitCost: '', itemId: '', itemName: '', newItem: null, searchingItem: true,
  }]);
  const updateLine = (key, field, value) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, [field]: value } : l)));
  // Picking a real existing Item clears any pending newItem -- an explicit
  // match always wins over creating a duplicate. Item picks carry both id
  // and name -- the name is what ends up on the QBO line if this Item
  // lookup ever goes stale, and it's what the preview step shows without
  // needing qboItems loaded a second time.
  const updateLineItem = (key, itemId) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, itemId, itemName: qboItems.find((i) => i.id === itemId)?.name || '', newItem: itemId ? null : l.newItem } : l)));
  const updateLineNewItem = (key, field, value) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, newItem: { ...l.newItem, [field]: value } } : l)));
  const toggleSearchItem = (key) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, searchingItem: !l.searchingItem } : l)));
  const removeLine = (key) => setLines((ls) => ls.filter((l) => l.key !== key));

  const linesValid = lines.length > 0 && lines.every((l) => {
    if (!l.opportunityId || !l.description.trim() || !(Number(l.quantity) > 0) || !(Number(l.unitCost) >= 0)) return false;
    if (!l.itemId && l.newItem && !l.newItem.code?.trim()) return false; // pending creation needs a SKU/code
    return true;
  });

  const projectLabelFor = (oid) => {
    const opp = oppById.get(oid);
    if (opp?.qboProjectId) return qboProjectsData.projects.find((p) => p.id === opp.qboProjectId)?.name || opp.qboProjectId;
    const pc = projectChoice[oid];
    if (!pc) return '-';
    if (pc.mode === 'existing') return qboProjectsData.projects.find((p) => p.id === pc.projectId)?.fullyQualifiedName || pc.projectId;
    const parentName = qboProjectsData.parents.find((p) => p.id === pc.parentCustomerId)?.name || pc.parentCustomerId;
    return `NEW - ${pc.displayName} under ${parentName}`;
  };

  const grandTotal = lines.reduce((sum, l) => sum + Number(l.quantity || 0) * Number(l.unitCost || 0), 0);

  const create = async () => {
    setErr(null);
    setBusy(true);
    try {
      trackUsage('create_po');
      const body = {
        vendorId: qboVendorId,
        sfdcVendorId: sfdcVendorId || undefined,
        costCenterId: costCenterId || undefined,
        lines: lines.map((l) => {
          const opp = oppById.get(l.opportunityId);
          const pc = projectChoice[l.opportunityId];
          const base = {
            opportunityId: l.opportunityId, description: l.description.trim(), quantity: Number(l.quantity), unitCost: Number(l.unitCost),
            itemId: l.itemId || undefined, itemName: l.itemName || undefined,
            newItem: (!l.itemId && l.newItem)
              ? { productId: l.newItem.productId, code: l.newItem.code?.trim(), description: l.newItem.description?.trim() || undefined }
              : undefined,
          };
          if (opp?.qboProjectId) return { ...base, projectId: opp.qboProjectId };
          if (pc.mode === 'existing') return { ...base, projectId: pc.projectId };
          return { ...base, newProject: { displayName: pc.displayName.trim(), parentCustomerId: pc.parentCustomerId } };
        }),
      };
      const res = await api.createPurchaseOrder(body);
      setResult(res);
      setStep('done');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal modal-po" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title-row"><span className="jname">Create PO</span></div>
          <button className="modal-close" onClick={onClose} aria-label="Close" disabled={busy}>×</button>
        </div>
        <div className="modal-body">

          {step === 'opps' && (
            <label className="req-field req-field-wide">
              <span className="req-field-label">Opportunities</span>
              <OppMultiSelect value={oppIds} onChange={setOppIds} options={oppOptions} />
            </label>
          )}

          {step === 'quotes' && poSource && (
            <>
              <p className="po-step-hint">Pick which quote to build each job's lines from (or enter that job's lines manually).</p>
              {poSource.map((o) => (
                <OppQuotePicker key={o.id} opp={o} value={quotePick[o.id]} onChange={(v) => setQuotePick((qp) => ({ ...qp, [o.id]: v }))} />
              ))}
            </>
          )}

          {step === 'projects' && (
            <>
              <p className="po-step-hint">Each selected job needs a QBO project - this is what ties purchase cost back to the right job. Resolve these first, then the line list is ready to go.</p>
              {oppIds.map((oid) => (
                <ProjectPickForOpp
                  key={oid}
                  opp={oppById.get(oid)}
                  projectsData={qboProjectsData}
                  value={projectChoice[oid]}
                  onChange={(v) => setProjectChoice((pc) => ({ ...pc, [oid]: v }))}
                />
              ))}
            </>
          )}

          {step === 'lines' && (
            <>
              <p className="po-step-hint">Every line from the selected quote(s) is listed below - remove any that don't belong on this PO, then enter each one's cost. A QBO PO covers one vendor, so lines for a different vendor should come off this one.</p>

              <label className="req-field req-field-wide">
                <span className="req-field-label">QBO Vendor for this PO</span>
                <SearchableSelect value={qboVendorId} onChange={setQboVendorId} options={qboVendors.map((v) => [v.id, v.name])} placeholder="Search QBO vendors…" />
              </label>

              <label className="req-field req-field-wide">
                <span className="req-field-label">Salesforce Vendor (CRS Purchase Order record) - optional</span>
                <SearchableSelect value={sfdcVendorId} onChange={setSfdcVendorId} options={sfdcVendors.map((v) => [v.id, v.name])} placeholder="Search Salesforce vendors…" />
              </label>

              <label className="req-field req-field-wide">
                <span className="req-field-label">Cost Center (CRS Purchase Order record)</span>
                <SearchableSelect value={costCenterId} onChange={setCostCenterId} options={costCenters.map((c) => [c.id, c.name])} placeholder="Search cost centers…" />
              </label>

              {lines.map((l) => (
                <div className="po-line" key={l.key}>
                  <div className="po-line-source-row">
                    <span className={`po-line-source ${l.sourceName ? '' : 'po-line-source-manual'}`}>
                      {l.sourceName ? (
                        <>
                          <span className="po-line-source-tag">From quote</span>
                          {l.sourceCode && <span className="po-line-source-code">{l.sourceCode}</span>}
                          <span className="po-line-source-name">{l.sourceName}</span>
                          {l.sourceVendor && <span className="po-line-source-vendor">{l.sourceVendor}</span>}
                        </>
                      ) : 'Manual line - no source product'}
                    </span>
                    <span className="po-line-arrow" aria-hidden>→</span>
                    <div className="po-line-item">
                      {l.itemId || l.searchingItem ? (
                        <>
                          <SearchableSelect value={l.itemId} onChange={(v) => updateLineItem(l.key, v)} options={itemOptions} placeholder="Search QBO item / SKU…" />
                          {!l.itemId && l.newItem && (
                            <button type="button" className="po-suggest" onClick={() => toggleSearchItem(l.key)}>Back to creating a new item</button>
                          )}
                        </>
                      ) : l.newItem ? (
                        <div className="po-line-newitem">
                          <div className="po-line-newitem-prompt">No QBO item found - create it?</div>
                          <input className="req-note-input" type="text" placeholder="SKU / part #" value={l.newItem.code} onChange={(e) => updateLineNewItem(l.key, 'code', e.target.value)} />
                          <input className="req-note-input" type="text" placeholder="Description" value={l.newItem.description} onChange={(e) => updateLineNewItem(l.key, 'description', e.target.value)} />
                          <button type="button" className="po-suggest" onClick={() => toggleSearchItem(l.key)}>Already exists in QBO? Search instead</button>
                        </div>
                      ) : (
                        <SearchableSelect value={l.itemId} onChange={(v) => updateLineItem(l.key, v)} options={itemOptions} placeholder="Search QBO item / SKU to add…" />
                      )}
                    </div>
                  </div>
                  <div className="po-line-row">
                    {oppIds.length > 1 && (
                      <select className="techfilter po-line-opp" value={l.opportunityId} onChange={(e) => updateLine(l.key, 'opportunityId', e.target.value)}>
                        <option value="">Job…</option>
                        {(poSource || []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                    )}
                    <input className="req-note-input po-line-desc" type="text" placeholder="Description" value={l.description} onChange={(e) => updateLine(l.key, 'description', e.target.value)} />
                    <input className="req-note-input po-line-qty" type="number" min="0" placeholder="Qty" value={l.quantity} onChange={(e) => updateLine(l.key, 'quantity', e.target.value)} />
                    <input className="req-note-input po-line-cost" type="number" min="0" step="0.01" placeholder="Unit cost" value={l.unitCost} onChange={(e) => updateLine(l.key, 'unitCost', e.target.value)} />
                    <button type="button" className="req-btn" onClick={() => removeLine(l.key)}>Remove</button>
                  </div>
                  {!l.itemId && !l.newItem && (
                    <div className="po-line-hint">No QBO item selected - this line will post to the generic "Materials" account instead of a specific part. Search above to pick or create one.</div>
                  )}
                </div>
              ))}
              <button type="button" className="req-btn" onClick={addManualLine}>+ Add line</button>
            </>
          )}

          {step === 'preview' && (
            <>
              <div className="po-preview-vendor">Vendor: <strong>{qboVendors.find((v) => v.id === qboVendorId)?.name}</strong></div>
              <div className="po-scroll">
                <table className="po-preview-table">
                  <thead>
                    <tr><th>Job</th><th>QBO Item</th><th>Description</th><th>Qty</th><th>Unit cost</th><th>Total</th><th>Project</th></tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => {
                      const label = projectLabelFor(l.opportunityId);
                      return (
                        <tr key={l.key}>
                          <td>{oppById.get(l.opportunityId)?.name}</td>
                          <td>
                            {l.itemName
                              ? l.itemName
                              : l.newItem
                              ? <span className="po-new-badge">NEW - {l.newItem.code}</span>
                              : <span className="po-new-badge">Materials (generic)</span>}
                          </td>
                          <td>{l.description}</td>
                          <td>{l.quantity}</td>
                          <td>${Number(l.unitCost || 0).toFixed(2)}</td>
                          <td>${(Number(l.quantity || 0) * Number(l.unitCost || 0)).toFixed(2)}</td>
                          <td>{label.startsWith('NEW -') ? <span className="po-new-badge">{label}</span> : label}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr><td colSpan={5}>Total</td><td colSpan={2}>${grandTotal.toFixed(2)}</td></tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}

          {step === 'done' && result && (
            <div className="po-done">
              <p>Purchase Order <strong>{result.docNumber || `#${result.id}`}</strong> created in QuickBooks.</p>
              {result.sfWriteWarning && <div className="inv-caution">{result.sfWriteWarning}</div>}
              <a className="modal-save-btn po-done-link" href={`https://qbo.intuit.com/app/purchaseorder?txnId=${result.id}`} target="_blank" rel="noreferrer">Open in QuickBooks</a>
            </div>
          )}

          {err && <div className="modal-form-error">{err}</div>}
        </div>
        <div className="modal-footer">
          {step !== 'opps' && step !== 'done' && <button className="modal-cancel-btn" onClick={goBack} disabled={busy}>Back</button>}
          {step === 'opps' && <button className="modal-save-btn" onClick={loadQuotes} disabled={busy || oppIds.length === 0}>{busy ? <LoadingDots inline /> : 'Next'}</button>}
          {step === 'quotes' && <button className="modal-save-btn" onClick={() => setStep('projects')} disabled={!quotesReady}>Next</button>}
          {step === 'projects' && <button className="modal-save-btn" onClick={loadLines} disabled={busy || !projectsReady}>{busy ? <LoadingDots inline /> : 'Next'}</button>}
          {step === 'lines' && <button className="modal-save-btn" onClick={() => setStep('preview')} disabled={!linesValid || !qboVendorId || !costCenterId}>Next</button>}
          {step === 'preview' && <button className="modal-save-btn" onClick={create} disabled={busy}>{busy ? 'Creating…' : 'Create Purchase Order'}</button>}
          {step === 'done'
            ? <button className="modal-save-btn" onClick={onClose}>Done</button>
            : <button className="modal-cancel-btn" onClick={onClose} disabled={busy}>Cancel</button>}
        </div>
      </div>
    </div>
  );
}

// ===================== Create Invoice (QBO invoicing from FS SERVICE_ACK) =====================
// "+ Create Invoice" -- single job -> pick a real (non-empty) SERVICE_ACK doc
// -> confirm/override the drafted lines -> preview -> create. Scoped to one
// job at a time (unlike Create PO's multi-opportunity picker), opened from
// either JobCard (every Outstanding Jobs row) or JobInvoiceRow (Accounts ->
// Ready to Bill). Confirmed against a real sent invoice end-to-end during
// build (WO 53158 / 7849883) -- every default this modal shows (anchor line,
// narrative, tech items, rates, tax codes, Truck Charges) matched the real
// invoice's own defaults exactly; only "Helper" needs its rate/tax
// hand-entered every time, since it's a deliberately blank $0/non-taxable
// catalog default -- same as the real office does.

// "Service - X" / bare RecordType Service_Call -- confirmed live 2026-08-25
// most real Opportunities (~44k of ~45k) have no RecordType at all, so
// RecordType alone can't gate this; Opportunity_Type__c is the populated,
// reliable signal.
function isConfirmedServiceJob(job) {
  if (job?.recordType === 'Service_Call') return true;
  return (job?.opportunityType || '').toLowerCase().startsWith('service');
}

function CreateInvoiceModal({ job, onClose, onSaved }) {
  const [step, setStep] = useState('docs');
  const [docs, setDocs] = useState(null);
  const [docId, setDocId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [groups, setGroups] = useState([]);
  const [partsLines, setPartsLines] = useState([]);
  const [customerId, setCustomerId] = useState('');
  const [qboParents, setQboParents] = useState([]);
  const [salesItems, setSalesItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);

  const notConfirmedService = !isConfirmedServiceJob(job);

  useEffect(() => {
    api.getQboProjects().then((d) => setQboParents(d.parents || [])).catch(() => {});
    api.getQboSalesItems().then(setSalesItems).catch(() => {});
    setErr(null);
    api.getServiceAcks(job.id).then((d) => setDocs(d.docs || [])).catch((e) => setErr(e.message));
  }, [job.id]);

  const salesItemOptions = useMemo(() => salesItems.map((i) => [i.id, i.sku ? `${i.sku} - ${i.name}` : i.name]), [salesItems]);

  const loadLines = async (pickedDocId) => {
    setErr(null);
    setBusy(true);
    try {
      const d = await api.getServiceAckLines(job.id, pickedDocId);
      setDraft(d);
      setDocId(pickedDocId);
      setGroups(d.groups.map((g) => ({
        date: g.date,
        dateNote: g.dateNote,
        laborLines: g.laborLines.map((l) => ({ ...l, key: crypto.randomUUID() })),
        truckCharge: g.truckCharge ? { ...g.truckCharge } : null,
      })));
      setPartsLines((d.partsLines || []).map((p) => ({
        ...p,
        key: crypto.randomUUID(),
        newItem: p.itemId ? null : { code: p.code || '', description: p.name || '' },
      })));
      setCustomerId(d.customerSuggestions?.[0]?.qboCustomerId || '');
      setStep('lines');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const updateLabor = (gi, key, field, value) => setGroups((gs) => gs.map((g, i) => (i !== gi ? g : {
    ...g, laborLines: g.laborLines.map((l) => (l.key === key ? { ...l, [field]: value } : l)),
  })));
  const updateLaborItem = (gi, key, itemId) => {
    const item = salesItems.find((i) => i.id === itemId);
    setGroups((gs) => gs.map((g, i) => (i !== gi ? g : {
      ...g, laborLines: g.laborLines.map((l) => (l.key === key ? { ...l, itemId, itemName: item?.name || '', rate: item?.unitPrice ?? l.rate } : l)),
    })));
  };
  const updateDateNote = (gi, value) => setGroups((gs) => gs.map((g, i) => (i !== gi ? g : { ...g, dateNote: value })));
  const updateTruckCharge = (gi, field, value) => setGroups((gs) => gs.map((g, i) => (i !== gi ? g : {
    ...g, truckCharge: g.truckCharge ? { ...g.truckCharge, [field]: value } : g.truckCharge,
  })));

  const updatePart = (key, field, value) => setPartsLines((ps) => ps.map((p) => (p.key === key ? { ...p, [field]: value } : p)));
  const updatePartItem = (key, itemId) => {
    const item = salesItems.find((i) => i.id === itemId);
    setPartsLines((ps) => ps.map((p) => (p.key === key ? { ...p, itemId, itemName: item?.name || '', rate: item?.unitPrice ?? p.rate, newItem: null } : p)));
  };
  const updatePartNewItem = (key, field, value) => setPartsLines((ps) => ps.map((p) => (p.key === key ? { ...p, newItem: { ...p.newItem, [field]: value } } : p)));
  const removePart = (key) => setPartsLines((ps) => ps.filter((p) => p.key !== key));

  const grandTotal = useMemo(() => {
    let sum = 0;
    for (const g of groups) {
      for (const l of g.laborLines) sum += Number(l.hours || 0) * Number(l.rate || 0);
      if (g.truckCharge) sum += Number(g.truckCharge.rate || 0);
    }
    for (const p of partsLines) sum += Number(p.qty || 0) * Number(p.rate || 0);
    return sum;
  }, [groups, partsLines]);

  const linesValid = customerId && groups.some((g) => g.laborLines.some((l) => l.itemId && Number(l.hours) > 0));

  const create = async () => {
    setErr(null);
    setBusy(true);
    try {
      trackUsage('create_invoice');
      const body = {
        oppId: job.id,
        customerId,
        anchorLine: draft.anchorLine,
        headerNarrative: draft.headerNarrative,
        groups: groups.map((g) => ({
          date: g.date,
          dateNote: g.dateNote,
          laborLines: g.laborLines.map((l) => ({ itemId: l.itemId, itemName: l.itemName, hours: Number(l.hours), rate: Number(l.rate || 0), taxCodeRef: l.taxCodeRef })),
          truckCharge: g.truckCharge?.itemId ? { itemId: g.truckCharge.itemId, itemName: g.truckCharge.itemName, rate: Number(g.truckCharge.rate || 0), taxCodeRef: g.truckCharge.taxCodeRef } : null,
        })),
        partsLines: partsLines.map((p) => ({
          itemId: p.itemId || undefined,
          itemName: p.itemName || undefined,
          qty: Number(p.qty || 1),
          rate: Number(p.rate || 0),
          taxCodeRef: p.taxCodeRef,
          newItem: (!p.itemId && p.newItem?.code) ? { code: p.newItem.code.trim(), description: p.newItem.description } : undefined,
        })),
      };
      const res = await api.createInvoice(body);
      setResult(res);
      setStep('done');
      if (onSaved) onSaved();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal modal-inv" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title-row"><span className="jname">Create Invoice</span></div>
          <button className="modal-close" onClick={onClose} aria-label="Close" disabled={busy}>×</button>
        </div>
        <div className="modal-body">
          {notConfirmedService && (
            <div className="inv-caution">Invoice feature has not yet been designed for Jobs, T&I, or Monitoring -- this job isn't confirmed Service type. You can still try, but review carefully before sending.</div>
          )}

          {step === 'docs' && (
            <>
              <p className="po-step-hint">Pick which completed visit to draft this invoice from.</p>
              {docs === null && !err && <LoadingDots label="Loading Field Squared data…" />}
              {docs && docs.length === 0 && <div className="state">No completed Field Squared documents found for this job.</div>}
              {docs && docs.map((d) => (
                <button key={d.docId} type="button" className="inv-doc-pick" onClick={() => loadLines(d.docId)} disabled={busy}>
                  <div className="inv-doc-dates">{d.dates.join(', ')}</div>
                  <div className="inv-doc-meta">{d.techs.join(', ')} · {d.totalHours}h{d.hasParts ? ' · has parts' : ''}</div>
                </button>
              ))}
            </>
          )}

          {step === 'lines' && draft && (
            <>
              {draft.assignmentFlags?.length > 0 && (
                <div className="inv-caution inv-caution-mismatch">
                  {draft.assignmentFlags.map((msg, i) => <div key={i}>{msg}</div>)}
                </div>
              )}

              <label className="req-field req-field-wide">
                <span className="req-field-label">Bill to (QBO Customer)</span>
                {draft.customerSuggestions?.length > 0 && (
                  <div className="inv-customer-suggestions">
                    {draft.customerSuggestions.map((s) => (
                      <button key={s.qboCustomerId} type="button" className={`inv-suggest-chip ${customerId === s.qboCustomerId ? 'on' : ''}`} onClick={() => setCustomerId(s.qboCustomerId)}>
                        {s.name} <span className="ct">×{s.count}</span>
                      </button>
                    ))}
                  </div>
                )}
                <SearchableSelect value={customerId} onChange={setCustomerId} options={qboParents.map((p) => [p.id, p.name])} placeholder="Search QBO customers…" />
              </label>

              <div className="inv-anchor">Line 1 (fixed): {draft.anchorLine}</div>
              {draft.headerNarrative && <div className="inv-narrative">{draft.headerNarrative}</div>}

              {groups.map((g, gi) => (
                <div className="inv-group" key={g.date}>
                  <input className="req-note-input inv-datenote" type="text" value={g.dateNote} onChange={(e) => updateDateNote(gi, e.target.value)} />
                  {g.laborLines.map((l) => (
                    <div className="inv-labor-line" key={l.key}>
                      <span className="inv-labor-tech">{l.techName}{l.repType?.length ? <span className="inv-reptype"> ({l.repType.join(', ')})</span> : null}</span>
                      <span className="inv-labor-hours">{l.hours}h</span>
                      <SearchableSelect value={l.itemId} onChange={(v) => updateLaborItem(gi, l.key, v)} options={salesItemOptions} placeholder="QBO labor item…" />
                      <input className="req-note-input po-line-cost" type="number" min="0" step="0.01" placeholder="Rate" value={l.rate ?? ''} onChange={(e) => updateLabor(gi, l.key, 'rate', e.target.value)} />
                    </div>
                  ))}
                  {g.truckCharge && (
                    <div className="inv-labor-line">
                      <span className="inv-labor-tech">{g.truckCharge.itemName}</span>
                      <span className="inv-labor-hours">1</span>
                      <span />
                      <input className="req-note-input po-line-cost" type="number" min="0" step="0.01" value={g.truckCharge.rate ?? ''} onChange={(e) => updateTruckCharge(gi, 'rate', e.target.value)} />
                    </div>
                  )}
                </div>
              ))}

              {!draft.partsRecorded && (
                <div className="inv-parts-none">No parts recorded on this visit -- confirm none were used before sending.</div>
              )}
              {partsLines.length > 0 && (
                <div className="inv-parts">
                  <div className="po-step-hint">Parts from this visit:</div>
                  {partsLines.map((p) => (
                    <div className="po-line" key={p.key}>
                      <div className="po-line-source-row">
                        <span className="po-line-source"><span className="po-line-source-code">{p.code}</span><span className="po-line-source-name">{p.name}</span></span>
                        <span className="po-line-arrow" aria-hidden>→</span>
                        <div className="po-line-item">
                          {p.itemId ? (
                            <SearchableSelect value={p.itemId} onChange={(v) => updatePartItem(p.key, v)} options={salesItemOptions} placeholder="Search QBO item…" />
                          ) : (
                            <div className="po-line-newitem">
                              <div className="po-line-newitem-prompt">No QBO item found - create it?</div>
                              <input className="req-note-input" type="text" placeholder="SKU / part #" value={p.newItem?.code || ''} onChange={(e) => updatePartNewItem(p.key, 'code', e.target.value)} />
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="po-line-row">
                        <input className="req-note-input po-line-qty" type="number" min="0" value={p.qty} onChange={(e) => updatePart(p.key, 'qty', e.target.value)} />
                        <input className="req-note-input po-line-cost" type="number" min="0" step="0.01" placeholder="Rate" value={p.rate ?? ''} onChange={(e) => updatePart(p.key, 'rate', e.target.value)} />
                        <button type="button" className="req-btn" onClick={() => removePart(p.key)}>Remove</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {step === 'preview' && draft && (
            <>
              <div className="po-preview-vendor">Bill to: <strong>{draft.customerSuggestions?.find((s) => s.qboCustomerId === customerId)?.name || qboParents.find((p) => p.id === customerId)?.name || customerId}</strong></div>
              <div className="po-scroll">
                <table className="po-preview-table">
                  <thead><tr><th>Line</th><th>Qty</th><th>Rate</th><th>Total</th></tr></thead>
                  <tbody>
                    <tr><td>{draft.anchorLine}</td><td colSpan={3}></td></tr>
                    {draft.headerNarrative && <tr><td>{draft.headerNarrative}</td><td colSpan={3}></td></tr>}
                    {groups.map((g) => (
                      <React.Fragment key={g.date}>
                        <tr><td>{g.dateNote}</td><td colSpan={3}></td></tr>
                        {g.laborLines.map((l) => (
                          <tr key={l.key}><td>{l.itemName || '(no item picked)'}</td><td>{l.hours}</td><td>${Number(l.rate || 0).toFixed(2)}</td><td>${(Number(l.hours || 0) * Number(l.rate || 0)).toFixed(2)}</td></tr>
                        ))}
                        {g.truckCharge && (
                          <tr><td>{g.truckCharge.itemName}</td><td>1</td><td>${Number(g.truckCharge.rate || 0).toFixed(2)}</td><td>${Number(g.truckCharge.rate || 0).toFixed(2)}</td></tr>
                        )}
                      </React.Fragment>
                    ))}
                    {partsLines.map((p) => (
                      <tr key={p.key}><td>{p.itemName || p.name}</td><td>{p.qty}</td><td>${Number(p.rate || 0).toFixed(2)}</td><td>${(Number(p.qty || 0) * Number(p.rate || 0)).toFixed(2)}</td></tr>
                    ))}
                  </tbody>
                  <tfoot><tr><td colSpan={3}>Total</td><td>${grandTotal.toFixed(2)}</td></tr></tfoot>
                </table>
              </div>
              <p className="po-step-hint">Tax follows each line's QBO item default and is editable in QBO before sending. This tool never sends the invoice -- it's created unsent for office review.</p>
            </>
          )}

          {step === 'done' && result && (
            <div className="po-done">
              <p>Invoice <strong>{result.docNumber || `#${result.id}`}</strong> created in QuickBooks (total ${Number(result.total || 0).toFixed(2)}), unsent.</p>
              <a className="modal-save-btn po-done-link" href={`https://qbo.intuit.com/app/invoice?txnId=${result.id}`} target="_blank" rel="noreferrer">Open in QuickBooks</a>
            </div>
          )}

          {err && <div className="modal-form-error">{err}</div>}
        </div>
        <div className="modal-footer">
          {step === 'lines' && <button className="modal-cancel-btn" onClick={() => setStep('docs')} disabled={busy}>Back</button>}
          {step === 'preview' && <button className="modal-cancel-btn" onClick={() => setStep('lines')} disabled={busy}>Back</button>}
          {step === 'lines' && <button className="modal-save-btn" onClick={() => setStep('preview')} disabled={!linesValid}>Next</button>}
          {step === 'preview' && <button className="modal-save-btn" onClick={create} disabled={busy}>{busy ? 'Creating…' : 'Create Invoice'}</button>}
          {step === 'done'
            ? <button className="modal-save-btn" onClick={onClose}>Done</button>
            : <button className="modal-cancel-btn" onClick={onClose} disabled={busy}>Cancel</button>}
        </div>
      </div>
    </div>
  );
}

// ===================== Office auth + usage UI =====================

// Office login gate (email + password). Rendered by App when there's no session.
function DispatchLogin({ onLoggedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!email.trim() || !password) return;
    setErr(null); setBusy(true);
    try {
      const ok = await authLogin(email.trim(), password);
      if (ok) { trackUsage('login'); onLoggedIn(); }
      else setErr('Invalid email or password.');
    } catch (e) { setErr(e.message || 'Login failed.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="login-screen">
      <div className="login-card">
        <img className="wordmark-logo" src="/icon-192.png" alt="CRS" />
        <h1>CRS Helper</h1>
        <p className="login-sub">Office sign in</p>
        <input type="email" placeholder="Email" value={email} autoFocus
          onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        <input type="password" placeholder="Password" value={password}
          onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        {err && <p className="login-err">{err}</p>}
        <button className="login-btn" disabled={busy || !email.trim() || !password} onClick={submit}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
    </div>
  );
}

// Account panel opened from the header avatar: info + role + change password + log out.
function AccountMenu({ user, onClose, onLoggedOut }) {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const save = async () => {
    setErr(null); setMsg(null);
    if (pw.trim().length < 3) { setErr('Password must be at least 3 characters.'); return; }
    if (pw !== confirm) { setErr('Passwords do not match.'); return; }
    setBusy(true);
    try { await authChangePassword(pw.trim()); setMsg('Password changed.'); setPw(''); setConfirm(''); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header"><div className="modal-title-row"><span className="jname">Account</span></div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button></div>
        <div className="modal-body">
          <div className="acct-info">
            <div className="acct-avatar lg">{initials(user.name)}</div>
            <div>
              <div className="acct-name">{user.name}</div>
              <div className="acct-email">{user.email}</div>
              <span className={`acct-role ${user.isAdmin ? 'admin' : ''}`}>{user.isAdmin ? 'Admin' : 'User'}</span>
            </div>
          </div>
          <label className="req-field req-field-wide"><span className="req-field-label">Change password</span>
            <input className="req-note-input" type="password" placeholder="New password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </label>
          <input className="req-note-input" type="password" placeholder="Confirm new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          {err && <p className="req-error">{err}</p>}
          {msg && <p className="acct-ok">{msg}</p>}
          <button className="modal-save-btn" disabled={busy || !pw.trim()} onClick={save}>{busy ? 'Saving…' : 'Save password'}</button>
        </div>
        <div className="modal-footer">
          <button className="modal-cancel-btn" onClick={onLoggedOut}>Log out</button>
          <div className="modal-footer-spacer" />
          {/* Real build timestamp (vite.config.js), not a hardcoded/manually-
              bumped version string -- per direction 2026-08-28, a quick way
              to confirm a deploy actually reached this device instead of
              guessing from whether something visibly changed. */}
          <span className="acct-build-time" title="When this version was built">Build {__BUILD_TIME__}</span>
        </div>
      </div>
    </div>
  );
}

// Admin: list office users; click one to open their profile (password + role).
function OfficeUsersModal({ meName, onClose }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState(null);
  const reload = useCallback(async () => {
    setLoading(true);
    try { const r = await api.getOfficeUsers(); setUsers(r.users); }
    catch (e) { alert(`Could not load office users: ${e.message}`); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return (
    <>
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal modal-sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
          <div className="modal-header"><div className="modal-title-row"><span className="jname">Office users</span></div>
            <button className="modal-close" onClick={onClose} aria-label="Close">×</button></div>
          <div className="modal-body">
            {loading ? <LoadingDots label="Loading…" inline /> : (
              <div className="manage-techs-list">
                {users.map((u) => (
                  <button key={u.id} className="office-user-row" onClick={() => setSel(u)}>
                    <span className="mt-name">{u.name}</span>
                    <span className="office-user-email">{u.email}</span>
                    <span className={`acct-role ${u.isAdmin ? 'admin' : ''}`}>{u.isAdmin ? 'Admin' : 'User'}</span>
                  </button>
                ))}
                {users.length === 0 && <p className="tech-links-hint">No office users yet - check <code>Dispatch_Access__c</code> on a Salesforce User.</p>}
              </div>
            )}
          </div>
          <div className="modal-footer"><button className="modal-cancel-btn" onClick={onClose}>Close</button></div>
        </div>
      </div>
      {sel && <OfficeUserProfile user={sel} onClose={() => setSel(null)} onSaved={() => { setSel(null); reload(); }} />}
    </>
  );
}

function OfficeUserProfile({ user, onClose, onSaved }) {
  const [pw, setPw] = useState(user.password || '');
  const [isAdmin, setIsAdmin] = useState(user.isAdmin);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const save = async () => {
    setErr(null); setBusy(true);
    try { await api.updateOfficeUser(user.id, { password: pw.trim(), isAdmin }); onSaved(); }
    catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header"><div className="modal-title-row"><span className="jname">{user.name}</span></div>
          <button className="modal-close" onClick={onClose} disabled={busy} aria-label="Close">×</button></div>
        <div className="modal-body">
          <p className="tech-links-hint">{user.email}</p>
          <label className="req-field req-field-wide"><span className="req-field-label">Password</span>
            <input className="req-note-input" type="text" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Blank = reset to the default" />
          </label>
          <label className="role-toggle">
            <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
            <span>Admin - can see Usage &amp; manage office users</span>
          </label>
          {err && <p className="req-error">{err}</p>}
        </div>
        <div className="modal-footer">
          <button className="modal-save-btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
          <button className="modal-cancel-btn" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

const fmtUsageDate = (ts) => (ts ? new Date(Number(ts)).toLocaleString() : '-');

const fmtUsageShort = (ts) => (ts ? new Date(Number(ts)).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '-');
const USAGE_APPS = [['all', 'All'], ['board', 'Board'], ['dispatch', 'Dispatch']];
// Friendly labels for raw event slugs. Drives the "Actions summary" panel and
// the friendlier labels in the Top features table / recent-activity feed. Any
// slug not listed falls back to its raw form (see eventLabel), so tracking a
// new event never breaks - it just shows un-prettified until added here.
const EVENT_LABELS = {
  // dispatch (office)
  assignment_add: 'Scheduled a tech',
  assignment_reschedule: 'Rescheduled a tech',
  assignment_remove: 'Removed a schedule',
  assignment_complete: 'Marked work complete',
  assignment_reopen: 'Reopened completed work',
  unschedule: 'Unscheduled a job',
  status_change: 'Changed a job status',
  quote_sent: 'Sent a quote',
  quote_review: 'Sent a quote for review',
  schedule_approve: 'Approved a schedule request',
  schedule_counter: 'Countered a schedule request',
  schedule_deny: 'Denied a schedule request',
  note_add: 'Added a note',
  tech_add: 'Added a technician',
  timeoff_add: 'Added time off',
  part_checkout: 'Checked out parts',
  fs_link: 'Linked a Field Squared task',
  login: 'Logged in',
  create_po: 'Created a purchase order',
  create_invoice: 'Created an invoice',
  job_detail_open: 'Opened a job from the calendar',
  opp_link_click: 'Opened an Opportunity in Salesforce',
  // board (tech app)
  request_new: 'Requested a schedule',
  request_accept: 'Accepted an offer',
  request_counter: 'Countered an offer',
  request_update: 'Updated a request',
  request_withdraw: 'Withdrew a request',
};
const eventLabel = (slug) => EVENT_LABELS[slug] || slug;
// Screen views are navigation ("opened the Jobs tab"), not actions taken inside
// a screen - kept as a separate category everywhere in the Usage dashboard.
// screen_view_end (the matching "they left" marker, carrying duration) counts
// as a view too for styling purposes -- it never actually reaches the
// aggregate byEvent/byScreen-count queries (excluded there at the SQL level,
// see NO_DURATION_MARKER_CLAUSE), only the recent-activity feed, where this
// just keeps it tagged "View" rather than looking like an "Action".
const isScreenView = (slug) => slug === 'screen_view' || slug === 'screen_view_end';
// Pulls durationMs back out of a feed row's raw `props` JSON string (the
// recent-activity queries select props as text, not the parsed object).
const feedDurationMs = (props) => {
  if (!props) return null;
  try { return JSON.parse(props)?.durationMs ?? null; } catch { return null; }
};
// One friendly line for a feed row: "Viewed Jobs" when it opens, "Viewed Jobs
// for 2m 14s" once they leave and the duration is known, the action label
// otherwise. Per direction 2026-08-27 -- duration shown directly in the feed,
// not just the byScreen averages.
const feedLabel = (e) => {
  if (e.event === 'screen_view') return `Viewed ${e.screen || 'a screen'}`;
  if (e.event === 'screen_view_end') {
    const dur = fmtDuration(feedDurationMs(e.props));
    return dur ? `Viewed ${e.screen || 'a screen'} for ${dur}` : `Left ${e.screen || 'a screen'}`;
  }
  return eventLabel(e.event);
};
// A horizontal bar list ([{label,c}]) scaled to the max - reused across panels.
function UsageBars({ rows, labelKey = 'd', slice5 = true }) {
  const max = Math.max(1, ...rows.map((r) => r.c));
  if (rows.length === 0) return <p className="tech-links-hint">No activity in this range.</p>;
  return (
    <div className="usage-bars">
      {rows.map((r, i) => (
        <div className="usage-bar-row" key={i}>
          <span className="usage-bar-lbl">{slice5 && labelKey === 'd' ? String(r[labelKey]).slice(5) : r[labelKey]}</span>
          <span className="usage-bar-track"><span className="usage-bar-fill" style={{ width: `${(r.c / max) * 100}%` }} /></span>
          <span className="usage-bar-val">{r.c}</span>
        </div>
      ))}
    </div>
  );
}

// Admin billing reconciliation: QBO vs SF billed/received totals + a per-invoice
// cross-reference (which invoice #s are in one system but not the other), with a
// date range, group-by (SF/QBO account & parent), and payment-method filter.
const RECON_GROUPS = [['', 'No grouping'], ['sfAccount', 'SF account'], ['sfParent', 'SF parent'], ['qboAccount', 'QBO account'], ['qboParent', 'QBO parent']];
const RECON_METHODS = ['', 'Check', 'ACH', 'Credit Card', 'Cash', 'Other'];
const RECON_METHOD_OPTS = RECON_METHODS.map((m) => [m, m || 'All methods']);
const money = (n) => `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function ReconList({ title, rows, groupBy }) {
  const groups = useMemo(() => {
    if (!groupBy) return null;
    const m = new Map();
    for (const r of rows) { const g = r[groupBy] || '(none)'; if (!m.has(g)) m.set(g, { rows: [], total: 0 }); const e = m.get(g); e.rows.push(r); e.total += Number(r.amount) || 0; }
    return [...m.entries()].sort((a, b) => b[1].total - a[1].total);
  }, [rows, groupBy]);
  const total = useMemo(() => rows.reduce((s, r) => s + (Number(r.amount) || 0), 0), [rows]);
  return (
    <div className="recon-list">
      <div className="recon-list-head"><h4>{title}</h4><span className="recon-count">{rows.length} · {money(total)}</span></div>
      {rows.length === 0 && <div className="recon-empty">None</div>}
      {!groupBy && rows.length > 0 && (
        <table className="recon-table recon-screen"><tbody>
          {rows.map((r, i) => (
            <tr key={i}><td className="recon-num">{r.number}{r.dup && <span className="recon-dup" title="Duplicate invoice # - paired by amount"> dup</span>}</td><td data-label="Date">{r.date}</td><td className="recon-amt" data-label="Amount">{money(r.amount)}</td><td className="recon-cust" data-label="Customer">{r.customer || '-'}</td><td className="recon-pm" data-label="Payment Method">{r.paymentMethod || ''}</td></tr>
          ))}
        </tbody></table>
      )}
      {groupBy && groups && groups.map(([g, e]) => (
        <details key={g} className="recon-group"><summary>{g} <span className="recon-count">{e.rows.length} · {money(e.total)}</span></summary>
          <table className="recon-table recon-screen"><tbody>
            {e.rows.map((r, i) => (
              <tr key={i}><td className="recon-num">{r.number}{r.dup && <span className="recon-dup" title="Duplicate invoice # - paired by amount"> dup</span>}</td><td data-label="Date">{r.date}</td><td className="recon-amt" data-label="Amount">{money(r.amount)}</td><td className="recon-cust" data-label="Customer">{r.customer || '-'}</td><td className="recon-pm" data-label="Payment Method">{r.paymentMethod || ''}</td></tr>
            ))}
          </tbody></table>
        </details>
      ))}
    </div>
  );
}

// The "matched invoices" analytics window: invoices present in BOTH systems,
// grouped by an account dimension, comparing SF vs QBO billed totals per group.
function ReconMatched({ rows, groupBy }) {
  const N = (v) => Number(v) || 0;
  // Grouped by an account dimension...
  const groups = useMemo(() => {
    if (!groupBy) return [];
    const m = new Map();
    for (const r of rows) {
      const k = r[groupBy] || '(none)';
      if (!m.has(k)) m.set(k, { rows: [], sf: 0, qbo: 0, sfR: 0, qboR: 0, linked: 0 });
      const e = m.get(k); e.rows.push(r); e.sf += N(r.sfAmount); e.qbo += N(r.qboAmount); e.sfR += N(r.sfReceived); e.qboR += N(r.qboReceived); if (r.linked) e.linked++;
    }
    return [...m.entries()].sort((a, b) => b[1].sf - a[1].sf);
  }, [rows, groupBy]);
  // ...or ungrouped (No grouping): one row per invoice, biggest SF↔QBO gaps first.
  const flat = useMemo(() => {
    if (groupBy) return [];
    const gap = (r) => Math.abs(N(r.qboAmount) - N(r.sfAmount)) + Math.abs(N(r.qboReceived) - N(r.sfReceived));
    return [...rows].sort((a, b) => gap(b) - gap(a) || N(b.sfAmount) - N(a.sfAmount));
  }, [rows, groupBy]);
  const tot = useMemo(() => rows.reduce((a, r) => ({ sf: a.sf + N(r.sfAmount), qbo: a.qbo + N(r.qboAmount), sfR: a.sfR + N(r.sfReceived), qboR: a.qboR + N(r.qboReceived) }), { sf: 0, qbo: 0, sfR: 0, qboR: 0 }), [rows]);
  const label = (RECON_GROUPS.find((g) => g[0] === groupBy) || [, 'Group'])[1];
  const gapCls = (d) => `recon-amt ${Math.abs(d) > 0.5 ? 'recon-gap' : ''}`;
  if (rows.length === 0) return <div className="recon-list"><div className="recon-empty">No matched invoices in range</div></div>;
  return (
    <div className="recon-list recon-scroll">
      <table className="recon-matched recon-screen">
        {groupBy ? (
          <>
            <thead>
              <tr><th></th><th></th><th colSpan={3} className="recon-grp">Billed</th><th colSpan={3} className="recon-grp">Received</th></tr>
              <tr><th>{label}</th><th>#</th><th>SF</th><th>QBO</th><th>Δ</th><th>SF</th><th>QBO</th><th>Δ</th></tr>
            </thead>
            <tbody>
              {groups.map(([k, e]) => (
                <tr key={k}>
                  <td className="recon-cust">{k}</td><td data-label="Invoices">{e.rows.length} <span className="recon-linked-count" title={`${e.linked} of ${e.rows.length} durably linked (QBO_Id__c set)`}>({e.linked}✓)</span></td>
                  <td className="recon-amt" data-label="Billed SF">{money(e.sf)}</td><td className="recon-amt" data-label="Billed QBO">{money(e.qbo)}</td><td className={gapCls(e.qbo - e.sf)} data-label="Billed Δ">{money(e.qbo - e.sf)}</td>
                  <td className="recon-amt" data-label="Received SF">{money(e.sfR)}</td><td className="recon-amt" data-label="Received QBO">{money(e.qboR)}</td><td className={gapCls(e.qboR - e.sfR)} data-label="Received Δ">{money(e.qboR - e.sfR)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="recon-foot-grp"><th></th><th></th><th colSpan={3} className="recon-grp">Billed</th><th colSpan={3} className="recon-grp">Received</th></tr>
              <tr className="recon-foot-lbl"><th>{label}</th><th>#</th><th>SF</th><th>QBO</th><th>Δ</th><th>SF</th><th>QBO</th><th>Δ</th></tr>
              <tr className="recon-total"><td>Total</td><td data-label="Invoices">{rows.length}</td>
                <td className="recon-amt" data-label="Billed SF">{money(tot.sf)}</td><td className="recon-amt" data-label="Billed QBO">{money(tot.qbo)}</td><td className="recon-amt" data-label="Billed Δ">{money(tot.qbo - tot.sf)}</td>
                <td className="recon-amt" data-label="Received SF">{money(tot.sfR)}</td><td className="recon-amt" data-label="Received QBO">{money(tot.qboR)}</td><td className="recon-amt" data-label="Received Δ">{money(tot.qboR - tot.sfR)}</td>
              </tr>
            </tfoot>
          </>
        ) : (
          <>
            <thead>
              <tr><th></th><th></th><th></th><th colSpan={3} className="recon-grp">Billed</th><th colSpan={3} className="recon-grp">Received</th></tr>
              <tr><th>Invoice</th><th>Customer</th><th className="recon-date-col">Date</th><th>SF</th><th>QBO</th><th>Δ</th><th>SF</th><th>QBO</th><th>Δ</th></tr>
            </thead>
            <tbody>
              {flat.map((r, i) => (
                <tr key={r.number + '-' + i}>
                  <td className="recon-num">
                    {r.linked
                      ? <span className="recon-linked" title="QBO_Id__c is set to this exact QBO invoice — durably linked, not just matched by this page's own amount/date heuristic">✓ </span>
                      : <span className="recon-unlinked" title="Matched here by amount/date, but QBO_Id__c isn't set to this invoice yet — re-computed live every load">○ </span>}
                    {r.number}{r.dup && <span className="recon-dup" title="Duplicate invoice # - paired by amount"> dup</span>}
                  </td><td className="recon-cust" data-label="Customer">{r.sfAccount || r.qboAccount || '-'}</td><td className="recon-date-cell" data-label="Date">{r.qboDate || r.sfDate || ''}</td>
                  <td className="recon-amt" data-label="Billed SF">{money(r.sfAmount)}</td><td className="recon-amt" data-label="Billed QBO">{money(r.qboAmount)}</td><td className={gapCls(N(r.qboAmount) - N(r.sfAmount))} data-label="Billed Δ">{money(N(r.qboAmount) - N(r.sfAmount))}</td>
                  <td className="recon-amt" data-label="Received SF">{money(r.sfReceived)}</td><td className="recon-amt" data-label="Received QBO">{money(r.qboReceived)}</td><td className={gapCls(N(r.qboReceived) - N(r.sfReceived))} data-label="Received Δ">{money(N(r.qboReceived) - N(r.sfReceived))}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="recon-foot-grp"><th></th><th></th><th></th><th colSpan={3} className="recon-grp">Billed</th><th colSpan={3} className="recon-grp">Received</th></tr>
              <tr className="recon-foot-lbl"><th>Invoice</th><th>Customer</th><th className="recon-date-col">Date</th><th>SF</th><th>QBO</th><th>Δ</th><th>SF</th><th>QBO</th><th>Δ</th></tr>
              <tr className="recon-total"><td>Total ({rows.length})</td><td data-label="Customer"></td><td data-label="Date"></td>
                <td className="recon-amt" data-label="Billed SF">{money(tot.sf)}</td><td className="recon-amt" data-label="Billed QBO">{money(tot.qbo)}</td><td className="recon-amt" data-label="Billed Δ">{money(tot.qbo - tot.sf)}</td>
                <td className="recon-amt" data-label="Received SF">{money(tot.sfR)}</td><td className="recon-amt" data-label="Received QBO">{money(tot.qboR)}</td><td className="recon-amt" data-label="Received Δ">{money(tot.qboR - tot.sfR)}</td>
              </tr>
            </tfoot>
          </>
        )}
      </table>
    </div>
  );
}

function BillingReconciliation() {
  const today = new Date().toISOString().slice(0, 10);
  const ago = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(ago(90));
  const [to, setTo] = useState(today);
  const [groupBy, setGroupBy] = useState('');
  const [matchGroup, setMatchGroup] = useState('sfParent');
  const [method, setMethod] = useState('');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const forceRef = useRef(false);
  const [open, setOpen] = useState({ totals: true, matched: true, discrep: true });
  const [matchQuery, setMatchQuery] = useState('');
  const [discrepQuery, setDiscrepQuery] = useState('');
  const toggle = (k) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const caret = (k) => <span className="recon-caret">{open[k] ? '▾' : '▸'}</span>;

  useEffect(() => {
    setLoading(true); setErr(null);
    const force = forceRef.current; forceRef.current = false; // force cache bypass only on a Refresh click
    api.getBillingReconciliation({ from, to, paymentMethod: method, refresh: force ? 1 : undefined })
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => { setErr(e.message); setLoading(false); });
  }, [from, to, method, nonce]);

  const totals = data && [
    ['Salesforce', data.sf.billed, data.sf.received],
    ['QuickBooks', data.qbo.billed, data.qbo.received],
    ['Δ (QBO − SF)', data.deltas.billed, data.deltas.received],
  ];
  // Guard every list - a stale/old-shaped API response must never blank the page.
  const diff = data?.diff || {};
  const matchedRows = diff.matched || [];
  const qboOnly = diff.qboOnly || [];
  const sfOnly = diff.sfOnly || [];
  // Per-section filter by invoice number (substring match).
  const hasQ = (q, r) => !q.trim() || String(r.number).toLowerCase().includes(q.trim().toLowerCase());
  const matchedShown = matchedRows.filter((r) => hasQ(matchQuery, r));
  const qboOnlyShown = qboOnly.filter((r) => hasQ(discrepQuery, r));
  const sfOnlyShown = sfOnly.filter((r) => hasQ(discrepQuery, r));

  return (
    <section className="usage recon">
      <div className="view-head usage-head">
        <div><h2>Billing reconciliation</h2><p className="recon-sub">QuickBooks vs Salesforce · QBO billed counts sent invoices only</p></div>
        <div className="usage-controls recon-controls">
          <div className="recon-date">From <DatePicker value={from} onChange={setFrom} placeholder="From" clearable={false} /></div>
          <div className="recon-date">To <DatePicker value={to} onChange={setTo} placeholder="To" clearable={false} /></div>
          <div className="usage-range">{[30, 90, 365].map((d) => (
            <button key={d} className="chip" onClick={() => { setFrom(ago(d)); setTo(today); }}>{d}d</button>
          ))}</div>
          <FilterSelect value={method} onChange={setMethod} options={RECON_METHOD_OPTS} placeholder="All methods" ariaLabel="Payment method" />
          <button className="refresh" onClick={() => { forceRef.current = true; setNonce((n) => n + 1); }}>Refresh</button>
        </div>
      </div>

      {err && <div className="empty">Couldn’t load reconciliation: {err}</div>}
      {!err && !data && <LoadingDots label="Loading…" />}
      {data && (
        <>
          <div className="recon-xref-head">
            <h3 className="recon-toggle" onClick={() => toggle('totals')}>{caret('totals')} Totals</h3>
          </div>
          {/* Cascade/LazyCascade (App.jsx) -- per direction 2026-08-30, same
              "flowy, not clunky" treatment as every other expand/collapse in
              the app. Totals is always small (3 rows), plain Cascade;
              Matched/Discrepancies use LazyCascade since their tables could
              genuinely be large depending on the date range -- no reason to
              mount them before they're ever opened. */}
          <Cascade open={open.totals}>
            <table className="recon-totals recon-screen">
              <thead><tr><th></th><th>Billed</th><th>Received</th></tr></thead>
              <tbody>
                {totals.map(([label, b, r], i) => (
                  <tr key={label} className={i === 2 ? 'recon-delta' : ''}>
                    <td>{label}</td><td data-label="Billed">{money(b)}</td><td data-label="Received">{money(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Cascade>
          {loading && <LoadingDots label="Updating…" inline />}

          <div className="recon-xref-head">
            <h3 className="recon-toggle" onClick={() => toggle('matched')}>{caret('matched')} Matched invoices <span className="recon-count">{matchedShown.length}{matchQuery.trim() ? ` of ${matchedRows.length}` : ''} · SF vs QBO{matchGroup ? ' by account' : ' per invoice'}</span></h3>
            <Cascade open={open.matched}>
              <div className="recon-head-ctrls">
                <input className="recon-filter" placeholder="Filter #" value={matchQuery} onChange={(e) => setMatchQuery(e.target.value)} />
                <div className="usage-range">{RECON_GROUPS.map(([v, l]) => (
                  <button key={v} className={`chip ${matchGroup === v ? 'on' : ''}`} onClick={() => setMatchGroup(v)}>{l}</button>
                ))}</div>
              </div>
            </Cascade>
          </div>
          <LazyCascade open={open.matched}>
            <ReconMatched rows={matchedShown} groupBy={matchGroup} />
          </LazyCascade>

          <div className="recon-xref-head">
            <h3 className="recon-toggle" onClick={() => toggle('discrep')}>{caret('discrep')} Discrepancies <span className="recon-count">{qboOnlyShown.length + sfOnlyShown.length}{discrepQuery.trim() ? ` of ${qboOnly.length + sfOnly.length}` : ''}</span></h3>
            <Cascade open={open.discrep}>
              <div className="recon-head-ctrls">
                <input className="recon-filter" placeholder="Filter #" value={discrepQuery} onChange={(e) => setDiscrepQuery(e.target.value)} />
                <div className="usage-range">{RECON_GROUPS.map(([v, l]) => (
                  <button key={v} className={`chip ${groupBy === v ? 'on' : ''}`} onClick={() => setGroupBy(v)}>{l}</button>
                ))}</div>
              </div>
            </Cascade>
          </div>
          <LazyCascade open={open.discrep}>
            <div className="recon-cols">
              <ReconList title="In QBO (sent), not in SF" rows={qboOnlyShown} groupBy={groupBy} />
              <ReconList title="In SF, not in QBO" rows={sfOnlyShown} groupBy={groupBy} />
            </div>
          </LazyCascade>
        </>
      )}
    </section>
  );
}

// ===================== Expense Tracking (Job/Project Cost Tracking) =====================

// Plain SVG donut, no charting dependency needed for a 2-segment chart --
// red = materials spent (from the real "CRS Purchase Order" object), green =
// remaining budget, proportional to Opportunity.Amount. When there's no
// budget and no spend recorded, renders a flat gray ring rather than
// guessing a proportion. `size` covers both the list view's compact use and
// the detail view's larger one.
function JobDonut({ budget, materialsSpent, size = 64 }) {
  const strokeWidth = size * 0.16;
  const radius = size / 2 - strokeWidth / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;
  const hasAny = budget > 0 || materialsSpent > 0;
  const spentFraction = budget > 0 ? Math.min(1, materialsSpent / budget) : (materialsSpent > 0 ? 1 : 0);
  const redLength = circumference * spentFraction;
  const greenLength = circumference - redLength;

  if (!hasAny) {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="job-donut">
        <circle cx={center} cy={center} r={radius} fill="none" stroke="var(--line-strong)" strokeWidth={strokeWidth} />
      </svg>
    );
  }

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="job-donut">
      <circle cx={center} cy={center} r={radius} fill="none" stroke="var(--surface-2)" strokeWidth={strokeWidth} />
      {redLength > 0 && (
        <circle
          cx={center} cy={center} r={radius} fill="none" stroke="#D64545" strokeWidth={strokeWidth}
          strokeDasharray={`${redLength} ${circumference}`}
          transform={`rotate(-90 ${center} ${center})`}
        />
      )}
      {greenLength > 0 && (
        <circle
          cx={center} cy={center} r={radius} fill="none" stroke="#2E9E5B" strokeWidth={strokeWidth}
          strokeDasharray={`${greenLength} ${circumference}`}
          strokeDashoffset={-redLength}
          transform={`rotate(-90 ${center} ${center})`}
        />
      )}
    </svg>
  );
}

// Single proportional arc segment, shared by every ring below -- `startFrac`/
// `frac` are both 0-1 shares of the full circle.
// Semi-transparent by default, per direction -- full opacity while its own
// segment is hovered (or while no segment is hovered at all, so the ring
// isn't dim before any interaction). `segmentKey` identifies which segment
// this is for the hover-popover logic in JobDonutRings below; the visible
// stroke itself is the hit area (`pointerEvents: 'stroke'`), no separate
// invisible hit-path needed at this stroke width.
function DonutArc({ cx, cy, r, strokeWidth, color, circumference, startFrac, frac, segmentKey, hovered, onHover, onSelect }) {
  if (frac <= 0) return null;
  const length = circumference * frac;
  const offset = -circumference * startFrac;
  const dim = hovered && hovered !== segmentKey;
  return (
    <circle
      cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={strokeWidth}
      strokeDasharray={`${length} ${circumference}`}
      strokeDashoffset={offset}
      transform={`rotate(-90 ${cx} ${cy})`}
      style={{ opacity: dim ? 0.35 : 0.75, cursor: 'pointer', pointerEvents: 'stroke', transition: 'opacity .12s' }}
      onMouseEnter={() => onHover(segmentKey)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onSelect && onSelect(segmentKey)}
    />
  );
}

// A point on the ring at fraction `t` around the circle, starting at 12
// o'clock and going clockwise -- matches DonutArc's own -90deg rotation
// convention, used to anchor the hover popover's leader line to the real
// midpoint of whichever segment is active.
function pointOnRing(cx, cy, r, t) {
  const angle = (t * 360 - 90) * (Math.PI / 180);
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

const SEGMENT_INFO = {
  quotedLabor: { label: 'Quoted Labor', color: '#3B7DD8' },
  quotedParts: { label: 'Quoted Parts', color: '#8B5FBF' },
  materialExpenses: { label: 'Material Expenses', color: '#D64545' },
  billedLabor: { label: 'Billed Labor', color: '#D98A2B' },
  billedMaterials: { label: 'Billed Materials', color: '#2A9D8F' },
  quotedTotal: { label: 'Quoted Total', color: '#3B7DD8' },
  billedTotal: { label: 'Billed', color: '#2E9E5B' },
  technicianHours: { label: 'Technician Hours', color: '#5B6ABF' },
  helperHours: { label: 'Helper Hours', color: '#E0A72E' },
  billedOther: { label: 'Other Charges (truck, misc, shipping)', color: '#7A8699' },
};

// Hover popover content per segment -- quoted rings show the real Quote
// line-item breakdown, Material Expenses shows the real CRS Purchase Order
// records, Billed Labor shows the real invoice lines that make it up.
// Capped by default (the hover popover is a quick glance, still space-
// constrained by whatever room is available near the trigger) -- pass
// `cap={Infinity}` for the click-to-open SegmentDetailModal below, which has
// a real scrollable body and isn't fighting for space against the page
// layout the way the hover popover is.
const POPOVER_MAX_LINES = 8;

// Hover-intent timing, shared by BulletBar and JobDonutRings -- per
// direction 2026-08-27: don't pop the popover open the instant the cursor
// touches the graph (a fast mouse pass-through was popping/closing boxes
// constantly), and give a longer grace window on the way out so there's
// real time to move from the (thin) trigger to the portaled popover.
const POPOVER_OPEN_DELAY = 400;
const POPOVER_CLOSE_DELAY = 500;

// Real hardware hover support (a mouse), not just "an onMouseEnter handler
// happened to fire" -- found live 2026-08-30, the actual cause of "hover
// popups open on click and stay open for a bit" on mobile: iOS/Android
// browsers simulate a single mouseenter/mouseleave pair on tap for any
// element carrying hover handlers, so BulletBar/JobDonutRings' own
// onMouseEnter (which schedules the popover open after POPOVER_OPEN_DELAY)
// fired right alongside their onClick (which opens SegmentDetailModal
// immediately) -- both were reacting to the same tap. matchMedia
// '(hover: hover)' is the standard way to ask "can this input device
// genuinely hover," rather than trying to distinguish real vs.
// touch-simulated mouse events after the fact. Read once at mount (a
// device's hover capability doesn't change mid-session) and used to gate
// the hover-popover open/close handlers entirely in both components below
// -- on a non-hover-capable device they become no-ops, leaving onClick's
// modal as the only thing that happens on tap, which is what was already
// built and already clean.
function useHoverCapable() {
  const [capable] = useState(() => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(hover: hover)').matches);
  return capable;
}

// unit: '$' (default, via fmtCurrency) or 'h' (hours -- BulletBar's Hours
// rows use this, since fmtCurrency would wrongly format an hours figure as
// a dollar amount). `full`: the modal's real estate, not the tight 260px
// hover popover -- drops the fixed equal-width columns so long names get
// real room instead of getting condensed/wrapped into an unreadable column.
function SegmentPopoverContent({ segmentKey, total, lines, unit = '$', cap = POPOVER_MAX_LINES, full = false }) {
  const info = SEGMENT_INFO[segmentKey];
  const shown = (lines || []).slice(0, cap);
  const hiddenCount = (lines?.length || 0) - shown.length;
  const totalText = unit === 'h' ? (total != null ? `${total}h` : '-') : (fmtCurrency(total) ?? '-');
  return (
    <div className="donut-popover-body">
      <div className="donut-popover-title"><span className="exp-dot" style={{ background: info.color }} />{info.label}</div>
      <div className="donut-popover-total">{totalText}</div>
      {(!lines || lines.length === 0) && <div className="donut-popover-hint">No itemized detail available.</div>}
      {shown.length > 0 && (
        <table className={`donut-popover-lines${full ? ' full' : ''}`}>
          <tbody>
            {shown.map((l, i) => <tr key={i}>{l}</tr>)}
          </tbody>
        </table>
      )}
      {hiddenCount > 0 && <div className="donut-popover-hint">+{hiddenCount} more not shown here</div>}
      {!full && <div className="donut-popover-cta">Click for full detail</div>}
    </div>
  );
}

// Click-to-open detail -- per direction 2026-08-27, the hover popover alone
// (portaled, viewport-clamped, but still passive and space-constrained)
// wasn't a reliable way to read a long real itemized list; a real modal has
// no viewport-edge math to get wrong and is properly scrollable, so it's the
// dependable path to "all the information," while hover stays as a fast
// glance. Shows every real line (cap={Infinity}), not just the popover's
// capped preview.
function SegmentDetailModal({ segmentKey, total, lines, unit = '$', onClose }) {
  const info = SEGMENT_INFO[segmentKey];
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-segment-detail" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title-row"><span className="exp-dot" style={{ background: info.color }} /><span className="jname">{info.label}</span></div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          <SegmentPopoverContent segmentKey={segmentKey} total={total} lines={lines} unit={unit} cap={Infinity} full />
        </div>
      </div>
    </div>
  );
}

// Bullet-chart-style bar: fills to `actual`, with a tick mark at `target` on
// the same scale -- per direction 2026-08-27, replacing the old
// Expenses/Billed/Hours ring segments. Bars read actual-vs-target far more
// precisely than ring angle/area (Cleveland & McGill graphical-perception
// research), and unlike the rings, an over-target bar is allowed to
// genuinely extend past its tick rather than being clamped -- overshooting
// a quote is real, useful information, not an overflow bug to hide.
// Hover behavior mirrors the ring's popover (same SegmentPopoverContent),
// but anchored with plain CSS above/below the bar instead of polar-
// coordinate leader-line math, since a bar has no angle to compute.
// targetLabel: the word describing what `target` represents in the value
// line ("$X of $Y ___") -- defaults to 'quoted' (Job Analytics' only real
// use so far), but Service Analytics targets aren't quotes at all (real
// cost/expense/awarded figures instead), so hardcoding "quoted" there would
// just be wrong, not merely imprecise.
function BulletBar({ segmentKey, actual, target, unit = '$', lines, targetLabel = 'quoted' }) {
  const hoverCapable = useHoverCapable();
  const [hovered, setHovered] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const wrapRef = useRef(null);
  const popRef = useRef(null);
  const closeTimerRef = useRef(null);
  const openTimerRef = useRef(null);
  const [pos, setPos] = useState(null);
  const info = SEGMENT_INFO[segmentKey];
  const hasData = actual != null && target != null;
  const scale = hasData ? Math.max(actual, target, 1) : 1;
  const actualFrac = hasData ? Math.min(1, actual / scale) : 0;
  const targetFrac = hasData ? Math.min(1, target / scale) : 0;
  const fmt = (n) => (unit === 'h' ? (n != null ? `${n}h` : '-') : (fmtCurrency(n) ?? '-'));

  // Portaled + viewport-clamped, same pattern JobNotesBadge uses -- a bar
  // can sit anywhere in a long stacked panel, so a plain top:100% popover
  // runs off the bottom of the screen for any bar low on the page. The
  // arrow tracks the bar's real horizontal center so the popover still
  // visibly points at what it's describing even after its box gets
  // shifted/clamped to stay on-screen.
  const cancelClose = () => { if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; } };
  const cancelOpen = () => { if (openTimerRef.current) { clearTimeout(openTimerRef.current); openTimerRef.current = null; } };
  const openNow = () => {
    if (!wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const POP_WIDTH = 300;
    const GAP = 10;
    const EDGE = 8;
    const CEILING = 420;
    let left = rect.left;
    if (left + POP_WIDTH > window.innerWidth - EDGE) left = window.innerWidth - POP_WIDTH - EDGE;
    if (left < EDGE) left = EDGE;
    const arrowLeft = Math.max(14, Math.min(POP_WIDTH - 14, rect.left + rect.width / 2 - left));
    const spaceBelow = window.innerHeight - rect.bottom - GAP - EDGE;
    const spaceAbove = rect.top - GAP - EDGE;
    if (spaceBelow >= spaceAbove) {
      setPos({ top: rect.bottom + GAP, bottom: null, left, arrowLeft, above: false, maxHeight: Math.max(0, Math.min(CEILING, spaceBelow)) });
    } else {
      setPos({ top: null, bottom: window.innerHeight - rect.top + GAP, left, arrowLeft, above: true, maxHeight: Math.max(0, Math.min(CEILING, spaceAbove)) });
    }
    setHovered(true);
  };
  // Hover-intent: don't pop open on the instant the cursor touches the bar,
  // only after it's genuinely lingered -- a quick mouse pass-through no
  // longer flashes a popover open and shut.
  const handleEnter = () => {
    if (!hoverCapable) return;
    cancelClose();
    if (hovered) return;
    cancelOpen();
    openTimerRef.current = setTimeout(() => { openTimerRef.current = null; openNow(); }, POPOVER_OPEN_DELAY);
  };
  // Delayed close so moving the mouse from the (thin) bar toward the
  // popover -- which is portaled away and not directly under the cursor --
  // has time to land inside the popover itself before it closes. Without
  // this, the popover vanished the instant the cursor left the bar, before
  // it could ever be read or scrolled.
  const handleLeave = () => {
    if (!hoverCapable) return;
    cancelOpen();
    cancelClose();
    closeTimerRef.current = setTimeout(() => setHovered(false), POPOVER_CLOSE_DELAY);
  };
  useEffect(() => () => { cancelClose(); cancelOpen(); }, []);
  // Close on scroll/resize -- the popover is portaled and positioned in
  // fixed viewport coordinates computed once at open time, so scrolling the
  // page (or the panel) leaves it pointing at stale coordinates, visibly
  // detached from the bar that opened it. But the popover's own body is
  // independently scrollable (long itemized lists) -- scroll is captured on
  // window specifically to catch page/panel scrolling anywhere, so it has
  // to explicitly ignore scroll events that originate from inside the
  // popover itself, or scrolling to read the list would close it.
  useEffect(() => {
    if (!hovered) return;
    const close = (e) => { if (popRef.current?.contains(e.target)) return; setHovered(false); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [hovered]);

  return (
    <div className="exp-bullet-row">
      <div className="exp-bullet-label"><span className="exp-dot" style={{ background: info.color }} />{info.label}</div>
      {!hasData ? (
        <div className="exp-bullet-nodata">No data</div>
      ) : (
        <div
          className="exp-bullet-track-wrap"
          ref={wrapRef}
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
          onClick={() => setModalOpen(true)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && setModalOpen(true)}
          title="Click for full detail"
        >
          <div className="exp-bullet-track">
            <div className="exp-bullet-fill" style={{ width: `${actualFrac * 100}%`, background: info.color }} />
            <div className="exp-bullet-tick" style={{ left: `${targetFrac * 100}%` }} />
          </div>
          <div className="exp-bullet-value">{fmt(actual)} of {fmt(target)} {targetLabel}</div>
          {hovered && pos && createPortal(
            <div
              ref={popRef}
              className={`donut-popover exp-bullet-popover ${pos.above ? 'above' : 'below'}`}
              style={{ left: pos.left, maxHeight: pos.maxHeight, ...(pos.bottom != null ? { bottom: pos.bottom } : { top: pos.top }) }}
              onMouseEnter={cancelClose}
              onMouseLeave={handleLeave}
            >
              <div className="exp-bullet-popover-arrow" style={{ left: pos.arrowLeft }} />
              <SegmentPopoverContent segmentKey={segmentKey} total={actual} lines={lines} unit={unit} />
            </div>,
            document.body
          )}
        </div>
      )}
      {modalOpen && (
        <SegmentDetailModal segmentKey={segmentKey} total={actual} lines={lines} unit={unit} onClose={() => setModalOpen(false)} />
      )}
    </div>
  );
}

// A single ring for the Expense Tracking detail view -- Quoted Labor +
// Quoted Parts as a composition of Quoted Total. Simplified 2026-08-27 from
// the earlier 3-ring design (Quoted/Expenses/Billed all as concentric
// rings): asked directly whether rings were the right tool, and per
// direction, only this one is -- it's a genuine part-to-whole composition
// question ("how is the quote split"), which is what rings are actually
// good at. Expenses/Billed/Hours are "actual vs. target" comparisons, which
// read far more precisely as bars (BulletBar below) than as ring segments --
// kept those as rings even when the underlying job had a real, large number
// to show would have meant asking a reader to compare arc angles across
// separate rings, which is measurably harder than reading bar lengths on a
// shared axis. Hovering either segment pops a leader-lined popover with the
// real itemized Quote lines, same interaction as before.
function JobDonutRings({
  quotedLabor, quotedParts,
  quotedLaborLines = [], quotedPartsLines = [],
  size = 200,
}) {
  const hoverCapable = useHoverCapable();
  const [hovered, setHovered] = useState(null);
  const [modalKey, setModalKey] = useState(null);
  const wrapRef = useRef(null);
  const popRef = useRef(null);
  const closeTimerRef = useRef(null);
  const openTimerRef = useRef(null);
  const [popPos, setPopPos] = useState(null);
  const center = size / 2;
  const strokeWidth = size * 0.16;
  const rOuter = center - strokeWidth / 2;
  const cOuter = 2 * Math.PI * rOuter;

  const hasQuote = quotedLabor != null && quotedParts != null;
  const quotedTotalForScale = (quotedLabor || 0) + (quotedParts || 0);
  const noQuotedTotal = !(quotedTotalForScale > 0);
  const scale = noQuotedTotal ? 1 : quotedTotalForScale;
  const frac = (n) => Math.min(1, (n || 0) / scale);
  const quotedLaborFrac = frac(quotedLabor);
  const quotedPartsFrac = frac(quotedParts);

  const midFracByKey = { quotedLabor: quotedLaborFrac / 2, quotedParts: quotedLaborFrac + quotedPartsFrac / 2 };
  const totalByKey = { quotedLabor, quotedParts };
  const linesByKey = {
    quotedLabor: quotedLaborLines.map((l) => (<><td>{l.name}</td><td>{l.qty}</td><td>{fmtCurrency(l.rate)}</td><td>{fmtCurrency(l.amount)}</td></>)),
    quotedParts: quotedPartsLines.map((l) => (<><td>{l.name}</td><td>{l.qty}</td><td>{fmtCurrency(l.rate)}</td><td>{fmtCurrency(l.amount)}</td></>)),
  };

  // Popover pops out to the side of the hovered segment, connected by ONE
  // line -- per direction 2026-08-27, drop the earlier two-piece version
  // (a short stub inside the ring's own local <svg> + a separately portaled
  // connector meeting it partway). Splitting one line across two
  // independently-rendered SVGs in two different coordinate systems is
  // exactly what kept causing seams/breaks between them, however precisely
  // the two endpoints were computed. Now there's a single portaled,
  // viewport-coordinate line drawn once: from the ring's real edge point to
  // the popover's real measured rect (see the connector effect below).
  let t = null, ringPt = null, onRight = false;
  if (hovered) {
    t = midFracByKey[hovered];
    ringPt = pointOnRing(center, center, rOuter + strokeWidth / 2, t);
    onRight = ringPt.x >= center;
  }

  useEffect(() => {
    if (!hovered || !ringPt || !wrapRef.current) { setPopPos(null); return; }
    const wrapRect = wrapRef.current.getBoundingClientRect();
    const screenX = wrapRect.left + ringPt.x;
    const screenY = wrapRect.top + ringPt.y;
    const POP_WIDTH = 300;
    const GAP = 14;
    const EDGE = 8;
    const CEILING = 420;
    let left = onRight ? screenX + GAP : screenX - GAP - POP_WIDTH;
    if (left + POP_WIDTH > window.innerWidth - EDGE) left = window.innerWidth - POP_WIDTH - EDGE;
    if (left < EDGE) left = EDGE;
    const spaceBelow = window.innerHeight - screenY - EDGE;
    const spaceAbove = screenY - EDGE;
    if (spaceBelow >= spaceAbove) {
      const top = Math.max(EDGE, screenY - 20);
      setPopPos({ left, top, bottom: null, onRight, screenX, screenY, maxHeight: Math.max(0, Math.min(CEILING, spaceBelow + 20)) });
    } else {
      const bottom = Math.max(EDGE, window.innerHeight - screenY - 20);
      setPopPos({ left, top: null, bottom, onRight, screenX, screenY, maxHeight: Math.max(0, Math.min(CEILING, spaceAbove + 20)) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovered]);

  // The real connector: runs after the popover box above has actually
  // mounted/laid out, measures its true rect, and draws a line from the
  // ring's edge to the nearest point on that *measured* rect -- not a
  // predicted one. This is what guarantees the line always visibly touches
  // the box, however it ended up being positioned/clamped.
  const [connector, setConnector] = useState(null);
  useLayoutEffect(() => {
    if (!hovered || !popPos || !popRef.current) { setConnector(null); return; }
    const r = popRef.current.getBoundingClientRect();
    const x2 = popPos.onRight ? r.left : r.right;
    const y2 = Math.max(r.top + 10, Math.min(r.bottom - 10, popPos.screenY));
    setConnector({ x1: popPos.screenX, y1: popPos.screenY, x2, y2 });
  }, [hovered, popPos]);

  // Close on scroll/resize -- same reasoning as BulletBar: a portaled
  // popover positioned in fixed coordinates computed once at open time goes
  // stale (visibly detached from the ring) the moment the page scrolls
  // under it, but scrolling the popover's own body (long itemized lists)
  // must not count -- ignore scroll events that originate inside it.
  useEffect(() => {
    if (!hovered) return;
    const close = (e) => { if (popRef.current?.contains(e.target)) return; setHovered(null); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [hovered]);

  // Hover-intent open + delayed close, same reasoning as BulletBar --
  // DonutArc's own onMouseLeave used to clear `hovered` immediately, so
  // moving the cursor off the thin ring stroke toward the (portaled,
  // not-directly-underneath) popover closed it before it could ever be
  // read, and a fast mouse pass-through popped it open and shut instantly.
  // The popover itself also participates in the same close bridge via its
  // own mouse handlers below.
  const cancelClose = () => { if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; } };
  const cancelOpen = () => { if (openTimerRef.current) { clearTimeout(openTimerRef.current); openTimerRef.current = null; } };
  const scheduleClose = () => { cancelOpen(); cancelClose(); closeTimerRef.current = setTimeout(() => setHovered(null), POPOVER_CLOSE_DELAY); };
  const handleHover = (key) => {
    if (!hoverCapable) return;
    if (key) {
      cancelClose();
      if (hovered === key) return;
      cancelOpen();
      openTimerRef.current = setTimeout(() => { openTimerRef.current = null; setHovered(key); }, POPOVER_OPEN_DELAY);
    } else {
      scheduleClose();
    }
  };
  useEffect(() => () => { cancelClose(); cancelOpen(); }, []);

  const popover = hovered && popPos ? createPortal(
    <div
      ref={popRef}
      className="donut-popover"
      style={{ left: popPos.left, top: popPos.top ?? undefined, bottom: popPos.bottom ?? undefined, maxHeight: popPos.maxHeight }}
      onMouseEnter={cancelClose}
      onMouseLeave={scheduleClose}
    >
      <SegmentPopoverContent segmentKey={hovered} total={totalByKey[hovered]} lines={linesByKey[hovered]} />
    </div>,
    document.body
  ) : null;

  // Portaled, viewport-sized, measured connector -- see the comment above
  // `connector`'s effect. Sits below the popover (z-index) so the popover's
  // own edge visually caps off where the line ends.
  const connectorLine = connector ? createPortal(
    <svg className="donut-connector-svg" width={window.innerWidth} height={window.innerHeight}>
      <line x1={connector.x1} y1={connector.y1} x2={connector.x2} y2={connector.y2} stroke="var(--ink-soft)" strokeWidth={1.5} />
    </svg>,
    document.body
  ) : null;

  return (
    <div className="job-donut-rings-wrap" ref={wrapRef} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="job-donut-rings">
        {/* Quoted -- Quoted Labor + Quoted Parts. Dashed/neutral when there's
            no real quote to show. Click a segment for the full detail modal;
            hover stays as a fast glance. */}
        {hasQuote && !noQuotedTotal ? (
          <>
            <circle cx={center} cy={center} r={rOuter} fill="none" stroke="var(--surface-2)" strokeWidth={strokeWidth} />
            <DonutArc cx={center} cy={center} r={rOuter} strokeWidth={strokeWidth} color="#3B7DD8" circumference={cOuter} startFrac={0} frac={quotedLaborFrac} segmentKey="quotedLabor" hovered={hovered} onHover={handleHover} onSelect={setModalKey} />
            <DonutArc cx={center} cy={center} r={rOuter} strokeWidth={strokeWidth} color="#8B5FBF" circumference={cOuter} startFrac={quotedLaborFrac} frac={quotedPartsFrac} segmentKey="quotedParts" hovered={hovered} onHover={handleHover} onSelect={setModalKey} />
          </>
        ) : (
          <circle cx={center} cy={center} r={rOuter} fill="none" stroke="var(--line-strong)" strokeWidth={strokeWidth} strokeDasharray="4 4" />
        )}
      </svg>
      {connectorLine}
      {popover}
      {modalKey && (
        <SegmentDetailModal segmentKey={modalKey} total={totalByKey[modalKey]} lines={linesByKey[modalKey]} onClose={() => setModalKey(null)} />
      )}
    </div>
  );
}

// List row: name/address/status/LID similar to JobCard's summary fields
// (read-only, no assignment controls needed here) plus the compact donut and
// the raw figures next to it, per direction -- the donut is never shown
// alone.
function ExpenseJobRow({ job, onOpen }) {
  return (
    <button type="button" className="exp-row" onClick={() => onOpen(job.id)}>
      <JobDonut budget={job.awardedAmount} materialsSpent={job.materialExpenses} size={48} />
      <div className="exp-row-main">
        <div className="exp-row-name">{job.name}</div>
        <div className="exp-row-meta">
          {job.lid && <span className="lidtag">LID {job.lid}</span>}
          <span>{job.address || 'No address'}</span>
          {job.status && <span className={`badge ${statusClass(job.status)}`}>{job.status}</span>}
        </div>
      </div>
      <div className="exp-row-figures">
        <div><span className="exp-figure-label">Awarded Amount</span> {fmtCurrency(job.awardedAmount) ?? '-'}</div>
        <div><span className="exp-figure-label">Material Expenses</span> {fmtCurrency(job.materialExpenses) ?? '-'}</div>
        {!job.hasPurchaseOrders && <span className="exp-none-note">No CRS Purchase Orders recorded yet</span>}
      </div>
    </button>
  );
}

const QUOTE_SOURCE_LABEL = {
  awarded: 'From the awarded quote',
  'single-match': 'From a quote matching the awarded amount',
  'sum-match': 'From multiple quotes whose combined total matches the awarded amount',
  'most-recent': 'From the most recent quote (no matching quote found)',
  none: 'No quote data available for this job',
};

// Service Analytics -- per direction 2026-08-28: Service Call jobs don't go
// through the Quote process the way Job/Project work does (confirmed live
// against a real Service - Fire call: quotedLabor/quotedParts/quotedTotal
// all null, quoteSource 'none'), so the Job Analytics view above -- a ring
// and every bar built around quote-vs-actual -- renders as an empty "No
// data" wall for every single Service job. This is a genuinely different
// question for Service work: real cost vs. real revenue, not estimate vs.
// actual. Per direction: Materials gets a real paid-vs-charged comparison
// (both sides are real tracked $ -- Material Expenses from CRS Purchase
// Orders, Billed Materials from the real invoice), plus the one honest
// profit figure this app can compute (Materials Profit -- there's no
// tracked labor cost to net against billed labor, per-tech pay is
// deliberately never a dollar figure here, so this is scoped to materials
// only, not claimed as whole-job profit). Labor stays hours-only, per
// direction: real FS hours with a per-tech Helper/Technician breakdown
// (who + how many), no dollar "cost" side since none exists.
function ServiceJobAnalytics({ data, billedInvoiceLines }) {
  const materialsProfit = data.materialsProfit ?? 0;
  const isProfit = materialsProfit >= 0;
  // Real tracked PO spend (materialExpenses) is almost never present on
  // Service jobs -- per direction 2026-08-28, parts cost here comes from
  // each billed part's own Product2 catalog list price (Standard Pricebook
  // UnitPrice) instead, qty x list price per line, summed. A part that
  // can't be matched to a real catalog product (or has no Standard
  // Pricebook entry) contributes nothing and is flagged, so an incomplete
  // estimate stays visibly incomplete rather than silently under-counting.
  const partsListCostLines = (data.partsListCostLines || []).map((l) => (
    <><td>{l.code}</td><td>{l.qty}</td><td>{l.matched ? fmtCurrency(l.listPrice) : 'no catalog match'}</td><td>{l.matched ? fmtCurrency(l.cost) : '-'}</td></>
  ));
  const hasUnmatchedParts = (data.partsListCostLines || []).some((l) => !l.matched);
  return (
    <>
      <div className="exp-service-summary">
        <div className="exp-figure-row">Awarded Amount <strong>{fmtCurrency(data.awardedAmount) ?? '-'}</strong></div>
        <div className="exp-figure-row">Billed Total <strong>{fmtCurrency(data.billed) ?? '-'}</strong></div>
        <div className={`exp-profit-figure ${isProfit ? 'is-profit' : 'is-loss'}`}>
          <span className="exp-profit-label">Materials {isProfit ? 'Profit' : 'Loss'}</span>
          <span className="exp-profit-amount">{isProfit ? '+' : '−'}{fmtCurrency(Math.abs(materialsProfit))}</span>
        </div>
        <div className="exp-profit-note">Billed Materials − Parts Catalog Cost (Product2 Standard Pricebook list price × qty for each billed part). Materials only, not overall job profit -- labor cost isn't tracked anywhere in this system.</div>
        {hasUnmatchedParts && <div className="exp-none-note">One or more billed parts couldn't be matched to a real catalog product/list price -- this estimate is a floor, real cost may be higher</div>}
        {!data.hasPurchaseOrders && <div className="exp-none-note">No CRS Purchase Orders recorded for this job -- cost estimated from catalog list price instead</div>}
        {!data.hasFsLink && <div className="exp-none-note">No Field Squared data for this job</div>}
      </div>

      <div className="exp-bullet-panel">
        <div className="exp-figure-group-label">Expenses vs. Billed</div>
        <BulletBar segmentKey="billedTotal" actual={data.billed} target={data.partsListCost} unit="$" lines={billedInvoiceLines} targetLabel="in estimated parts cost (catalog list price)" />

        <div className="exp-figure-group-label">Materials: Catalog Cost vs. Charged</div>
        <BulletBar segmentKey="billedMaterials" actual={data.billedMaterials} target={data.partsListCost} unit="$" lines={partsListCostLines} targetLabel="in catalog list price" />

        <div className="exp-figure-group-label">Labor</div>
        <div className="exp-figure-row">Billed Labor <strong>{fmtCurrency(data.billedLabor) ?? '-'}</strong></div>
        {data.hasFsLink ? (
          <>
            <HoursBreakdown label="Technician Hours" hours={data.technicianHours} breakdown={data.technicianBreakdown} />
            <HoursBreakdown label="Helper Hours" hours={data.helperHours} breakdown={data.helperBreakdown} />
          </>
        ) : <div className="exp-none-note">No Field Squared hours data for this job</div>}

        {data.billedOther > 0 && (
          <>
            <div className="exp-figure-group-label">Other Charges</div>
            <div className="exp-figure-row">Truck / Misc / Shipping <strong>{fmtCurrency(data.billedOther)}</strong></div>
          </>
        )}
      </div>
    </>
  );
}

// Real hours (from FS) with who-logged-what visible directly, not hidden
// behind a hover -- per direction 2026-08-28, Service jobs have no quoted
// hours to compare against, so this is a plain stat plus a breakdown list,
// not a BulletBar (which needs a real target to mean anything).
function HoursBreakdown({ label, hours, breakdown }) {
  return (
    <div className="exp-hours-block">
      <div className="exp-figure-row">{label} <strong>{hours != null ? `${hours}h` : '-'}</strong></div>
      {breakdown && breakdown.length > 0 && (
        <div className="exp-hours-people">
          {breakdown.map((t) => (
            <div className="exp-hours-person" key={t.name}><span>{t.name}</span><span>{t.hours}h</span></div>
          ))}
        </div>
      )}
    </div>
  );
}

function ExpenseJobDetail({ oppId, onBack }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    setData(null);
    setErr(null);
    api.getJobCost(oppId).then(setData).catch((e) => setErr(e.message));
  }, [oppId]);

  // Popover line-builders for the bullet bars below -- same shape
  // SegmentPopoverContent already expects ([{name/date/amount fragments}]),
  // built here at the call site same as the ring used to. billedLabor/
  // billedMaterial lines now carry the real invoice docNumber (not just the
  // internal SF id, which was never shown but also wasn't the identifier
  // that belongs here) -- per direction 2026-08-27, so hovering a line
  // shows which real invoice it came from.
  const billedLaborLines = data ? data.invoices.flatMap((inv) =>
    inv.lines.filter((l) => l.category === 'labor')
      .map((l) => (<><td>{inv.docNumber ?? '-'}</td><td>{l.itemName}</td><td>{fmtDate(inv.date)}</td><td>{fmtCurrency(l.amount)}</td></>))
  ) : [];
  const billedMaterialLines = data ? data.invoices.flatMap((inv) =>
    inv.lines.filter((l) => l.category === 'parts')
      .map((l) => (<><td>{inv.docNumber ?? '-'}</td><td>{l.itemName}</td><td>{fmtDate(inv.date)}</td><td>{fmtCurrency(l.amount)}</td></>))
  ) : [];
  const billedInvoiceLines = data ? data.invoices.map((inv) => (
    <><td>{inv.docNumber ?? '-'}</td><td>{fmtDate(inv.date)}</td><td>{fmtCurrency(inv.amount)}</td></>
  )) : [];
  const quotedTotalLines = data ? [...(data.quotedLaborLines || []), ...(data.quotedPartsLines || [])]
    .map((l) => (<><td>{l.name}</td><td>{l.qty}</td><td>{fmtCurrency(l.rate)}</td><td>{fmtCurrency(l.amount)}</td></>)) : [];
  const technicianHoursLines = data ? (data.technicianBreakdown || []).map((t) => (<><td>{t.name}</td><td>{t.hours}h</td></>)) : [];
  const helperHoursLines = data ? (data.helperBreakdown || []).map((t) => (<><td>{t.name}</td><td>{t.hours}h</td></>)) : [];

  return (
    <section className="exp-detail">
      <button type="button" className="req-btn" onClick={onBack}>← Back to jobs</button>
      {err && <div className="empty">Couldn't load job cost: {err}</div>}
      {!err && !data && <LoadingDots label="Loading…" />}
      {data && (
        <>
          <div className="exp-detail-head">
            <OppLink className="jname" id={data.opportunity.id} name={data.opportunity.name} />
            {data.opportunity.lid && <span className="lidtag">LID {data.opportunity.lid}</span>}
          </div>

          {data.jobKind === 'service' ? (
            <ServiceJobAnalytics
              data={data}
              billedInvoiceLines={billedInvoiceLines}
            />
          ) : (
            <>
              <div className="exp-detail-donut-row">
                <JobDonutRings
                  quotedLabor={data.quotedLabor}
                  quotedParts={data.quotedParts}
                  quotedLaborLines={data.quotedLaborLines}
                  quotedPartsLines={data.quotedPartsLines}
                  size={240}
                />
                <div className="exp-detail-figures">
                  <div className="exp-figure-row">Awarded Amount <strong>{fmtCurrency(data.awardedAmount) ?? '-'}</strong></div>

                  <div className="exp-figure-group-label">Quoted <span className="exp-quote-source">({QUOTE_SOURCE_LABEL[data.quoteSource]})</span></div>
                  <div className="exp-figure-row"><span className="exp-dot exp-dot-quoted-labor" />Quoted Labor <strong>{fmtCurrency(data.quotedLabor) ?? '-'}</strong></div>
                  <div className="exp-figure-row"><span className="exp-dot exp-dot-quoted-parts" />Quoted Parts <strong>{fmtCurrency(data.quotedParts) ?? '-'}</strong></div>
                  <div className="exp-figure-row">Quoted Total <strong>{fmtCurrency(data.quotedTotal) ?? '-'}</strong></div>
                  {!(data.quotedTotal > 0) && <div className="exp-none-note">No quote data for this job -- the ring above shows relative to billed/expense totals instead</div>}
                  {!data.hasPurchaseOrders && <div className="exp-none-note">No CRS Purchase Orders recorded for this job yet</div>}
                  {!data.hasFsLink && <div className="exp-none-note">No Field Squared data for this job</div>}
                </div>
              </div>

              <div className="exp-bullet-panel">
                <div className="exp-figure-group-label">Award vs. Quote</div>
                <BulletBar segmentKey="quotedTotal" actual={data.quotedTotal} target={data.awardedAmount} unit="$" lines={quotedTotalLines} />

                <div className="exp-figure-group-label">Materials</div>
                {/* Target is the catalog cost of the parts that were quoted
                    (Product2 Standard Pricebook list price x quoted qty),
                    not Quoted Parts' own $ total -- per direction 2026-08-28,
                    Quoted Parts bundles in quote-level markup, tax, and
                    shipping (confirmed live against this exact job: of an
                    $11,423.50 Quoted Parts total, only $5,453.60 was real
                    material line items), which answers "did we bill what we
                    quoted" but not "did our real cost track the parts we
                    actually quoted" -- this bar answers the latter. Billed
                    Materials below still compares against Quoted Parts
                    itself, since that IS the right target for a revenue
                    question. */}
                <BulletBar segmentKey="materialExpenses" actual={data.materialExpenses} target={data.quotedPartsListCost} unit="$" targetLabel="in catalog list price for the parts quoted" lines={
                  (data.materialExpenseLines || []).map((l) => (<><td>{l.poNumber}</td><td>{l.vendor ?? '-'}</td><td>{fmtDate(l.date) ?? '-'}</td><td>{fmtCurrency(l.amount)}</td></>))
                } />
                <BulletBar segmentKey="billedMaterials" actual={data.billedMaterials} target={data.quotedParts} unit="$" lines={billedMaterialLines} />

                <div className="exp-figure-group-label">Labor</div>
                <BulletBar segmentKey="billedLabor" actual={data.billedLabor} target={data.quotedLabor} unit="$" lines={billedLaborLines} />
                <BulletBar segmentKey="technicianHours" actual={data.hasFsLink ? data.technicianHours : null} target={data.quotedTechnicianHours} unit="h" lines={technicianHoursLines} />
                <BulletBar segmentKey="helperHours" actual={data.hasFsLink ? data.helperHours : null} target={data.quotedHelperHours} unit="h" lines={helperHoursLines} />

                <div className="exp-figure-group-label">Billing</div>
                <BulletBar segmentKey="billedTotal" actual={data.billed} target={data.awardedAmount} unit="$" lines={billedInvoiceLines} />
                {data.overBilledBy != null && <div className="exp-none-note">Billed {fmtCurrency(data.overBilledBy)} over the Awarded Amount</div>}
              </div>
            </>
          )}

          <h3>Invoices</h3>
          {data.invoices.length === 0 && <div className="na">No invoices on file</div>}
          {data.invoices.map((inv) => (
            <div className="invoice-detail exp-invoice" key={inv.id}>
              <div className="invoice-detail-row">
                <span className="invoice-detail-label">Invoice #</span>
                <span className="invoice-detail-value">
                  {inv.docNumber ?? <span className="na">-</span>}
                  {inv.qboId && (
                    <a className="qbo-open-link" href={`https://qbo.intuit.com/app/invoice?txnId=${inv.qboId}`} target="_blank" rel="noopener noreferrer">↗ QuickBooks</a>
                  )}
                </span>
              </div>
              <div className="invoice-detail-row"><span className="invoice-detail-label">Date</span><span className="invoice-detail-value">{fmtDate(inv.date) ?? <span className="na">-</span>}</span></div>
              <div className="invoice-detail-row"><span className="invoice-detail-label">Amount</span><span className="invoice-detail-value">{fmtCurrency(inv.amount) ?? <span className="na">-</span>}</span></div>
              <div className="invoice-detail-row"><span className="invoice-detail-label">Status</span><span className="invoice-detail-value">{inv.status ?? <span className="na">-</span>}</span></div>
              {(inv.laborAmt != null || inv.partsAmt != null || inv.otherAmt != null) && (
                <div className="invoice-detail-row">
                  <span className="invoice-detail-label">Labor / Parts / Other (est.)</span>
                  <span className="invoice-detail-value">{fmtCurrency(inv.laborAmt) ?? '-'} / {fmtCurrency(inv.partsAmt) ?? '-'} / {fmtCurrency(inv.otherAmt) ?? '-'}</span>
                </div>
              )}
              {inv.lines.length > 0 && (
                <div className="exp-invoice-lines-scroll">
                  {/* Shows on both breakpoints (a small heading above the
                      table is harmless on desktop), but it's mobile
                      (styles.css) that actually needs it -- once the table
                      below stacks into individual line-item cards, this is
                      what visibly ties them back to the invoice summary
                      above instead of reading as their own unrelated
                      cards. */}
                  <div className="exp-invoice-lines-label">Line Items</div>
                  <table className="exp-invoice-lines recon-screen">
                    <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th><th>Category</th></tr></thead>
                    <tbody>
                      {inv.lines.map((l, i) => (
                        <tr key={i}>
                          <td>{l.itemName ?? '-'}</td>
                          <td data-label="Qty">{l.qty ?? '-'}</td>
                          <td data-label="Rate">{fmtCurrency(l.rate) ?? '-'}</td>
                          <td data-label="Amount">{fmtCurrency(l.amount) ?? '-'}</td>
                          <td data-label="Category">{l.category}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </section>
  );
}

// Sort menu tree -- same hover-to-expand flyout shape/CSS as the Outstanding
// Jobs tab's Type filter (TypeFilterMenu, reuses the same .fsel-* classes),
// just with every category always expanding (no bare-category selection --
// every metric here has exactly an ascending/descending pair).
const EXPENSE_SORT_TREE = [
  { category: 'Last Modified', subs: [['modified_recent', 'Most recent'], ['modified_oldest', 'Oldest']] },
  { category: 'Awarded Amount', subs: [['budget_desc', 'High to low'], ['budget_asc', 'Low to high']] },
  { category: 'Material Expenses', subs: [['spend_desc', 'High to low'], ['spend_asc', 'Low to high']] },
  { category: '% of Awarded Amount Spent', subs: [['pct_desc', 'High to low'], ['pct_asc', 'Low to high']] },
  { category: 'Close Date', subs: [['close_recent', 'Most recent'], ['close_oldest', 'Oldest']] },
  { category: 'Name', subs: [['name_az', 'A to Z'], ['name_za', 'Z to A']] },
];

function expenseSortLabel(key) {
  for (const { category, subs } of EXPENSE_SORT_TREE) {
    const hit = subs.find(([v]) => v === key);
    if (hit) return `${category} · ${hit[1]}`;
  }
  return 'Sort';
}

function sortExpenseJobs(jobs, key) {
  const pctUsed = (j) => (j.awardedAmount > 0 ? j.materialExpenses / j.awardedAmount : (j.materialExpenses > 0 ? Infinity : 0));
  const sorted = [...jobs];
  switch (key) {
    case 'modified_recent': sorted.sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || '')); break;
    case 'modified_oldest': sorted.sort((a, b) => (a.lastModified || '').localeCompare(b.lastModified || '')); break;
    case 'budget_desc': sorted.sort((a, b) => b.awardedAmount - a.awardedAmount); break;
    case 'budget_asc': sorted.sort((a, b) => a.awardedAmount - b.awardedAmount); break;
    case 'spend_desc': sorted.sort((a, b) => b.materialExpenses - a.materialExpenses); break;
    case 'spend_asc': sorted.sort((a, b) => a.materialExpenses - b.materialExpenses); break;
    case 'pct_desc': sorted.sort((a, b) => pctUsed(b) - pctUsed(a)); break;
    case 'pct_asc': sorted.sort((a, b) => pctUsed(a) - pctUsed(b)); break;
    case 'close_recent': sorted.sort((a, b) => (b.closeDate || '').localeCompare(a.closeDate || '')); break;
    case 'close_oldest': sorted.sort((a, b) => (a.closeDate || '').localeCompare(b.closeDate || '')); break;
    case 'name_az': sorted.sort((a, b) => a.name.localeCompare(b.name)); break;
    case 'name_za': sorted.sort((a, b) => b.name.localeCompare(a.name)); break;
    default: break;
  }
  return sorted;
}

// Flyout sort menu -- mirrors TypeFilterMenu's structure (App.jsx) exactly,
// reusing the same .fsel-* CSS, just with EXPENSE_SORT_TREE's shape (every
// category always has an asc/desc-style pair, no bare-category click).
function ExpenseSortMenu({ value, onChange }) {
  const { open, setOpen, pos, wrapRef, popRef } = useAnchoredPopover(170);
  const [activeCat, setActiveCat] = useState(null);
  const [flip, setFlip] = useState(false);

  useEffect(() => { if (!open) setActiveCat(null); }, [open]);

  const pick = (v) => { onChange(v); setOpen(false); };
  const onEnterCat = (category) => {
    setActiveCat(category);
    if (popRef.current) {
      const r = popRef.current.getBoundingClientRect();
      setFlip(r.right + 200 > window.innerWidth - 8);
    }
  };

  return (
    <div className="fsel-wrap" ref={wrapRef}>
      <button type="button" className="fsel-trigger" aria-label="Sort" onClick={() => setOpen((o) => !o)}>
        <span className="fsel-val">{expenseSortLabel(value)}</span>
        <span className="fsel-caret" aria-hidden>▾</span>
      </button>
      {open && createPortal(
        <div className="fsel-menu" ref={popRef}
          style={{ left: pos.left, minWidth: pos.width, ...(pos.bottom != null ? { bottom: pos.bottom } : { top: pos.top }) }}
          onMouseLeave={() => setActiveCat(null)}>
          {EXPENSE_SORT_TREE.map(({ category, subs }) => (
            <div key={category} className="fsel-catrow" onMouseEnter={() => onEnterCat(category)}>
              <button type="button" className="fsel-opt has-sub">{category}</button>
              {activeCat === category && (
                <div className={`fsel-sub ${flip ? 'flip-left' : ''}`}>
                  {subs.map(([v, label]) => (
                    <button key={v} type="button" className={`fsel-opt ${value === v ? 'sel' : ''}`} onClick={() => pick(v)}>{label}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

// Persists which job's detail view (if any) is open, the same localStorage
// pattern as the top-level VIEW_STATE_KEY above (this app has no router) --
// without it, a refresh while looking at a job's cost breakdown dropped back
// to the full jobs list instead of staying put. Scoped to its own key rather
// than folded into VIEW_STATE_KEY since this tab's state is self-contained.
const EXPENSE_VIEW_STATE_KEY = 'dispatch_expense_view_state';
const loadExpenseViewState = () => {
  try { return JSON.parse(localStorage.getItem(EXPENSE_VIEW_STATE_KEY) || '{}'); } catch { return {}; }
};

function ExpenseTrackingTab() {
  const [jobs, setJobs] = useState(null);
  const [err, setErr] = useState(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('modified_recent');
  const [typeFilter, setTypeFilter] = useState('all');
  const [selectedOppId, setSelectedOppId] = useState(() => loadExpenseViewState().selectedOppId ?? null);

  useEffect(() => {
    localStorage.setItem(EXPENSE_VIEW_STATE_KEY, JSON.stringify({ selectedOppId }));
  }, [selectedOppId]);

  useEffect(() => {
    api.getExpenseJobs().then((d) => setJobs(d.jobs)).catch((e) => setErr(e.message));
  }, []);

  // A job's own "type" label for filtering/display -- recordType 'Job' wins
  // (the more concrete signal, same as isJobType's own priority), else the
  // real Opportunity_Type__c value. Flat, single-level -- these bare category
  // names (Fire/Access/CCTV/Security/...) have no further nesting the way
  // Service Call's sub-types do, so TypeFilterMenu's flyout arrow never
  // triggers here (every entry gets empty subtypes, same as clicking a
  // leaf-level category in the Outstanding Jobs Type menu).
  const jobTypeLabel = (j) => (j.recordType === 'Job' ? 'Job' : (j.opportunityType || 'Other'));
  const jobTypeTree = useMemo(() => {
    if (!jobs) return [];
    const types = new Set(jobs.map(jobTypeLabel));
    return [...types].sort().map((category) => ({ category, subtypes: [] }));
  }, [jobs]);

  if (selectedOppId) {
    return <ExpenseJobDetail oppId={selectedOppId} onBack={() => setSelectedOppId(null)} />;
  }

  const q = search.trim().toLowerCase();
  // Searches across every field shown in the row, not just name -- address,
  // LID, and status all match too, so a search actually surfaces every real
  // result rather than only name/address hits.
  const filtered = jobs
    ? jobs.filter((j) => (typeFilter === 'all' || jobTypeLabel(j) === typeFilter)
        && (!q
          || j.name.toLowerCase().includes(q)
          || (j.address || '').toLowerCase().includes(q)
          || (j.lid || '').toLowerCase().includes(q)
          || (j.status || '').toLowerCase().includes(q)))
    : [];
  const shown = sortExpenseJobs(filtered, sortKey);

  return (
    <section className="exp-list">
      <div className="view-head">
        <div><h2>Expense Tracking</h2><p>{jobs ? `${shown.length} of ${jobs.length} jobs` : 'Loading…'}</p></div>
        <div className="usage-controls">
          <div className="searchbox">
            <span className="si">⌕</span>
            <input className="searchinput" type="text" placeholder="Search jobs…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {jobTypeTree.length > 0 && <TypeFilterMenu value={typeFilter} tree={jobTypeTree} onChange={setTypeFilter} />}
          <ExpenseSortMenu value={sortKey} onChange={setSortKey} />
        </div>
      </div>
      {err && <div className="empty">Couldn't load jobs: {err}</div>}
      {!err && !jobs && <LoadingDots label="Loading jobs…" />}
      {jobs && shown.length === 0 && <div className="empty">{q ? 'No jobs match that search.' : 'No jobs or invoiced service calls found.'}</div>}
      {shown.map((job) => <ExpenseJobRow key={job.id} job={job} onOpen={setSelectedOppId} />)}
    </section>
  );
}

// Admin usage dashboard (D1-backed): KPIs, per-day + time-of-day bars, by-screen,
// top features, who's-using-it, a recent-activity feed, and a per-user drill-down.
// Auto-refresh interval while the Usage tab is actually open -- per direction
// 2026-08-27: before this, the tab had no polling at all, only refetching on
// first mount or the manual "↻ Refresh" button -- an admin watching it could
// genuinely miss a just-fired event indefinitely. This only runs while
// UsageDashboard is mounted (i.e. only while the Usage tab is the active
// tab), same lifecycle-scoping as any other component-local interval here.
const USAGE_POLL_MS = 20 * 1000;

function UsageDashboard({ refreshKey = 0 }) {
  const [days, setDays] = useState(30);
  const [app, setApp] = useState('all');
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [recent, setRecent] = useState([]);
  const [people, setPeople] = useState([]);
  const [selPerson, setSelPerson] = useState('');
  const [detail, setDetail] = useState(null);
  const [tick, setTick] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), USAGE_POLL_MS);
    return () => clearInterval(id);
  }, []);

  // Per direction 2026-08-27: the auto-refresh (or the manual filter/days
  // change below it) used to null out `data` before every refetch, which
  // dropped the whole page back to the bare LoadingDots state every 20s --
  // scroll position, an open drill-down, whatever you were looking at, all
  // blown away by a poll tick you didn't even ask for. Same "stay on the old
  // data until the new data is ready" fix already applied to Billing
  // Reconciliation -- `data` (and `recent`/`people`/`detail` below, which
  // never had the clear-first bug in the first place) is only ever replaced
  // once the new fetch resolves, never blanked mid-flight. `refreshing`
  // drives a small inline "Updating…" indicator instead of a full teardown.
  useEffect(() => {
    setRefreshing(true);
    api.getUsage(days, app).then((d) => { setData(d); setErr(null); }).catch((e) => setErr(e.message)).finally(() => setRefreshing(false));
  }, [days, app, refreshKey, tick]);
  useEffect(() => { api.getUsageRecent({ days, app, limit: 120 }).then((r) => setRecent(r.events || [])).catch(() => setRecent([])); }, [days, app, refreshKey, tick]);
  useEffect(() => { api.getUsagePeople().then((r) => setPeople(r.people || [])).catch(() => {}); }, [refreshKey, tick]);
  useEffect(() => {
    if (!selPerson) { setDetail(null); return; }
    api.getUsageUser(selPerson, days).then(setDetail).catch(() => setDetail(null));
  }, [selPerson, days, refreshKey, tick]);

  const peopleOptions = useMemo(
    () => people.map((p) => [p.name, `${p.name} · ${p.kind === 'tech' ? 'Tech' : 'Office'}`]),
    [people]
  );
  // Fill all 24 hours so the time-of-day chart has a stable shape.
  const hourRows = useMemo(() => {
    const m = new Map((data?.byHour || []).map((r) => [String(r.h), r.c]));
    return Array.from({ length: 24 }, (_, h) => ({ d: `${String(h).padStart(2, '0')}h`, c: m.get(String(h).padStart(2, '0')) ?? 0 }));
  }, [data]);

  // "Actions summary": byEvent minus screen views (those live in byScreen) and
  // logins (already a KPI), each row given a friendly label. Sorted by count.
  const actionRows = useMemo(
    () => (data?.byEvent || [])
      .filter((e) => !isScreenView(e.event) && e.event !== 'login')
      .map((e) => ({ label: eventLabel(e.event), c: e.c })),
    [data]
  );
  // Split totals: actions taken vs. screens opened (kept apart per request).
  const actionTotal = useMemo(() => actionRows.reduce((s, a) => s + a.c, 0), [actionRows]);
  const viewTotal = useMemo(
    () => (data?.byEvent || []).filter((e) => isScreenView(e.event)).reduce((s, e) => s + e.c, 0),
    [data]
  );

  return (
    <section className="usage">
      <div className="view-head usage-head">
        <div>
          <h2>Usage</h2>
          <div className="synced"><span className="dot" /><span className="lbl">Auto-refreshes every {USAGE_POLL_MS / 1000}s</span></div>
          {refreshing && data && <LoadingDots label="Updating…" inline />}
        </div>
        <div className="usage-controls">
          <div className="usage-range">
            {USAGE_APPS.map(([v, l]) => (
              <button key={v} className={`chip ${app === v ? 'on' : ''}`} onClick={() => setApp(v)}>{l}</button>
            ))}
          </div>
          <div className="usage-range">
            {[7, 30, 90].map((d) => (
              <button key={d} className={`chip ${days === d ? 'on' : ''}`} onClick={() => setDays(d)}>{d}d</button>
            ))}
          </div>
        </div>
      </div>

      {err && <div className="empty">Couldn’t load usage: {err}</div>}
      {!err && !data && <LoadingDots label="Loading usage…" />}
      {data && (
        <>
          <div className="usage-kpis">
            <div className="usage-kpi"><span className="k-num">{data.totals.users ?? 0}</span><span className="k-lbl">Active users</span></div>
            <div className="usage-kpi"><span className="k-num">{actionTotal}</span><span className="k-lbl">Actions</span></div>
            <div className="usage-kpi"><span className="k-num">{viewTotal}</span><span className="k-lbl">Screen views</span></div>
            <div className="usage-kpi"><span className="k-num">{data.totals.logins ?? 0}</span><span className="k-lbl">Logins</span></div>
            <div className="usage-kpi"><span className="k-num">{(data.byEvent || []).find((e) => e.event === 'quote_sent')?.c ?? 0}</span><span className="k-lbl">Quotes sent</span></div>
            <div className="usage-kpi">
              <span className="k-num">{(data.byApp || []).map((a) => `${a.app}:${a.c}`).join(' · ') || '-'}</span>
              <span className="k-lbl">By app</span>
            </div>
          </div>

          <div className="usage-panel">
            <h3>Actions summary</h3>
            <p className="usage-panel-sub">Key things people did - scheduling, quotes, status changes, and more.</p>
            {actionRows.length === 0 ? (
              <p className="tech-links-hint">No actions in this range.</p>
            ) : (
              <div className="usage-action-grid">
                {actionRows.map((a, i) => (
                  <div className="usage-action" key={i}>
                    <span className="ua-num">{a.c}</span>
                    <span className="ua-lbl">{a.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="usage-cols">
            <div className="usage-panel">
              <h3>Events per day</h3>
              <UsageBars rows={data.eventsByDay || []} />
            </div>
            <div className="usage-panel">
              <h3>Time of day</h3>
              <UsageBars rows={hourRows} labelKey="d" slice5={false} />
            </div>
          </div>

          <div className="usage-cols">
            <div className="usage-panel">
              <h3>Who’s using it</h3>
              <table className="usage-table">
                <thead><tr><th>Name</th><th>App</th><th>Events</th><th>Last seen</th></tr></thead>
                <tbody>
                  {(data.byUser || []).map((u, i) => (
                    <tr key={i}><td>{u.actor}</td><td>{u.app}</td><td>{u.c}</td><td>{fmtUsageShort(u.last)}</td></tr>
                  ))}
                  {(data.byUser || []).length === 0 && <tr><td colSpan={4} className="tech-links-hint">No activity yet.</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="usage-panel">
              <h3>Screen views</h3>
              <p className="usage-panel-sub">Which screens people opened (navigation, not actions).</p>
              <table className="usage-table">
                <thead><tr><th>Screen</th><th>Views</th><th>Avg time on screen</th></tr></thead>
                <tbody>
                  {(data.byScreen || []).map((s, i) => (<tr key={i}><td>{s.screen}</td><td>{s.c}</td><td>{fmtDuration(s.avgMs) ?? '-'}</td></tr>))}
                  {(data.byScreen || []).length === 0 && <tr><td colSpan={3} className="tech-links-hint">No screen views yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="usage-panel">
            <h3>Recent activity</h3>
            <div className="usage-feed">
              {recent.map((e, i) => (
                <div className={`usage-feed-row ${isScreenView(e.event) ? 'is-view' : 'is-action'}`} key={i}>
                  <span className="usage-feed-time">{fmtUsageShort(e.ts)}</span>
                  <span className={`usage-feed-app ${e.app}`}>{e.app}</span>
                  <span className="usage-feed-actor">{e.actor}</span>
                  <span className={`usage-feed-kind ${isScreenView(e.event) ? 'view' : 'action'}`}>{isScreenView(e.event) ? 'View' : 'Action'}</span>
                  <span className="usage-feed-event">{feedLabel(e)}</span>
                </div>
              ))}
              {recent.length === 0 && <p className="tech-links-hint">No activity in this range.</p>}
            </div>
          </div>

          <div className="usage-panel">
            <h3>Check a specific person</h3>
            <SearchableSelect value={selPerson} onChange={setSelPerson} options={peopleOptions} placeholder="Pick a tech or office user…" />
            {selPerson && !detail && <LoadingDots label="Loading…" />}
            {selPerson && detail && (
              <div className="usage-detail">
                <div className="usage-kpis">
                  <div className="usage-kpi"><span className="k-num">{detail.totals.events ?? 0}</span><span className="k-lbl">Events</span></div>
                  <div className="usage-kpi"><span className="k-num">{detail.activeDays ?? 0}</span><span className="k-lbl">Days active</span></div>
                  <div className="usage-kpi"><span className="k-num">{fmtUsageShort(detail.totals.first)}</span><span className="k-lbl">First seen</span></div>
                  <div className="usage-kpi"><span className="k-num">{fmtUsageShort(detail.totals.last)}</span><span className="k-lbl">Last seen</span></div>
                </div>
                {(detail.totals.events ?? 0) === 0 ? (
                  <p className="tech-links-hint">No activity yet for {selPerson}.</p>
                ) : (
                  <>
                    <UsageBars rows={detail.eventsByDay || []} />
                    <div className="usage-cols">
                      <div>
                        <h4 className="usage-subh">Their actions</h4>
                        <table className="usage-table">
                          <thead><tr><th>Action</th><th>Count</th></tr></thead>
                          <tbody>
                            {(detail.byEvent || []).filter((e) => !isScreenView(e.event)).map((e, i) => (<tr key={i}><td>{eventLabel(e.event)}</td><td>{e.c}</td></tr>))}
                            {(detail.byEvent || []).filter((e) => !isScreenView(e.event)).length === 0 && <tr><td colSpan={2} className="tech-links-hint">No actions yet.</td></tr>}
                          </tbody>
                        </table>
                      </div>
                      <div>
                        <h4 className="usage-subh">Their screen views</h4>
                        <table className="usage-table">
                          <thead><tr><th>Screen</th><th>Views</th><th>Avg time</th></tr></thead>
                          <tbody>{(detail.byScreen || []).map((s, i) => (<tr key={i}><td>{s.screen}</td><td>{s.c}</td><td>{fmtDuration(s.avgMs) ?? '-'}</td></tr>))}</tbody>
                        </table>
                      </div>
                    </div>
                    <h4 className="usage-subh">Recent activity</h4>
                    <div className="usage-feed">
                      {(detail.recent || []).map((e, i) => (
                        <div className={`usage-feed-row ${isScreenView(e.event) ? 'is-view' : 'is-action'}`} key={i}>
                          <span className="usage-feed-time">{fmtUsageShort(e.ts)}</span>
                          <span className={`usage-feed-app ${e.app}`}>{e.app}</span>
                          <span className={`usage-feed-kind ${isScreenView(e.event) ? 'view' : 'action'}`}>{isScreenView(e.event) ? 'View' : 'Action'}</span>
                          <span className="usage-feed-event">{feedLabel(e)}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
