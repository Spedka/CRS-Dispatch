import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { api } from './api.js';

// Map your real status strings to a color treatment. Unknown -> neutral.
const STATUS_CLASS = {
  'Pending Customer Approval': 'scheduled',
  'Quoted': 'scheduled',
  'Parts Ordered': 'needs',
  'Ready to be scheduled': 'needs',   // amber — needs a tech assigned
  'Scheduled': 'scheduled',           // blue — booked
  'In Progress': 'dispatched',        // indigo — tech on site
  'Installation Complete': 'dispatched',
  'Waiting on Payment': 'emergency',  // red — done, awaiting payment
  'Billing Complete': 'scheduled',
  'Project Complete': 'scheduled',
};
const statusClass = (s) => STATUS_CLASS[s] || 'scheduled';

// Terminal statuses leave the board. They're set in Field Squared, never here,
// so they're not offered in the dropdown — you can only VIEW them via a filter.
const TERMINAL_STATUSES = ['Billing Complete', 'Project Complete'];

// Everything that stays on the board (mirrors config.jobStatusValues).
const BOARD_STATUSES = [
  'Pending Customer Approval', 'Quoted', 'Parts Ordered', 'Ready to be scheduled',
  'Scheduled', 'In Progress', 'Installation Complete', 'Waiting on Payment',
];
// A dispatcher can set any board status. Billing/Project Complete are excluded —
// those happen in Field Squared. Strings must match the Salesforce picklist EXACTLY.
const ASSIGNABLE_STATUSES = BOARD_STATUSES;

const POLL_MS = 5 * 60 * 1000; // refresh from Salesforce every 5 minutes

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

function fmtDate(iso) {
  if (!iso) return null;
  return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
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
  if (assignments.length === 0) return { status: 'Ready to be scheduled', scheduledDate: '' };
  if (assignments.every((a) => a.completed)) return { status: 'Installation Complete', scheduledDate: '' };
  return { status: 'Ready to be scheduled', scheduledDate: '' };
}

export default function App() {
  const [tab, setTab] = useState('jobs');
  const [jobs, setJobs] = useState([]);
  const [techs, setTechs] = useState([]);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [closedFrom, setClosedFrom] = useState('');
  const [closedTo, setClosedTo] = useState('');
  const [sortBy, setSortBy] = useState('scheduled');
  const [jobTech, setJobTech] = useState('all');
  const [extraJobs, setExtraJobs] = useState([]);   // jobs fetched for a terminal-status filter
  const [extraLoading, setExtraLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [lastSync, setLastSync] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [pendingAdd, setPendingAdd] = useState({ jobId: null, techId: '', date: '', time: '' });
  const [selectedJobId, setSelectedJobId] = useState(null);
  const [fsLink, setFsLink] = useState({ jobId: null, query: '', searching: false, matches: null, error: null });
  const [draftJob, setDraftJob] = useState(null);
  const [draftPendingAdd, setDraftPendingAdd] = useState({ techId: '', date: '', time: '' });
  const [modalSaving, setModalSaving] = useState(false);

  // Count of in-flight writes. While > 0 the poll holds off so a background
  // refresh can't overwrite a change you just made but that hasn't saved yet.
  const pending = useRef(0);

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
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (closedFrom && !closedTo) {
      setClosedTo(todayIso());
    }
  }, [closedFrom, closedTo]);

  useEffect(() => {
    const id = setInterval(() => { if (pending.current === 0) load(true); }, POLL_MS);
    return () => clearInterval(id);
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
      setModalSaving(false);
    }
  }, [selectedJobId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
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

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2200); };

  const track = async (fn) => {
    pending.current += 1;
    try { return await fn(); }
    finally { pending.current -= 1; }
  };

  const assign = async (job, technicianId, workDate, startTime = '07:00') => {
    const tech = techs.find((t) => t.id === technicianId);
    try {
        console.debug('[APP] assign()', { oppId: job.id, technicianId, workDate, startTime });
        const resp = await track(() => api.addAssignment(job.id, technicianId, workDate, startTime));
      const assignmentId = resp.assignmentId;
      const created = resp.assignment;
      const newAssignment = created ?
        { assignmentId: created.assignmentId, technicianId: created.technicianId, technicianName: created.technicianName, workDate: created.workDate, startTime: created.startTime || '07:00', completed: created.completed }
        : { assignmentId, technicianId, technicianName: tech?.name, workDate: workDate || null, startTime: startTime || '07:00', completed: false };
      const updated = {
        ...job,
        assignments: [...job.assignments, newAssignment],
      };
      const derived = deriveJobStatusFromAssignments(updated);
      setJobs((prev) => prev.map((j) => j.id === job.id ? { ...updated, ...derived } : j));
      await track(() => api.updateJob(job.id, { ...derived, _suppressRelease: true }));
      flash(`${tech?.name} added to ${job.name}`);
    } catch (e) { flash(`Could not assign: ${e.message}`); }
  };

  const unassign = async (job, assignmentId) => {
    const updatedAssignments = job.assignments.filter((a) => a.assignmentId !== assignmentId);
    const updatedJob = { ...job, assignments: updatedAssignments };
    const { status, scheduledDate } = deriveJobStatusFromAssignments(updatedJob);
    setJobs((prev) => prev.map((j) => j.id === job.id ? { ...updatedJob, status, scheduledDate } : j));
    try {
      await track(() => api.removeAssignment(assignmentId));
      await track(() => api.updateJob(job.id, { status, scheduledDate, _suppressRelease: true }));
      flash('Tech removed');
    } catch (e) { flash(`Could not remove: ${e.message}`); load(true); }
  };

  // Mark/unmark a tech's work as actually done. Completed assignments freeze on
  // their date (real history) and won't move when the job is rescheduled.
  const toggleDone = async (job, a) => {
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
  };

  // Edit a single assignment's own date.
  const setAssignmentDate = async (job, a, date) => {
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
    } catch (e) { flash(`Could not save date: ${e.message}`); load(true); }
  };

  const setAssignmentTime = async (job, a, time) => {
    const t = time || '07:00';
    const updatedJob = {
      ...job,
      assignments: job.assignments.map((x) => x.assignmentId === a.assignmentId ? { ...x, startTime: t } : x),
    };
    setJobs((prev) => prev.map((j) => j.id === job.id ? updatedJob : j));
    try {
      await track(() => api.updateAssignment(a.assignmentId, { startTime: t }));
    } catch (e) { flash(`Could not save time: ${e.message}`); load(true); }
  };

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

  const setStatus = async (job, status) => {
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
  };

  const openFsLink = (jobId) => setFsLink({ jobId, query: '', searching: false, matches: null, error: null });
  const closeFsLink = () => setFsLink({ jobId: null, query: '', searching: false, matches: null, error: null });

  const searchFs = async () => {
    if (fsLink.query.trim().length < 3) return;
    setFsLink((s) => ({ ...s, searching: true, matches: null, error: null }));
    try {
      const { matches } = await api.searchFsTasks(fsLink.query.trim());
      setFsLink((s) => ({ ...s, searching: false, matches }));
    } catch (e) {
      setFsLink((s) => ({ ...s, searching: false, error: e.message }));
    }
  };

  const confirmFsLink = async (fsTaskId, fsTaskName) => {
    const jobId = fsLink.jobId;
    closeFsLink();
    try {
      await api.linkFsTask(jobId, fsTaskId);
      setJobs((prev) => prev.map((j) => j.id === jobId ? { ...j, fsTaskId } : j));
      flash(`Linked to "${fsTaskName}"`);
    } catch (e) {
      flash(`Link failed: ${e.message}`);
    }
  };

  const saveModal = async () => {
    const originalJob = jobs.find((j) => j.id === selectedJobId);
    if (!originalJob || !draftJob) return;
    setModalSaving(true);
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
      // New assignments
      for (const na of draftJob.assignments.filter((a) => a._new)) {
        await api.addAssignment(draftJob.id, na.technicianId, na.workDate || '', na.startTime || '07:00');
      }
      // Sync Opportunity status + scheduledDate
      const derived = deriveJobStatusFromAssignments(draftJob);
      const finalStatus = draftJob.status !== originalJob.status ? draftJob.status : derived.status;
      await api.updateJob(draftJob.id, { status: finalStatus, scheduledDate: derived.scheduledDate, _suppressRelease: true });
      setSelectedJobId(null);
      await load(true);
      flash('Changes saved');
    } catch (e) {
      flash(`Save failed: ${e.message}`);
      setModalSaving(false);
    }
  };

  const cancelModal = () => setSelectedJobId(null);

  const filteredJobs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs.filter((j) => {
      if (!(q === '' || j.name.toLowerCase().includes(q))) return false;
      if (jobTech === 'unassigned' && j.assignments.length > 0) return false;
      if (jobTech !== 'all' && jobTech !== 'unassigned'
          && !j.assignments.some((a) => a.technicianId === jobTech)) return false;
      if (closedFrom || closedTo) {
        const cd = dateOnlyISO(j.closeDate);
        if (!cd) return false;
        if (closedFrom && cd < closedFrom) return false;
        if (closedTo && cd > closedTo) return false;
      }
      return true;
    });
  }, [jobs, query, jobTech, closedFrom, closedTo]);

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
      if (!(q === '' || j.name.toLowerCase().includes(q))) return false;
      if (jobTech === 'unassigned' && j.assignments.length > 0) return false;
      if (jobTech !== 'all' && jobTech !== 'unassigned'
          && !j.assignments.some((a) => a.technicianId === jobTech)) return false;
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
    };
    return [...filtered].sort(sorters[sortBy] || sorters.scheduled);
  }, [jobs, extraJobs, viewingTerminal, filter, query, jobTech, closedFrom, closedTo, sortBy]);

  return (
    <>
      <div className="topline" />
      <header className="bar">
        <div className="wordmark">
          <div className="glyph">C</div>
          <div><h1>CRS Dispatch</h1><span>Field Work Board</span></div>
        </div>
        <div className="bar-spacer" />
        <button className="refresh" onClick={() => load()} title="Reload from Salesforce">↻ Refresh</button>
        <div className="synced">
          <span className="dot" />
          <span className="lbl">Live · Salesforce</span>
          <span className="ago">{lastSync ? fmtAgo(now - lastSync) : '…'}</span>
        </div>
      </header>

      <nav className="tabs">
        <button className={`tab ${tab === 'jobs' ? 'active' : ''}`} onClick={() => setTab('jobs')}>Outstanding Jobs</button>
        <button className={`tab ${tab === 'schedule' ? 'active' : ''}`} onClick={() => setTab('schedule')}>Tech Schedule</button>
      </nav>

      <main>
        {loading && <div className="state">Loading from Salesforce…</div>}
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
                placeholder="Search jobs by name…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            <div className="rangefilter">
              <span className="rl">Closed</span>
              <input className="dateinput" type="date" value={closedFrom} onChange={(e) => setClosedFrom(e.target.value)} title="Closed from" />
              <span className="dash">–</span>
              <input className="dateinput" type="date" value={closedTo} onChange={(e) => setClosedTo(e.target.value)} title="Closed to" />
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
              {!extraLoading && shown.map((job) => {
                if (viewingTerminal) {
                  return (
                    <div className="job ro" key={job.id}>
                      <div className="stripe" data-status={statusClass(job.status)} />
                      <div className="body">
                        <div className="row1">
                          <span className="jname">{job.name}</span>
                          {job.lid && <span className="lidtag">LID {job.lid}</span>}
                          {job.fsTaskId
                            ? <span className="fs-badge linked" title={`FS task: ${job.fsTaskId}`}>⬡ FS</span>
                            : <span className="fs-badge unlinked" title="No Field Squared task linked">⬡ FS</span>}
                          <span className={`badge ${statusClass(job.status)}`}>{job.status}</span>
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
                return (
                  <div className="job" key={job.id}>
                    <div className="stripe" data-status={statusClass(job.status)} />
                    <div className="body">
                      <div className="row1">
                        <span className="jname">{job.name}</span>
                        {job.lid && <span className="lidtag">LID {job.lid}</span>}
                        {job.fsTaskId
                          ? <span className="fs-badge linked" title={`FS task: ${job.fsTaskId}`}>⬡ FS</span>
                          : <button className="fs-badge unlinked fs-attach-btn" title="Attach Field Squared job" onClick={() => fsLink.jobId === job.id ? closeFsLink() : openFsLink(job.id)}>⬡ Attach FS</button>}
                        <select
                          className={`statussel ${statusClass(job.status)}`}
                          value={job.status}
                          onChange={(e) => setStatus(job, e.target.value)}
                        >
                          {!ASSIGNABLE_STATUSES.includes(job.status) && <option value={job.status}>{job.status}</option>}
                          {ASSIGNABLE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </div>
                      {fsLink.jobId === job.id && (
                        <div className="fs-attach-panel">
                          <div className="fs-attach-row">
                            <input
                              className="fs-attach-input"
                              type="text"
                              placeholder="Type part of the FS job name…"
                              value={fsLink.query}
                              onChange={(e) => setFsLink((s) => ({ ...s, query: e.target.value }))}
                              onKeyDown={(e) => e.key === 'Enter' && searchFs()}
                              autoFocus
                            />
                            <button className="add-btn" onClick={searchFs} disabled={fsLink.searching || fsLink.query.trim().length < 3}>
                              {fsLink.searching ? '…' : 'Search'}
                            </button>
                            <button className="cancel-btn" onClick={closeFsLink}>Cancel</button>
                          </div>
                          {fsLink.error && <div className="fs-attach-error">{fsLink.error}</div>}
                          {fsLink.matches !== null && fsLink.matches.length === 0 && (
                            <div className="fs-attach-empty">No FS tasks match that name.</div>
                          )}
                          {fsLink.matches && fsLink.matches.map((m) => (
                            <div className="fs-attach-result" key={m.externalId}>
                              <div className="fs-result-name">{m.name}</div>
                              <div className="fs-result-meta">{m.taskType} · {m.status}</div>
                              <button className="add-btn" onClick={() => confirmFsLink(m.externalId, m.name)}>Link</button>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="meta">
                        <span><span className="ic">◍</span>{job.address || 'No address'}</span>
                        {job.closeDate && <span className="created">Close Date {fmtDate(job.closeDate)}</span>}
                        <span className="nextlabel">Next scheduled</span>
                        <input
                          className="dateinput"
                          type="date"
                          value={nextScheduledAssignmentDate(job)}
                          readOnly
                          title="Next scheduled assignment date"
                        />
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
                                onClick={() => toggleDone(job, a)}
                                title={a.completed ? 'Worked this day — click to reopen' : 'Mark as worked (freezes the date)'}
                                aria-label="Toggle done"
                              >{a.completed ? '✓' : '○'}</button>
                              <span className="aname">{a.technicianName || 'Tech'}</span>
                              <input
                                className="adate"
                                type="date"
                                value={a.workDate || ''}
                                onChange={(e) => setAssignmentDate(job, a, e.target.value)}
                                title="Assignment date"
                              />
                              <input
                                className="atime"
                                type="time"
                                defaultValue={a.startTime || '07:00'}
                                onBlur={(e) => { if (e.target.value) setAssignmentTime(job, a, e.target.value); }}
                                title="Start time"
                                disabled={a.completed}
                                key={a.assignmentId + (a.startTime || '07:00')}
                              />
                              {!a.workDate && !a.completed && <span className="untag">unscheduled</span>}
                              <button className="x" onClick={() => unassign(job, a.assignmentId)} aria-label="Remove">×</button>
                            </div>
                          );
                        })}
                        <div>
                          <select className="addtech" value="" onChange={(e) => {
                            const techId = e.target.value;
                            if (!techId) return;
                            e.target.value = '';
                            setPendingAdd({ jobId: job.id, techId, date: job.scheduledDate || '', time: '' });
                          }}>
                            <option value="">+ Add assignment</option>
                            {techs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                          </select>
                          {pendingAdd.jobId === job.id && (
                            <div className="inline-add">
                              <input className="adate" type="date" value={pendingAdd.date || ''} onChange={(e) => setPendingAdd((p) => ({ ...p, date: e.target.value }))} />
                              <input className="atime" type="time" value={pendingAdd.time || '07:00'} onChange={(e) => setPendingAdd((p) => ({ ...p, time: e.target.value }))} title="Start time" />
                              <button className="add-btn" onClick={async () => {
                                const { techId, date, time } = pendingAdd;
                                setPendingAdd({ jobId: null, techId: '', date: '', time: '' });
                                await assign(job, techId, date || '', time || '07:00');
                              }}>Add</button>
                              <button className="cancel-btn" onClick={() => setPendingAdd({ jobId: null, techId: '', date: '', time: '' })}>Cancel</button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {!loading && !error && tab === 'schedule' && <Schedule jobs={jobs} techs={techs} onJobClick={setSelectedJobId} />}
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
                  className={`statussel ${statusClass(draftJob.status)}`}
                  value={draftJob.status}
                  onChange={(e) => setDraftJob((d) => ({ ...d, status: e.target.value }))}
                >
                  {!ASSIGNABLE_STATUSES.includes(draftJob.status) && <option value={draftJob.status}>{draftJob.status}</option>}
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
                <input className="dateinput" type="date" value={nextScheduledAssignmentDate(draftJob)} readOnly title="Next scheduled assignment date" />
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
                        onClick={() => setDraftJob((d) => ({ ...d, assignments: d.assignments.map((x) => x.assignmentId === a.assignmentId ? { ...x, completed: !x.completed } : x) }))}
                        title={a.completed ? 'Worked this day — click to reopen' : 'Mark as worked (freezes the date)'}
                        aria-label="Toggle done"
                      >{a.completed ? '✓' : '○'}</button>
                      <span className="aname">{a.technicianName || 'Tech'}</span>
                      <input
                        className="adate"
                        type="date"
                        value={a.workDate || ''}
                        onChange={(e) => setDraftJob((d) => ({ ...d, assignments: d.assignments.map((x) => x.assignmentId === a.assignmentId ? { ...x, workDate: e.target.value || null } : x) }))}
                        title="Assignment date"
                      />
                      <input
                        className="atime"
                        type="time"
                        value={a.startTime || '07:00'}
                        onChange={(e) => setDraftJob((d) => ({ ...d, assignments: d.assignments.map((x) => x.assignmentId === a.assignmentId ? { ...x, startTime: e.target.value || '07:00' } : x) }))}
                        title="Start time"
                        disabled={a.completed}
                      />
                      {!a.workDate && !a.completed && <span className="untag">unscheduled</span>}
                      <button
                        className="x"
                        onClick={() => setDraftJob((d) => ({ ...d, assignments: d.assignments.filter((x) => x.assignmentId !== a.assignmentId) }))}
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
                      <input className="adate" type="date" value={draftPendingAdd.date || ''} onChange={(e) => setDraftPendingAdd((p) => ({ ...p, date: e.target.value }))} />
                      <input className="atime" type="time" value={draftPendingAdd.time || '07:00'} onChange={(e) => setDraftPendingAdd((p) => ({ ...p, time: e.target.value }))} title="Start time" />
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
              <button className="modal-save-btn" onClick={saveModal} disabled={modalSaving}>
                {modalSaving ? 'Saving…' : 'Save changes'}
              </button>
              <button className="modal-cancel-btn" onClick={cancelModal} disabled={modalSaving}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
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
        ? <WeekGrid jobs={jobs} techs={techs} anchor={anchor} techFilter={techFilter} onJobClick={onJobClick} />
        : <MonthGrid jobs={jobs} anchor={anchor} techFilter={techFilter} onJobClick={onJobClick} />}
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
    </section>
  );
}

function WeekGrid({ jobs, techs, anchor, techFilter, onJobClick }) {
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
      ((m[a.technicianId] ||= {})[a.workDate] ||= []).push({ name: job.name, startTime: a.startTime || '07:00', jobId: job.id });
    }));
    // sort each cell by start time
    Object.values(m).forEach((byDate) =>
      Object.values(byDate).forEach((items) => items.sort((a, b) => a.startTime.localeCompare(b.startTime)))
    );
    return m;
  }, [jobs]);

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
                const cls = `${items.length ? '' : 'open'} ${iso === todayIso ? 'todaycol' : ''}`.trim();
                return (
                  <td key={iso} className={cls}>
                    {items.length === 0
                      ? <span className="free">✓ Open</span>
                      : items.map((item, i) => (
                          <div className="jchip" key={i} onClick={() => onJobClick(item.jobId)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onJobClick(item.jobId)}>
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

function MonthGrid({ jobs, anchor, techFilter, onJobClick }) {
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

  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div className="month">
      {WD.map((w) => <div className="wd" key={w}>{w}</div>)}
      {cells.map((d) => {
        const iso = isoOf(d);
        const out = d.getMonth() !== month;
        const items = byDate[iso] || [];
        return (
          <div className={`daycell ${out ? 'out' : ''} ${iso === todayIso ? 'today' : ''}`} key={iso}>
            <div className="daynum">{d.getDate()}</div>
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