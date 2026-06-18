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
  if (!iso) return 'No date';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `synced ${s}s ago`;
  return `synced ${Math.floor(s / 60)}m ago`;
}

// CreatedDate is a full ISO datetime from Salesforce — show just the date.
function fmtCreated(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
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
  const [createdFrom, setCreatedFrom] = useState('');
  const [createdTo, setCreatedTo] = useState('');
  const [sortBy, setSortBy] = useState('scheduled');
  const [jobTech, setJobTech] = useState('all');
  const [extraJobs, setExtraJobs] = useState([]);   // jobs fetched for a terminal-status filter
  const [extraLoading, setExtraLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [lastSync, setLastSync] = useState(null);
  const [now, setNow] = useState(Date.now());

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
    if (createdFrom && !createdTo) {
      setCreatedTo(todayIso());
    }
  }, [createdFrom, createdTo]);

  useEffect(() => {
    const id = setInterval(() => { if (pending.current === 0) load(true); }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

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

  const assign = async (job, technicianId) => {
    const tech = techs.find((t) => t.id === technicianId);
    try {
        const { assignmentId } = await track(() => api.addAssignment(job.id, technicianId, job.scheduledDate));
      const updated = {
        ...job,
        assignments: [...job.assignments, { assignmentId, technicianId, technicianName: tech?.name, workDate: job.scheduledDate, completed: false }],
      };
      const derived = deriveJobStatusFromAssignments(updated);
      setJobs((prev) => prev.map((j) => j.id === job.id ? { ...updated, ...derived } : j));
      await track(() => api.updateJob(job.id, derived));
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
      await track(() => api.updateJob(job.id, { status, scheduledDate }));
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
      await track(() => api.updateJob(job.id, { status, scheduledDate }));
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
      await track(() => api.updateJob(job.id, { status, scheduledDate }));
      flash('Assignment date saved');
    } catch (e) { flash(`Could not save date: ${e.message}`); load(true); }
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
      await track(() => api.updateJob(job.id, { status }));
      flash(offBoard ? `${job.name} closed out` : 'Status updated');
    } catch (e) { flash(`Could not update: ${e.message}`); load(true); }
  };

  const filteredJobs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs.filter((j) => {
      if (!(q === '' || j.name.toLowerCase().includes(q))) return false;
      if (jobTech === 'unassigned' && j.assignments.length > 0) return false;
      if (jobTech !== 'all' && jobTech !== 'unassigned'
          && !j.assignments.some((a) => a.technicianId === jobTech)) return false;
      if (createdFrom || createdTo) {
        const cd = dateOnlyISO(j.createdDate);
        if (!cd) return false;
        if (createdFrom && cd < createdFrom) return false;
        if (createdTo && cd > createdTo) return false;
      }
      return true;
    });
  }, [jobs, query, jobTech, createdFrom, createdTo]);

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
      if (createdFrom || createdTo) {
        const cd = dateOnlyISO(j.createdDate);
        if (!cd) return false;
        if (createdFrom && cd < createdFrom) return false;
        if (createdTo && cd > createdTo) return false;
      }
      return true;
    });

    const byStr = (a, b) => a.localeCompare(b);
    const sorters = {
      scheduled: (a, b) => byStr(a.scheduledDate || '9999-99', b.scheduledDate || '9999-99'),
      createdNew: (a, b) => byStr(b.createdDate || '', a.createdDate || ''),
      createdOld: (a, b) => byStr(a.createdDate || '9999', b.createdDate || '9999'),
      lid: (a, b) => String(a.lid || '').localeCompare(String(b.lid || ''), undefined, { numeric: true }),
      name: (a, b) => byStr(a.name, b.name),
    };
    return [...filtered].sort(sorters[sortBy] || sorters.scheduled);
  }, [jobs, extraJobs, viewingTerminal, filter, query, jobTech, createdFrom, createdTo, sortBy]);

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
              <span className="rl">Created</span>
              <input className="dateinput" type="date" value={createdFrom} onChange={(e) => setCreatedFrom(e.target.value)} title="Created from" />
              <span className="dash">–</span>
              <input className="dateinput" type="date" value={createdTo} onChange={(e) => setCreatedTo(e.target.value)} title="Created to" />
              <select
                className="ctlselect datepreset"
                defaultValue=""
                onChange={(e) => {
                  const value = e.target.value;
                  e.target.value = '';
                  const today = new Date();
                  if (value === 'ytd') {
                    setCreatedFrom(isoOf(startOfYear(today)));
                    setCreatedTo(todayIso());
                  } else if (value === 'thisMonth') {
                    setCreatedFrom(isoOf(startOfMonth(today)));
                    setCreatedTo(todayIso());
                  } else if (value === 'lastMonth') {
                    const start = startOfPreviousMonth(today);
                    const end = new Date(start);
                    end.setMonth(end.getMonth() + 1);
                    end.setDate(0);
                    setCreatedFrom(isoOf(start));
                    setCreatedTo(isoOf(end));
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
                onClick={() => { setCreatedFrom(''); setCreatedTo(''); }}
                disabled={!createdFrom && !createdTo}
              >Clear dates</button>
              {!createdFrom && !createdTo && <span className="rangestate">showing all time</span>}
            </div>
            <div className="datehint">Board loads opportunities by status; these dates only filter by Created Date.</div>

            <div className="sortbar">
              <label className="sortgrp">
                <span className="rl">Sort</span>
                <select className="ctlselect" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                  <option value="scheduled">Scheduled date</option>
                  <option value="createdNew">created — newest</option>
                  <option value="createdOld">created — oldest</option>
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
                          <span className={`badge ${statusClass(job.status)}`}>{job.status}</span>
                        </div>
                        <div className="meta">
                          <span><span className="ic">◍</span>{job.address || 'No address'}</span>
                          {job.createdDate && <span className="created">Created {fmtCreated(job.createdDate)}</span>}
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
                        <select
                          className={`statussel ${statusClass(job.status)}`}
                          value={job.status}
                          onChange={(e) => setStatus(job, e.target.value)}
                        >
                          {!ASSIGNABLE_STATUSES.includes(job.status) && <option value={job.status}>{job.status}</option>}
                          {ASSIGNABLE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </div>
                      <div className="meta">
                        <span><span className="ic">◍</span>{job.address || 'No address'}</span>
                        {job.createdDate && <span className="created">Created {fmtCreated(job.createdDate)}</span>}
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
                              {!a.workDate && !a.completed && <span className="untag">unscheduled</span>}
                              <button className="x" onClick={() => unassign(job, a.assignmentId)} aria-label="Remove">×</button>
                            </div>
                          );
                        })}
                        <select className="addtech" value="" onChange={(e) => e.target.value && assign(job, e.target.value)}>
                          <option value="">+ Add assignment</option>
                          {techs.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {!loading && !error && tab === 'schedule' && <Schedule jobs={jobs} techs={techs} />}
      </main>

      {toast && <div className="toast">{toast}<span className="tsf">→ Salesforce</span></div>}
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

function Schedule({ jobs, techs }) {
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
        ? <WeekGrid jobs={jobs} techs={techs} anchor={anchor} techFilter={techFilter} />
        : <MonthGrid jobs={jobs} anchor={anchor} techFilter={techFilter} />}
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

function WeekGrid({ jobs, techs, anchor, techFilter }) {
  const days = useMemo(() => {
    const s = startOfWeek(anchor);
    return Array.from({ length: 7 }, (_, i) => addDays(s, i));
  }, [anchor]);
  const todayIso = isoOf(startOfDay(new Date()));
  const rows = techFilter === 'all' ? techs : techs.filter((t) => t.id === techFilter);

  // techId -> iso -> [job names], placed by each assignment's own date
  const grid = useMemo(() => {
    const m = {};
    jobs.forEach((job) => job.assignments.forEach((a) => {
      if (!a.workDate) return; // unscheduled assignment — not on the calendar
      ((m[a.technicianId] ||= {})[a.workDate] ||= []).push(job.name);
    }));
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
                      : items.map((n, i) => <div className="jchip" key={i}>{n.split('—')[0].trim()}</div>)}
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

function MonthGrid({ jobs, anchor, techFilter }) {
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
              <div className="dayjob" data-status={statusClass(j.status)} key={j.id} title={j.name}>
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