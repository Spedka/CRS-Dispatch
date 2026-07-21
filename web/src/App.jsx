import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from './api.js';

// Map your real status strings to a color treatment. Unknown -> neutral.
const STATUS_CLASS = {
  'Pending Customer Approval': 'scheduled',
  'Quoted': 'scheduled',
  'Parts Ordered': 'needs',
  'Ready to be scheduled': 'needs',   // amber — needs a tech assigned
  'Scheduled': 'scheduled',           // blue — booked
  'In Progress': 'dispatched',        // indigo — tech on site
  'Installation Completed': 'dispatched',
  'Waiting on Payment': 'emergency',  // red — done, awaiting payment
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

// Everything that stays on the board (mirrors config.jobStatusValues).
const BOARD_STATUSES = [
  'Pending Customer Approval', 'Quoted', 'Parts Ordered', 'Ready to be scheduled',
  'Scheduled', 'In Progress', 'Installation Completed', 'Waiting on Payment',
];
// A dispatcher can set any board status, plus "Project Complete" to take a job
// off the board manually (it's a real picklist value, just not in jobStatusValues,
// so the board query is unaffected). "Billing Complete" stays excluded — that one
// still only happens in Field Squared. Strings must match the SF picklist EXACTLY.
const ASSIGNABLE_STATUSES = [...BOARD_STATUSES, 'Project Complete'];

// =====================================================================
//  FS drift badge — EDIT ME
//  Maps each dispatch status (Project_Status__c) to the set of raw FS
//  statuses that are NOT a contradiction for it — i.e. FS is either already
//  in agreement or in an expected transient state on the way there. Any FS
//  status not listed for the job's current dispatch status is flagged red.
//
//  Seeded as a guess from the write-direction tables in
//  server/src/statusMap.js (FS_TO_SF / SF_TO_FS) — verify against real data.
//  This map is comparison-only: it never drives a write to SF or FS.
//
//  Example (confirmed): dispatch status "Installation Completed" with FS
//  status "Entered" → "Entered" isn't in the list below → red.
//  Dispatch "Billing Complete" with FS "Completed" → same → red.
// =====================================================================
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

  const compatible = FS_STATUS_COMPATIBLE[job.status];
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

// Statuses that auto-advance to "Scheduled" the moment a job is given a date.
// (Already-advanced statuses like In Progress are left alone.)
const PRE_SCHEDULED = ['Quoted', 'Parts Ordered', 'Ready to be scheduled'];

// ---- date helpers (all local-time, no UTC drift) ----
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = (d) => { const x = startOfDay(d); x.setDate(x.getDate() - x.getDay()); return x; }; // Sunday start
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateOnlyISO = (iso) => iso && typeof iso === 'string' ? iso.slice(0, 10) : null;
const initials = (name) => name ? name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() : '?';
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

function fmtAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `synced ${s}s ago`;
  return `synced ${Math.floor(s / 60)}m ago`;
}

function nextScheduledAssignmentDate(job) {
  const dates = (job.assignments || [])
    .filter((a) => a.workDate && !a.completed)
    .map((a) => a.workDate)
    .sort();
  return dates[0] || '';
}

function deriveJobStatusFromAssignments(job) {
  const assignments = job.assignments || [];
  const nextDate = nextScheduledAssignmentDate(job);
  if (nextDate) return { status: 'Scheduled', scheduledDate: nextDate };
  return { status: 'Ready to be scheduled', scheduledDate: '' };
}

// Ticks once a second on its own — kept out of App so the "synced Xs ago"
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
// every job card — only the ones whose own props actually changed. That only
// works because every handler prop below is stabilized with useCallback in
// App, and fsLinkForJob/pendingAddForJob collapse to `null` for every row
// except the one with a panel open (see the .map() call site in App).
const JobCard = React.memo(function JobCard({
  job, readOnly, techs, fsLinkForJob, pendingAddForJob, jobNotes, onOpenNote, onDeleteNote,
  onToggleDone, onAssignmentDateChange, onAssignmentTimeChange, onUnassign, onAssign,
  onSetStatus, onOpenFsLink, onCloseFsLink, onFsLinkChange, onPendingAddChange,
  onSearchFs, onConfirmFsLink,
}) {
  if (readOnly) {
    return (
      <div className="job ro">
        <div className="stripe" data-status={statusClass(job.status)} />
        <div className="body">
          <div className="row1">
            <span className="jname">{job.name}</span>
            {job.lid && <span className="lidtag">LID {job.lid}</span>}
            {job.fsTaskId
              ? <span className="fs-badge linked" title={`FS task: ${job.fsTaskId}`}>⬡ FS</span>
              : <span className="fs-badge unlinked" title="No Field Squared task linked">⬡ FS</span>}
            <FsDriftBadge job={job} />
            <span className={`badge ${statusClass(job.status)}`}>{job.status}</span>
            {jobNotes?.length > 0 && <JobNotesBadge notes={jobNotes} onOpenNote={onOpenNote} onDeleteNote={onDeleteNote} />}
          </div>
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
    );
  }

  const fsOpen = !!fsLinkForJob;

  return (
    <div className="job">
      <div className="stripe" data-status={statusClass(job.status)} />
      <div className="body">
        <div className="row1">
          <span className="jname">{job.name}</span>
          {job.lid && <span className="lidtag">LID {job.lid}</span>}
          {job.fsTaskId
            ? <span className="fs-badge linked" title={`FS task: ${job.fsTaskId}`}>⬡ FS</span>
            : <button className="fs-badge unlinked fs-attach-btn" title="Attach Field Squared job" onClick={() => fsOpen ? onCloseFsLink() : onOpenFsLink(job.id)}>⬡ Attach FS</button>}
          <FsDriftBadge job={job} />
          <select
            className={`statussel ${statusClass(job.status)}`}
            value={job.status}
            onChange={(e) => onSetStatus(job, e.target.value)}
          >
            {!ASSIGNABLE_STATUSES.includes(job.status) && <option value={job.status}>{job.status}</option>}
            {ASSIGNABLE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {jobNotes?.length > 0 && <JobNotesBadge notes={jobNotes} onOpenNote={onOpenNote} onDeleteNote={onDeleteNote} />}
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
        <div className="meta">
          <span><span className="ic">◍</span>{job.address || 'No address'}</span>
          {job.closeDate && <span className="created">Close Date {fmtDate(job.closeDate)}</span>}
          <span className="nextlabel">Next scheduled</span>
          <span className="dateinput ro" title="Next scheduled assignment date">
            {nextScheduledAssignmentDate(job) ? fmtDate(nextScheduledAssignmentDate(job)) : '—'}
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
                  title={a.completed ? 'Worked this day — click to reopen' : 'Mark as worked (freezes the date)'}
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
                {!a.workDate && !a.completed && <span className="untag">unscheduled</span>}
                <button className="x" onClick={() => onUnassign(job, a.assignmentId)} aria-label="Remove">×</button>
              </div>
            );
          })}
          <div>
            <select className="addtech" value="" onChange={(e) => {
              const techId = e.target.value;
              if (!techId) return;
              e.target.value = '';
              onPendingAddChange({ jobId: job.id, techId, date: job.scheduledDate || '', time: '' });
            }}>
              <option value="">+ Add assignment</option>
              {techs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            {pendingAddForJob && (
              <div className="inline-add">
                <span className="pending-tech">{techs.find((t) => t.id === pendingAddForJob.techId)?.name}</span>
                <DatePicker className="dp-adate" value={pendingAddForJob.date || ''} onChange={(v) => onPendingAddChange((p) => ({ ...p, date: v }))} placeholder="Date" />
                <TimePicker
                  className="atime"
                  value={pendingAddForJob.time || '07:00'}
                  onChange={(v) => onPendingAddChange((p) => ({ ...p, time: v }))}
                  title="Start time"
                  quickPicks={deriveTimeQuickPicks(job.assignments)}
                />
                <button className="add-btn" onClick={async () => {
                  const { techId, date, time } = pendingAddForJob;
                  onPendingAddChange({ jobId: null, techId: '', date: '', time: '' });
                  await onAssign(job, techId, date || '', time || '07:00');
                }}>Add</button>
                <button className="cancel-btn" onClick={() => onPendingAddChange({ jobId: null, techId: '', date: '', time: '' })}>Cancel</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

export default function App() {
  const [tab, setTab] = useState(() => loadViewState().tab ?? 'jobs');
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
  // Infinite scroll on the jobs list — only the first `visibleCount` of `shown`
  // are ever mounted. Everything's already loaded client-side (no server paging),
  // so "loading more" just raises this cap; no extra fetch involved.
  const [visibleCount, setVisibleCount] = useState(50);
  const [extraJobs, setExtraJobs] = useState([]);   // jobs fetched for a terminal-status filter
  const [extraLoading, setExtraLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [lastSync, setLastSync] = useState(null);
  const [pendingAdd, setPendingAdd] = useState({ jobId: null, techId: '', date: '', time: '' });
  const [selectedJobId, setSelectedJobId] = useState(null);
  const [fsLink, setFsLink] = useState({ jobId: null, query: '', searching: false, matches: null, error: null });
  const [draftJob, setDraftJob] = useState(null);
  const [draftPendingAdd, setDraftPendingAdd] = useState({ techId: '', date: '', time: '' });
  const [contacts, setContacts] = useState([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactsLoaded, setContactsLoaded] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
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
  const [techLinksOpen, setTechLinksOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem(VIEW_STATE_KEY, JSON.stringify({
      tab, filter, query, closedFrom, closedTo, sortBy, jobTech, jobType, jobFsStatus,
    }));
  }, [tab, filter, query, closedFrom, closedTo, sortBy, jobTech, jobType, jobFsStatus]);

  // Count of in-flight writes. While > 0 the poll holds off so a background
  // refresh can't overwrite a change you just made but that hasn't saved yet.
  const pending = useRef(0);

  // Infinite-scroll sentinel ref — the observer effect lives further down,
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

  // A new search/filter is a new list — start from the top rather than keeping
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
      if (job) setDraftJob(JSON.parse(JSON.stringify(job)));
    } else {
      setDraftJob(null);
      setDraftPendingAdd({ techId: '', date: '', time: '' });
    }
  }, [selectedJobId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Also loaded for the Accounts tab, not just Contacts — its "Change
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
    if (tab !== 'accounts' || accountsLoaded) return;
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

  // Re-fetched on every visit (not cached like contacts) — a stale queue defeats
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

  // Stabilized with useCallback (empty deps — they only touch state setters and
  // the pending ref, both stable) so JobCard's React.memo below actually works:
  // an unstable handler prop defeats memoization for every row, not just one.
  const flash = useCallback((msg) => { setToast(msg); setTimeout(() => setToast(null), 2200); }, []);

  const track = useCallback(async (fn) => {
    pending.current += 1;
    try { return await fn(); }
    finally { pending.current -= 1; }
  }, []);

  const assign = useCallback(async (job, technicianId, workDate, startTime = '07:00') => {
    const tech = techs.find((t) => t.id === technicianId);
    try {
      // Compute derived status before the call so the server can update the SF Opp
      // in the same request — eliminating the separate updateJob round-trip.
      const tentative = { ...job, assignments: [...job.assignments, { workDate, completed: false }] };
      const derived = deriveJobStatusFromAssignments(tentative);
      const resp = await track(() => api.addAssignment(job.id, technicianId, workDate, startTime, derived.status, derived.scheduledDate));
      const assignmentId = resp.assignmentId;
      const created = resp.assignment;
      const newAssignment = created
        ? { assignmentId: created.assignmentId, technicianId: created.technicianId, technicianName: created.technicianName, workDate: created.workDate, startTime: created.startTime || '07:00', completed: created.completed }
        : { assignmentId, technicianId, technicianName: tech?.name, workDate: workDate || null, startTime: startTime || '07:00', completed: false };
      const updated = { ...job, assignments: [...job.assignments, newAssignment] };
      setJobs((prev) => prev.map((j) => j.id === job.id ? { ...updated, ...derived } : j));
      flash(`${tech?.name} added to ${job.name}`);
    } catch (e) { flash(`Could not assign: ${e.message}`); }
  }, [techs, flash, track]);

  const unassign = useCallback(async (job, assignmentId) => {
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

  const setDate = async (job, date) => {
    // Giving an un-advanced job a date schedules it; clearing returns it to queue.
    let status = job.status;
    if (date && PRE_SCHEDULED.includes(job.status)) status = 'Scheduled';
    else if (!date) status = 'Ready to be scheduled';

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
      flash(date ? 'Next date set — planned crew released' : 'Returned to queue');
    } catch (e) { flash(`Could not save date: ${e.message}`); load(true); }
  };

  // Pull a job off the calendar and back into the queue: clear its date and
  // reset status to "Ready to be scheduled". Completed assignments stay frozen.
  const unschedule = async (job) => {
    setJobs((prev) => prev.map((j) => j.id === job.id
      ? { ...j, scheduledDate: null, status: 'Ready to be scheduled',
          assignments: j.assignments.map((a) => a.completed ? a : { ...a, workDate: null }) }
      : j));
    try {
      await track(() => api.updateJob(job.id, { scheduledDate: '', status: 'Ready to be scheduled' }));
      flash(`${job.name} unscheduled`);
    } catch (e) { flash(`Could not unschedule: ${e.message}`); load(true); }
  };

  const setStatus = useCallback(async (job, status) => {
    const offBoard = !BOARD_STATUSES.includes(status);
    setJobs((prev) => offBoard
      ? prev.filter((j) => j.id !== job.id)
      : prev.map((j) => j.id === job.id ? { ...j, status } : j));
    try {
      const result = await track(() => api.updateJob(job.id, { status }));
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

  // Takes the query explicitly rather than reading fsLink.query via closure —
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
      const result = await api.linkFsTask(jobId, fsTaskId);
      // Reload to pick up the FS status snapshot and any synced assignments
      await load(true);
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
        if (da.completed !== oa.completed) ch.completed = da.completed;
        if (Object.keys(ch).length > 0) await api.updateAssignment(da.assignmentId, ch);
      }
      // New assignments -- patch in the real assignmentId from each response
      // (same pattern as assign()) so a temp `_new_...` id never lingers in
      // state, where a later edit/remove on it would 404 against Salesforce.
      for (const na of draftJob.assignments.filter((a) => a._new)) {
        const resp = await api.addAssignment(draftJob.id, na.technicianId, na.workDate || '', na.startTime || '07:00');
        const created = resp.assignment;
        const realAssignment = created
          ? { assignmentId: created.assignmentId, technicianId: created.technicianId, technicianName: created.technicianName, workDate: created.workDate, startTime: created.startTime || '07:00', completed: created.completed }
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

  const cancelModal = () => setSelectedJobId(null);

  const oppTypes = useMemo(() =>
    [...new Set(jobs.map((j) => j.opportunityType).filter(Boolean))].sort()
  , [jobs]);

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
      if (jobType !== 'all' && j.opportunityType !== jobType) return false;
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
      if (jobType !== 'all' && j.opportunityType !== jobType) return false;
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

  // Re-attaches on every shown.length change (not just mount) — the sentinel
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
          <div className="glyph">C</div>
          <div><h1>CRS Dispatch</h1><span>Field Work Board</span></div>
        </div>
        <div className="bar-spacer" />
        <NotesMenu notes={notes} onRefresh={loadNotes} onNewNote={() => openNewNote()} onOpenNote={openNote} />
        <button className="refresh" onClick={() => setManageTechsOpen(true)} title="Add, edit, or remove technicians">Manage Techs</button>
        <button className="refresh" onClick={() => setTechLinksOpen(true)} title="Get a chalkboard sign-in link for a technician">Tech Links</button>
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
          }}
          title="Reload from Salesforce"
        >↻ Refresh</button>
        <div className="synced">
          <span className="dot" />
          <span className="lbl">Live · Salesforce</span>
          <SyncedAgo lastSync={lastSync} />
        </div>
      </header>

      <nav className="tabs">
        <button className={`tab ${tab === 'jobs' ? 'active' : ''}`} onClick={() => setTab('jobs')}>Outstanding Jobs</button>
        <button className={`tab ${tab === 'schedule' ? 'active' : ''}`} onClick={() => setTab('schedule')}>Tech Schedule</button>
        <button className={`tab ${tab === 'requests' ? 'active' : ''}`} onClick={() => setTab('requests')}>Requests</button>
        <button className={`tab ${tab === 'contacts' ? 'active' : ''}`} onClick={() => setTab('contacts')}>Contacts</button>
        <button className={`tab ${tab === 'accounts' ? 'active' : ''}`} onClick={() => setTab('accounts')}>Accounts</button>
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
              <div><h2>Outstanding field work</h2><p>Every job needing a tech, live from Salesforce. Changes save back instantly.</p></div>
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
              <span className="dash">–</span>
              <DatePicker value={closedTo} onChange={setClosedTo} placeholder="To" />
              <select
                className="ctlselect datepreset"
                defaultValue=""
                onChange={(e) => {
                  const value = e.target.value;
                  e.target.value = '';
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
              >
                <option value="">Range preset</option>
                <option value="ytd">Year to date</option>
                <option value="thisMonth">This month</option>
                <option value="lastMonth">Last month</option>
              </select>
              <button
                className="clearrange"
                onClick={() => { setClosedFrom(''); setClosedTo(''); }}
                disabled={!closedFrom && !closedTo}
              >Clear dates</button>
              {!closedFrom && !closedTo && <span className="rangestate">showing all time</span>}
            </div>
            <div className="datehint">Board loads opportunities by status; these dates only filter by Closed Date.</div>

            <div className="sortbar">
              <label className="sortgrp">
                <span className="rl">Sort</span>
                <select className="ctlselect" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                  <option value="scheduled">Scheduled date</option>
                  <option value="closedNew">closed — newest</option>
                  <option value="closedOld">closed — oldest</option>
                  <option value="lid">LID</option>
                  <option value="name">Job name</option>
                  <option value="fsStatus">FS status</option>
                </select>
              </label>
              <label className="sortgrp">
                <span className="rl">Tech</span>
                <select className="ctlselect" value={jobTech} onChange={(e) => setJobTech(e.target.value)}>
                  <option value="all">All</option>
                  <option value="unassigned">Unassigned</option>
                  {techs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
              {oppTypes.length > 0 && (
                <label className="sortgrp">
                  <span className="rl">Type</span>
                  <select className="ctlselect" value={jobType} onChange={(e) => setJobType(e.target.value)}>
                    <option value="all">All</option>
                    {oppTypes.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
              )}
              <label className="sortgrp">
                <span className="rl">FS status</span>
                <select className="ctlselect" value={jobFsStatus} onChange={(e) => setJobFsStatus(e.target.value)}>
                  <option value="all">All</option>
                  <option value="unlinked">Unlinked</option>
                  {fsStatuses.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
            </div>

            <div className="filters">
              {statuses.map(([s, count]) => (
                <button key={s} className={`chip ${filter === s ? 'on' : ''}`} onClick={() => setFilter(s)}>
                  {s === 'all' ? 'All outstanding' : s}<span className="ct">{count}</span>
                </button>
              ))}
              <span className="chipdiv" />
              {TERMINAL_STATUSES.map((s) => (
                <button key={s} className={`chip term ${filter === s ? 'on' : ''}`} onClick={() => setFilter(s)} title="Completed in Field Squared — view only">
                  {s}{filter === s && !extraLoading && <span className="ct">{shown.length}</span>}
                </button>
              ))}
            </div>

            <div className="jobs">
              {viewingTerminal && extraLoading && <div className="state">Loading completed jobs…</div>}
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

        {!loading && !error && tab === 'schedule' && <Schedule jobs={jobs} techs={techs} onJobClick={setSelectedJobId} />}
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
      </main>

      {toast && <div className="toast">{toast}<span className="tsf">→ Salesforce</span></div>}

      {draftJob && (
        <div className="modal-backdrop" onClick={cancelModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="modal-header">
              <div className="modal-title-row">
                <span className="jname">{draftJob.name}</span>
                {draftJob.lid && <span className="lidtag">LID {draftJob.lid}</span>}
                <select
                  className={`statussel ${draftJob.status ? statusClass(draftJob.status) : 'unset'}`}
                  value={draftJob.status}
                  onChange={(e) => setDraftJob((d) => ({ ...d, status: e.target.value }))}
                >
                  {!draftJob.status && <option value="">Pick a status…</option>}
                  {draftJob.status && !ASSIGNABLE_STATUSES.includes(draftJob.status) && <option value={draftJob.status}>{draftJob.status}</option>}
                  {ASSIGNABLE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <button className="modal-close" onClick={cancelModal} aria-label="Close">×</button>
            </div>
            <div className="modal-body">
              <div className="meta">
                <span><span className="ic">◍</span>{draftJob.address || 'No address'}</span>
                {draftJob.closeDate && <span className="created">Close Date {fmtDate(draftJob.closeDate)}</span>}
                <span className="nextlabel">Next scheduled</span>
                <span className="dateinput ro" title="Next scheduled assignment date">
                  {nextScheduledAssignmentDate(draftJob) ? fmtDate(nextScheduledAssignmentDate(draftJob)) : '—'}
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
                        title={a.completed ? 'Worked this day — click to reopen' : 'Mark as worked (freezes the date)'}
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
                  <select className="addtech" value="" onChange={(e) => {
                    const techId = e.target.value;
                    if (!techId) return;
                    e.target.value = '';
                    setDraftPendingAdd({ techId, date: draftJob.scheduledDate || '', time: '' });
                  }}>
                    <option value="">+ Add assignment</option>
                    {techs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  {draftPendingAdd.techId && (
                    <div className="inline-add">
                      <DatePicker className="dp-adate" value={draftPendingAdd.date || ''} onChange={(v) => setDraftPendingAdd((p) => ({ ...p, date: v }))} placeholder="Date" />
                      <TimePicker
                        className="atime"
                        value={draftPendingAdd.time || '07:00'}
                        onChange={(v) => setDraftPendingAdd((p) => ({ ...p, time: v }))}
                        title="Start time"
                        quickPicks={deriveTimeQuickPicks(draftJob.assignments)}
                      />
                      <button className="add-btn" onClick={() => {
                        const { techId, date, time } = draftPendingAdd;
                        const tech = techs.find((t) => t.id === techId);
                        setDraftJob((d) => ({
                          ...d,
                          assignments: [...d.assignments, {
                            assignmentId: `_new_${Date.now()}`,
                            technicianId: techId,
                            technicianName: tech?.name || '',
                            workDate: date || null,
                            startTime: time || '07:00',
                            completed: false,
                            _new: true,
                          }],
                        }));
                        setDraftPendingAdd({ techId: '', date: '', time: '' });
                      }}>Add</button>
                      <button className="cancel-btn" onClick={() => setDraftPendingAdd({ techId: '', date: '', time: '' })}>Cancel</button>
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

      {techLinksOpen && (
        <TechLinksModal techs={techs} onClose={() => setTechLinksOpen(false)} />
      )}

      {editingNote && (
        <NoteEditModal note={editingNote} jobs={jobs} onSaved={afterNoteChange} onDeleted={afterNoteChange} onClose={() => setEditingNote(null)} />
      )}
    </>
  );
}

function TechLinksModal({ techs, onClose }) {
  const [minting, setMinting] = useState(null); // technicianId currently being minted
  const [copiedId, setCopiedId] = useState(null); // technicianId just copied, brief confirmation

  const copyLink = async (tech) => {
    setMinting(tech.id);
    try {
      const { link } = await api.getTechLink(tech.id);
      await navigator.clipboard.writeText(link);
      setCopiedId(tech.id);
      setTimeout(() => setCopiedId((id) => (id === tech.id ? null : id)), 2000);
    } catch (e) {
      alert(`Could not get link: ${e.message}`);
    } finally {
      setMinting(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title-row"><span className="jname">Chalkboard sign-in links</span></div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          <p className="tech-links-hint">
            Each link is freshly minted and expires in 15 minutes. Nothing is stored, so there's nothing to revoke — copy a new one whenever a tech needs to sign in.
          </p>
          <div className="tech-links-list">
            {techs.map((t) => (
              <div className="tech-link-row" key={t.id}>
                <span className="tech-link-name">{t.name}</span>
                <button className="req-btn approve" onClick={() => copyLink(t)} disabled={minting === t.id}>
                  {minting === t.id ? 'Copying…' : copiedId === t.id ? 'Copied' : 'Copy Link'}
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-cancel-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// First non-blank line is the title shown in the notes list; the rest (if any)
// is a short preview snippet. Mirrors how Claude Code titles a chat from its
// first message — no separate title field to keep in sync.
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
      <button className="refresh" onClick={() => setOpen((o) => !o)} title="Shared team notes — visible to everyone on the board">
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
              <div className="notes-pop-empty">No notes yet — click "+ New note" to add one.</div>
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
                      <span className="notes-pop-job-tag">{note.opportunityName}</span>
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
    const base = jobs.map((j) => [j.id, j.lid ? `${j.name} — LID ${j.lid}` : j.name]);
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
            {/* Checkbox is purely derived from whether an opportunity is picked below — it's never toggled directly. */}
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
// (shown on the /tv warehouse calendar — a tech with no color set there
// falls back to a deterministic auto-generated one). "Remove" is a soft
// delete (Active__c = false via PATCH /technicians/:id) rather than an SF
// record delete, since Job_Assignment__c/Schedule_Request__c both hold
// lookups to Technician__c — removed techs stay listed here (with a
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
    fsUsers.map((u) => [u.externalId, u.userType ? `${u.name} — ${u.userType}` : u.name])
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

  const submitAdd = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    try {
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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-manage-techs" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title-row"><span className="jname">Manage technicians</span></div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          {loading ? (
            <span className="fs-users-loading">Loading technicians…</span>
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
                        <span className="fs-users-loading">Loading FS roster…</span>
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
                <span className="fs-users-loading">Loading FS roster…</span>
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
    const POP_WIDTH = Math.max(rect.width, 340);
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
    const close = (e) => { if (popRef.current?.contains(e.target)) return; setOpen(false); };
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

const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// Custom calendar dropdown replacing native <input type="date"> everywhere in the
// app — the native picker can't be restyled to match the rest of the site, so
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
  // coordinates — cards like .job use overflow:hidden for their rounded status
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

function ContactsTab({ contacts, loading, onRefresh, onUpdateContact }) {
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
  const [editing, setEditing] = useState(null); // { contactId, field, value }

  const startEdit = (contactId, field, value) => setEditing({ contactId, field, value: value ?? '' });

  const commitEdit = async () => {
    if (!editing) return;
    const { contactId, field, value } = editing;
    setEditing(null);
    try {
      await onUpdateContact(contactId, { [field]: value });
    } catch (e) {
      alert(`Could not save: ${e.message}`);
    }
  };

  const onEditKey = (e) => {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') setEditing(null);
  };

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

  // A new search/filter is a new list — start from the top, same as the
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
        <div><h2>Contacts</h2><p>{loading ? 'Loading…' : `${contacts.length} contacts from Salesforce`}</p></div>
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
        <div className="contacts-wrap">
          <table className="contacts-table">
            <thead>
              <tr><th>Name</th><th>Buildings</th><th>Phone</th><th>Email</th></tr>
            </thead>
            <tbody>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <tr key={i}>
                  <td><span className="skel-block" style={{ width: 120, height: 13, display: 'inline-block' }} /></td>
                  <td><span className="skel-block" style={{ width: 80, height: 13, display: 'inline-block' }} /></td>
                  <td><span className="skel-block" style={{ width: 90, height: 13, display: 'inline-block' }} /></td>
                  <td><span className="skel-block" style={{ width: 140, height: 13, display: 'inline-block' }} /></td>
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
        <div className="contacts-wrap">
          <table className="contacts-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Buildings</th>
                <th>Phone</th>
                <th>Email</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, visibleCount).map((c) => (
                <tr key={c.id}>
                  <td>
                    {editing?.contactId === c.id && editing?.field === 'name'
                      ? <div className="contact-edit-row">
                          <input className="contact-edit-input" autoFocus value={editing.value}
                            onChange={(e) => setEditing((s) => ({ ...s, value: e.target.value }))}
                            onKeyDown={onEditKey} />
                          <button className="contact-edit-save" onClick={commitEdit}>Save</button>
                          <button className="contact-edit-cancel" onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                      : <div className="contact-name contact-editable" onClick={() => startEdit(c.id, 'name', c.name)}>{c.name}</div>}
                    {c.company && <div className="contact-title">{c.company}</div>}
                    {c.title && <div className="contact-title">{c.title}</div>}
                  </td>
                  <td>
                    {c.accounts.length === 0
                      ? <span className="na">—</span>
                      : <div className="contact-buildings">
                          <button className="buildings-toggle" onClick={() => toggle(c.id)}>
                            <span className="buildings-chevron">{expanded.has(c.id) ? '▾' : '▸'}</span>
                            <span>{c.accounts.length} {c.accounts.length === 1 ? 'building' : 'buildings'}</span>
                          </button>
                          {expanded.has(c.id) && c.accounts.map((a) => (
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
                        </div>}
                  </td>
                  <td>
                    {editing?.contactId === c.id && editing?.field === 'phone'
                      ? <div className="contact-edit-row">
                          <input className="contact-edit-input" autoFocus type="tel" value={editing.value}
                            onChange={(e) => setEditing((s) => ({ ...s, value: formatPhone(e.target.value) }))}
                            onKeyDown={onEditKey} />
                          <button className="contact-edit-save" onClick={commitEdit}>Save</button>
                          <button className="contact-edit-cancel" onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                      : <span className="contact-editable" onClick={() => startEdit(c.id, 'phone', formatPhone(c.phone))}>
                          {c.phone ? <a href={`tel:${c.phone}`} className="contact-link" onClick={(e) => e.preventDefault()}>{formatPhone(c.phone)}</a> : <span className="na">—</span>}
                        </span>}
                  </td>
                  <td>
                    {editing?.contactId === c.id && editing?.field === 'email'
                      ? <div className="contact-edit-row">
                          <input className="contact-edit-input" autoFocus type="email" value={editing.value}
                            onChange={(e) => setEditing((s) => ({ ...s, value: e.target.value }))}
                            onKeyDown={onEditKey} />
                          <button className="contact-edit-save" onClick={commitEdit}>Save</button>
                          <button className="contact-edit-cancel" onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                      : <span className="contact-editable" onClick={() => startEdit(c.id, 'email', c.email)}>
                          {c.email ? <a href={`mailto:${c.email}`} className="contact-link" onClick={(e) => e.preventDefault()}>{c.email}</a> : <span className="na">—</span>}
                        </span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {visibleCount < filtered.length && <div ref={contactsSentinelRef} className="scroll-sentinel" />}
        </div>
      )}
    </section>
  );
}

function AccountsTab({ accounts, loading, contacts, onRefresh, onUpdateAccount, onUpdateContact }) {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [lidFilter, setLidFilter] = useState('');
  // Infinite scroll, same visibleCount + IntersectionObserver idiom as
  // ContactsTab / the outstanding-jobs list — accounts are already fully
  // fetched client-side, so this only caps how many rows are mounted.
  const [visibleCount, setVisibleCount] = useState(50);
  const accountsSentinelRef = useRef(null);
  const [expanded, setExpanded] = useState(new Set());
  const [changingContact, setChangingContact] = useState(null); // accountId being reassigned
  const [pickerQuery, setPickerQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null); // { accountId, field, value }
  // Id only, not a snapshot — so if the contact is edited (in this popup or
  // elsewhere) while it's open, the popup re-derives the latest record from
  // `contactsById` on every render instead of showing stale data.
  const [viewingContactId, setViewingContactId] = useState(null);
  // { accountId, kind: 'unpaid' | 'readyToBill' } | null — id-based for the
  // same reason as viewingContactId above.
  const [viewingBilling, setViewingBilling] = useState(null);

  const startEdit = (accountId, field, value) => setEditing({ accountId, field, value: value ?? '' });

  const commitEdit = async () => {
    if (!editing) return;
    const { accountId, field, value } = editing;
    setEditing(null);
    try {
      await onUpdateAccount(accountId, { [field]: value });
    } catch (e) {
      alert(`Could not save: ${e.message}`);
    }
  };

  const onEditKey = (e) => {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') setEditing(null);
  };

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

  const contactsById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const viewingContact = viewingContactId ? contactsById.get(viewingContactId) ?? null : null;
  const viewingBillingAccount = viewingBilling ? accounts.find((a) => a.id === viewingBilling.accountId) ?? null : null;

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

  const filtered = useMemo(() => accounts.filter((a) => {
    if (typeFilter && a.type !== typeFilter) return false;
    if (lidFilter && String(a.lid) !== lidFilter) return false;
    if (search.trim()) {
      const haystack = [a.name, a.street, a.city, a.state, a.zip].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(search.trim().toLowerCase())) return false;
    }
    return true;
  }), [accounts, search, typeFilter, lidFilter]);

  const hasFilter = search || typeFilter || lidFilter;

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

  // A new search/filter is a new list — start from the top, same as the
  // jobs list and ContactsTab do.
  useEffect(() => {
    setVisibleCount(50);
  }, [search, typeFilter, lidFilter]);

  useEffect(() => {
    const el = accountsSentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) setVisibleCount((c) => c + 50);
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [filtered.length]);

  const addressLine = (a) => [a.street, [a.city, a.state].filter(Boolean).join(', '), a.zip].filter(Boolean).join(' ') || null;

  const editableCell = (a, field, value, opts) => {
    const isEditing = editing?.accountId === a.id && editing?.field === field;
    if (isEditing) {
      return (
        <div className="contact-edit-row">
          <input
            className="contact-edit-input"
            autoFocus
            type={opts?.type ?? 'text'}
            value={editing.value}
            onChange={(e) => setEditing((s) => ({ ...s, value: opts?.format ? opts.format(e.target.value) : e.target.value }))}
            onKeyDown={onEditKey}
          />
          <button className="contact-edit-save" onClick={commitEdit}>Save</button>
          <button className="contact-edit-cancel" onClick={() => setEditing(null)}>Cancel</button>
        </div>
      );
    }
    return (
      <span className="contact-editable" onClick={() => startEdit(a.id, field, value)}>
        {value ? value : <span className="na">—</span>}
      </span>
    );
  };

  return (
    <section>
      <div className="view-head">
        <div><h2>Accounts</h2><p>{loading ? 'Loading…' : `${accounts.length} accounts from Salesforce`}</p></div>
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
        {hasFilter && (
          <button className="clearrange" onClick={() => { setSearch(''); setTypeFilter(''); setLidFilter(''); }}>
            Clear filters
          </button>
        )}
        {!loading && <span className="contact-count">{filtered.length} shown</span>}
      </div>

      {loading && (
        <div className="contacts-wrap">
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
      {!loading && filtered.length > 0 && (
        <div className="contacts-wrap">
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
              {filtered.slice(0, visibleCount).map((a) => (
                <React.Fragment key={a.id}>
                  <tr>
                    <td>
                      <span className="contact-name">{a.name}</span>
                      <div>
                        <button className="buildings-toggle" onClick={() => toggle(a.id)}>
                          <span className="buildings-chevron">{expanded.has(a.id) ? '▾' : '▸'}</span>
                          <span>Details</span>
                        </button>
                      </div>
                    </td>
                    <td>{a.type ?? <span className="na">—</span>}</td>
                    <td>{a.lid ? <span className="lidtag">LID {a.lid}</span> : <span className="na">—</span>}</td>
                    <td>{addressLine(a) ?? <span className="na">—</span>}</td>
                    <td>
                      {editing?.accountId === a.id && editing?.field === 'phone'
                        ? <div className="contact-edit-row">
                            <input className="contact-edit-input" autoFocus type="tel" value={editing.value}
                              onChange={(e) => setEditing((s) => ({ ...s, value: formatPhone(e.target.value) }))}
                              onKeyDown={onEditKey} />
                            <button className="contact-edit-save" onClick={commitEdit}>Save</button>
                            <button className="contact-edit-cancel" onClick={() => setEditing(null)}>Cancel</button>
                          </div>
                        : <span className="contact-editable" onClick={() => startEdit(a.id, 'phone', formatPhone(a.phone))}>
                            {a.phone ? <a href={`tel:${a.phone}`} className="contact-link" onClick={(e) => e.preventDefault()}>{formatPhone(a.phone)}</a> : <span className="na">—</span>}
                          </span>}
                    </td>
                    <td>
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
                    </td>
                  </tr>
                  {expanded.has(a.id) && (
                    <tr className="contact-building-row">
                      <td colSpan={6}>
                        <div className="contact-building-meta" style={{ flexWrap: 'wrap', gap: '1.5rem' }}>
                          <span>Street: {editableCell(a, 'street', a.street)}</span>
                          <span>City: {editableCell(a, 'city', a.city)}</span>
                          <span>State: {editableCell(a, 'state', a.state)}</span>
                          <span>Zip: {editableCell(a, 'zip', a.zip)}</span>
                          <span>Website: {editableCell(a, 'website', a.website)}</span>
                          <span>Industry: {editableCell(a, 'industry', a.industry)}</span>
                          <span>Management company: {a.parentName ?? <span className="na">—</span>}</span>
                          <span>
                            Property contact: {a.propertyContactName
                              ? <button className="linklike" onClick={() => setViewingContactId(a.propertyContactId)}>{a.propertyContactName}</button>
                              : <span className="na">—</span>}{' '}
                            <button
                              className="change-contact-btn"
                              onClick={() => {
                                setChangingContact(changingContact === a.id ? null : a.id);
                                setPickerQuery('');
                              }}
                            >
                              Change contact
                            </button>
                          </span>
                        </div>
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
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
          {visibleCount < filtered.length && <div ref={accountsSentinelRef} className="scroll-sentinel" />}
        </div>
      )}
      {viewingContact && (
        <ContactInfoModal
          contact={viewingContact}
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
    </section>
  );
}

function BillingJobsModal({ account, kind, onClose }) {
  const jobs = kind === 'unpaid' ? account.unpaidJobs : account.readyToBillJobs;
  const title = kind === 'unpaid' ? 'Overdue' : 'Ready to Bill';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title-row"><span className="jname">{title} — {account.name}</span></div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          {jobs.map((j) => <div key={j.id} className="contact-title">{j.name}</div>)}
        </div>
        <div className="modal-footer">
          <div className="modal-footer-spacer" />
          <button className="modal-cancel-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function ContactInfoModal({ contact, onUpdateContact, onClose }) {
  const [editing, setEditing] = useState(null); // { field, value }

  const startEdit = (field, value) => setEditing({ field, value: value ?? '' });

  const commitEdit = async () => {
    if (!editing) return;
    const { field, value } = editing;
    setEditing(null);
    try {
      await onUpdateContact(contact.id, { [field]: value });
    } catch (e) {
      alert(`Could not save: ${e.message}`);
    }
  };

  // Escape here is "cancel this field's edit," not "close the popup" — stop
  // it from also reaching the parent's close-on-Escape listener.
  const onEditKey = (e) => {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); }
  };

  const editableField = (field, value, opts) => {
    if (editing?.field === field) {
      return (
        <div className="contact-edit-row">
          <input
            className="contact-edit-input"
            autoFocus
            type={opts?.type ?? 'text'}
            value={editing.value}
            onChange={(e) => setEditing((s) => ({ ...s, value: opts?.format ? opts.format(e.target.value) : e.target.value }))}
            onKeyDown={onEditKey}
          />
          <button className="contact-edit-save" onClick={commitEdit}>Save</button>
          <button className="contact-edit-cancel" onClick={() => setEditing(null)}>Cancel</button>
        </div>
      );
    }
    return (
      <span className="contact-editable" onClick={() => startEdit(field, value)}>
        {value ? value : <span className="na">{opts?.placeholder ?? '—'}</span>}
      </span>
    );
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title-row">{editableField('name', contact.name)}</div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          <div className="contact-title">{editableField('title', contact.title, { placeholder: 'Add title' })}</div>
          {contact.company && <div className="contact-title">{contact.company}</div>}
          <div>
            {editing?.field === 'phone'
              ? <div className="contact-edit-row">
                  <input className="contact-edit-input" autoFocus type="tel" value={editing.value}
                    onChange={(e) => setEditing((s) => ({ ...s, value: formatPhone(e.target.value) }))}
                    onKeyDown={onEditKey} />
                  <button className="contact-edit-save" onClick={commitEdit}>Save</button>
                  <button className="contact-edit-cancel" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              : <span className="contact-editable" onClick={() => startEdit('phone', formatPhone(contact.phone))}>
                  {contact.phone ? <a href={`tel:${contact.phone}`} className="contact-link" onClick={(e) => e.preventDefault()}>{formatPhone(contact.phone)}</a> : <span className="na">Add phone</span>}
                </span>}
          </div>
          <div>
            {editing?.field === 'email'
              ? <div className="contact-edit-row">
                  <input className="contact-edit-input" autoFocus type="email" value={editing.value}
                    onChange={(e) => setEditing((s) => ({ ...s, value: e.target.value }))}
                    onKeyDown={onEditKey} />
                  <button className="contact-edit-save" onClick={commitEdit}>Save</button>
                  <button className="contact-edit-cancel" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              : <span className="contact-editable" onClick={() => startEdit('email', contact.email)}>
                  {contact.email ? <a href={`mailto:${contact.email}`} className="contact-link" onClick={(e) => e.preventDefault()}>{contact.email}</a> : <span className="na">Add email</span>}
                </span>}
          </div>
        </div>
        <div className="modal-footer">
          <div className="modal-footer-spacer" />
          <button className="modal-cancel-btn" onClick={onClose}>Close</button>
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

  const jobLabel = req.isTimeOff ? 'Time off' : req.isNewWo ? 'New WO Required' : (req.jobName || '—');
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
    label: req.isTimeOff ? 'Time off' : req.isNewWo ? 'New WO Required' : (req.jobName || '—'),
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
  // Oldest first — age is the pressure that keeps the approve/counter/deny loop moving.
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
            {previousLoading && <div className="state">Loading previous requests…</div>}
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

const CLOSED_LIST_STATUSES = ['Pending Customer Approval', 'Quoted', 'Parts Ordered', 'Ready to be scheduled'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function Schedule({ jobs, techs, onJobClick }) {
  const [mode, setMode] = useState('week');
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [techFilter, setTechFilter] = useState('all');
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [expandedMonths, setExpandedMonths] = useState(() => Array(12).fill(false));

  // Approved time off is invisible to the jobs API (the sentinel opp isn't in
  // jobStatusValues), so it's fetched separately here — once, shared by both
  // Week and Month views — for whichever range is currently in view.
  const [timeOff, setTimeOff] = useState([]);
  const [editingOff, setEditingOff] = useState(null);
  const [addingOff, setAddingOff] = useState(false);

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
        <button className="refresh" onClick={() => setAddingOff(true)}>+ Add Time Off</button>
      </div>

      <div className="schedbar">
        <div className="navbtns">
          <button className="navbtn" onClick={() => shift(-1)} aria-label="Previous">‹</button>
          <button className="navbtn" onClick={() => setAnchor(startOfDay(new Date()))}>Today</button>
          <button className="navbtn" onClick={() => shift(1)} aria-label="Next">›</button>
        </div>
        <div className="rangelabel">{rangeLabel(mode, anchor)}</div>
        <select className="techfilter" value={techFilter} onChange={(e) => setTechFilter(e.target.value)}>
          <option value="all">All technicians</option>
          {techs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
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
    </section>
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
    const results = await Promise.allSettled(dates.map((d) => api.addTimeOff(technicianId, d, start, end)));
    const failed = results.map((r, i) => (r.status === 'rejected' ? dates[i] : null)).filter(Boolean);

    if (failed.length === dates.length) {
      setErr('Could not add time off. Nothing was saved.');
      setSaving(false);
      return;
    }
    if (failed.length > 0) {
      setErr(`Saved ${dates.length - failed.length} of ${dates.length} day(s) — failed: ${failed.join(', ')}.`);
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
            <select className="techfilter" value={technicianId} onChange={(e) => setTechnicianId(e.target.value)}>
              <option value="">Select a technician…</option>
              {techs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
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

  // techId -> iso -> [{ name, startTime }], sorted by start time
  const grid = useMemo(() => {
    const m = {};
    jobs.forEach((job) => job.assignments.forEach((a) => {
      if (!a.workDate) return; // unscheduled assignment — not on the calendar
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
  // for whatever range — week or month — is currently in view).
  const timeOffByTechDate = useMemo(() => {
    const m = {};
    timeOff.forEach((r) => {
      if (!r.technicianId || !r.workDate) return;
      (m[r.technicianId] ||= {})[r.workDate] = r;
    });
    return m;
  }, [timeOff]);

  return (
    <div className="grid-wrap">
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
                const off = timeOffByTechDate[t.id]?.[iso];
                const cls = `${items.length || off ? '' : 'open'} ${iso === todayIso ? 'todaycol' : ''} ${off ? 'offcol' : ''}`.trim();
                return (
                  <td key={iso} className={cls}>
                    {off && (
                      <div className="offchip" title="Approved time off — click to edit" onClick={() => onEditOff(off)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onEditOff(off)}>
                        Off
                      </div>
                    )}
                    {items.length === 0 && !off && <span className="free">✓ Open</span>}
                    {items.map((item, i) => (
                      <div className={`jchip${item.completed ? ' done' : ''}`} key={i} onClick={() => onJobClick(item.jobId)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onJobClick(item.jobId)}>
                        {item.completed && <span className="jdone-mark" title="Worked">✓</span>}
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
  );
}

function MonthGrid({ jobs, anchor, techFilter, onJobClick, timeOff, onEditOff }) {
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
              <div className="dayoff" key={r.id} title={`${r.technicianName} — time off, click to edit`} onClick={() => onEditOff(r)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onEditOff(r)}>
                <span className="jn">{r.technicianName}</span>
              </div>
            ))}
            {items.map((j) => (
              <div className="dayjob" data-status={statusClass(j.status)} key={j.id} title={j.name} onClick={() => onJobClick(j.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onJobClick(j.id)}>
                <span className="jn">{j.name.split('—')[0].trim()}</span>
                {j.assignments.length > 0 && <span className="inits">{j.assignments.map((a) => initials(a.technicianName)).join(' ')}</span>}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}