import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { api } from './api.js';

// Map your real status strings to a color treatment. Unknown -> neutral.
const STATUS_CLASS = {
  'Ready to be scheduled': 'needs',   // amber — needs a tech assigned
  'Scheduled': 'scheduled',           // blue — booked
  'In Progress': 'dispatched',        // indigo — tech on site
};
const statusClass = (s) => STATUS_CLASS[s] || 'scheduled';

// Statuses a dispatcher can move a job into from the board.
// The first three keep it on the board; the rest close it out (it drops off
// on the next refresh, since the API only returns board statuses).
const BOARD_STATUSES = ['Ready to be scheduled', 'Scheduled', 'In Progress'];
// Everything a dispatcher can set from the board, in lifecycle order. The three
// BOARD_STATUSES keep the job on the board; the rest write the status back and
// drop the job off (it's no longer active field work). Strings must match the
// Salesforce picklist values EXACTLY.
const ASSIGNABLE_STATUSES = [
  'Quoted',
  'Parts Ordered',
  'Ready to be scheduled',
  'Scheduled',
  'In Progress',
  'Installation Complete',
  'Waiting on Payment',
];

const POLL_MS = 5 * 60 * 1000; // refresh from Salesforce every 5 minutes

// ---- date helpers (all local-time, no UTC drift) ----
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = (d) => { const x = startOfDay(d); x.setDate(x.getDate() - x.getDay()); return x; }; // Sunday start
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const initials = (name) => name ? name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() : '?';

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

export default function App() {
  const [tab, setTab] = useState('jobs');
  const [jobs, setJobs] = useState([]);
  const [techs, setTechs] = useState([]);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
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
    const id = setInterval(() => { if (pending.current === 0) load(true); }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

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
      setJobs((prev) => prev.map((j) => j.id === job.id
        ? { ...j, assignments: [...j.assignments, { assignmentId, technicianId, technicianName: tech?.name, workDate: job.scheduledDate }] }
        : j));
      flash(`${tech?.name} added to ${job.name}`);
    } catch (e) { flash(`Could not assign: ${e.message}`); }
  };

  const unassign = async (job, assignmentId) => {
    try {
      await track(() => api.removeAssignment(assignmentId));
      setJobs((prev) => prev.map((j) => j.id === job.id
        ? { ...j, assignments: j.assignments.filter((a) => a.assignmentId !== assignmentId) }
        : j));
      flash('Tech removed');
    } catch (e) { flash(`Could not remove: ${e.message}`); }
  };

  const setDate = async (job, date) => {
    // Assignments are pinned to the job's scheduled date — move them together.
    setJobs((prev) => prev.map((j) => j.id === job.id
      ? { ...j, scheduledDate: date, assignments: j.assignments.map((a) => ({ ...a, workDate: date })) }
      : j));
    try {
      await track(() => api.updateJob(job.id, { scheduledDate: date }));
      flash('Scheduled date saved');
    } catch (e) { flash(`Could not save date: ${e.message}`); load(true); }
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

  const statuses = useMemo(() => {
    const set = new Map();
    jobs.forEach((j) => set.set(j.status, (set.get(j.status) || 0) + 1));
    return [['all', jobs.length], ...set.entries()];
  }, [jobs]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs.filter((j) =>
      (filter === 'all' || j.status === filter) &&
      (q === '' || j.name.toLowerCase().includes(q))
    );
  }, [jobs, filter, query]);

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
        {error && <div className="state err">Couldn't reach the API: {error}<br /><small>Is the server running on :3001 and your .env filled in?</small></div>}

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

            <div className="filters">
              {statuses.map(([s, count]) => (
                <button key={s} className={`chip ${filter === s ? 'on' : ''}`} onClick={() => setFilter(s)}>
                  {s === 'all' ? 'All outstanding' : s}<span className="ct">{count}</span>
                </button>
              ))}
            </div>

            <div className="jobs">
              {shown.length === 0 && <div className="empty">{query.trim() ? 'No jobs match that search.' : 'No jobs in this status.'}</div>}
              {shown.map((job) => {
                const assignedIds = new Set(job.assignments.map((a) => a.technicianId));
                const available = techs.filter((t) => !assignedIds.has(t.id));
                return (
                  <div className="job" key={job.id}>
                    <div className="stripe" data-status={statusClass(job.status)} />
                    <div className="body">
                      <div className="row1">
                        <span className="jname">{job.name}</span>
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
                        <input
                          className="dateinput"
                          type="date"
                          value={job.scheduledDate || ''}
                          onChange={(e) => setDate(job, e.target.value)}
                          title="Scheduled date"
                        />
                      </div>
                      <div className="techrow">
                        {job.assignments.length === 0 && <span className="unassigned-tag">Unassigned</span>}
                        {job.assignments.map((a) => (
                          <span className="techchip" key={a.assignmentId}>
                            {a.technicianName || 'Tech'}
                            <button className="x" onClick={() => unassign(job, a.assignmentId)} aria-label="Remove">×</button>
                          </span>
                        ))}
                        {available.length > 0 && (
                          <select className="addtech" value="" onChange={(e) => e.target.value && assign(job, e.target.value)}>
                            <option value="">+ Add tech</option>
                            {available.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                          </select>
                        )}
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

function Schedule({ jobs, techs }) {
  const [mode, setMode] = useState('week');
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));

  const shift = (dir) => {
    const d = new Date(anchor);
    if (mode === 'week') d.setDate(d.getDate() + dir * 7);
    else d.setMonth(d.getMonth() + dir);
    setAnchor(startOfDay(d));
  };

  return (
    <section>
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
        <div className="seg">
          <button className={`segbtn ${mode === 'week' ? 'on' : ''}`} onClick={() => setMode('week')}>Week</button>
          <button className={`segbtn ${mode === 'month' ? 'on' : ''}`} onClick={() => setMode('month')}>Month</button>
        </div>
      </div>

      {mode === 'week'
        ? <WeekGrid jobs={jobs} techs={techs} anchor={anchor} />
        : <MonthGrid jobs={jobs} anchor={anchor} />}
    </section>
  );
}

function WeekGrid({ jobs, techs, anchor }) {
  const days = useMemo(() => {
    const s = startOfWeek(anchor);
    return Array.from({ length: 7 }, (_, i) => addDays(s, i));
  }, [anchor]);
  const todayIso = isoOf(startOfDay(new Date()));

  // techId -> iso -> [job names]
  const grid = useMemo(() => {
    const m = {};
    jobs.forEach((job) => job.assignments.forEach((a) => {
      const d = a.workDate || job.scheduledDate;
      if (!d) return;
      ((m[a.technicianId] ||= {})[d] ||= []).push(job.name);
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
          {techs.map((t) => (
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

function MonthGrid({ jobs, anchor }) {
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

  // iso -> [job]
  const byDate = useMemo(() => {
    const m = {};
    jobs.forEach((j) => { if (j.scheduledDate) (m[j.scheduledDate] ||= []).push(j); });
    return m;
  }, [jobs]);

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