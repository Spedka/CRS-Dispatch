import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { api } from './api.js';

// Map your real status strings to a color treatment. Unknown -> neutral.
const STATUS_CLASS = {
  'Ready to be scheduled': 'needs',   // amber — needs a tech assigned
  'Scheduled': 'scheduled',           // blue — booked
  'In Progress': 'dispatched',        // indigo — tech on site
};
const statusClass = (s) => STATUS_CLASS[s] || 'scheduled';

function fmtDate(iso) {
  if (!iso) return 'No date';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function App() {
  const [tab, setTab] = useState('jobs');
  const [jobs, setJobs] = useState([]);
  const [techs, setTechs] = useState([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [j, t] = await Promise.all([api.getJobs(), api.getTechnicians()]);
      setJobs(j);
      setTechs(t);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2200); };

  const assign = async (job, technicianId) => {
    const tech = techs.find((t) => t.id === technicianId);
    try {
      const { assignmentId } = await api.addAssignment(job.id, technicianId, job.scheduledDate);
      setJobs((prev) => prev.map((j) => j.id === job.id
        ? { ...j, assignments: [...j.assignments, { assignmentId, technicianId, technicianName: tech?.name, workDate: job.scheduledDate }] }
        : j));
      flash(`${tech?.name} added to ${job.name}`);
    } catch (e) { flash(`Could not assign: ${e.message}`); }
  };

  const unassign = async (job, assignmentId) => {
    try {
      await api.removeAssignment(assignmentId);
      setJobs((prev) => prev.map((j) => j.id === job.id
        ? { ...j, assignments: j.assignments.filter((a) => a.assignmentId !== assignmentId) }
        : j));
      flash('Tech removed');
    } catch (e) { flash(`Could not remove: ${e.message}`); }
  };

  const statuses = useMemo(() => {
    const set = new Map();
    jobs.forEach((j) => set.set(j.status, (set.get(j.status) || 0) + 1));
    return [['all', jobs.length], ...set.entries()];
  }, [jobs]);

  const shown = filter === 'all' ? jobs : jobs.filter((j) => j.status === filter);

  return (
    <>
      <div className="topline" />
      <header className="bar">
        <div className="wordmark">
          <div className="glyph">C</div>
          <div><h1>CRS Dispatch</h1><span>Field Work Board</span></div>
        </div>
        <div className="bar-spacer" />
        <button className="refresh" onClick={load} title="Reload from Salesforce">↻ Refresh</button>
        <div className="synced"><span className="dot" /><span className="lbl">Live · Salesforce</span></div>
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
              <div><h2>Outstanding field work</h2><p>Every job needing a tech, live from Salesforce.</p></div>
            </div>

            <div className="filters">
              {statuses.map(([s, count]) => (
                <button key={s} className={`chip ${filter === s ? 'on' : ''}`} onClick={() => setFilter(s)}>
                  {s === 'all' ? 'All outstanding' : s}<span className="ct">{count}</span>
                </button>
              ))}
            </div>

            <div className="jobs">
              {shown.length === 0 && <div className="empty">No jobs in this status.</div>}
              {shown.map((job) => {
                const assignedIds = new Set(job.assignments.map((a) => a.technicianId));
                const available = techs.filter((t) => !assignedIds.has(t.id));
                return (
                  <div className="job" key={job.id}>
                    <div className="stripe" data-status={statusClass(job.status)} />
                    <div className="body">
                      <div className="row1">
                        <span className="jname">{job.name}</span>
                        <span className={`badge ${statusClass(job.status)}`}>{job.status}</span>
                      </div>
                      <div className="meta">
                        <span><span className="ic">◍</span>{job.address || 'No address'}</span>
                        <span className="date"><span className="ic">▤</span>{fmtDate(job.scheduledDate)}</span>
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

function Schedule({ jobs, techs }) {
  // Columns = distinct scheduled dates present in the jobs, sorted, capped.
  const dates = useMemo(() => {
    const set = [...new Set(jobs.map((j) => j.scheduledDate).filter(Boolean))].sort();
    return set.slice(0, 7);
  }, [jobs]);

  // Index: techId -> date -> [job names]
  const grid = useMemo(() => {
    const m = {};
    jobs.forEach((job) => {
      job.assignments.forEach((a) => {
        const d = a.workDate || job.scheduledDate;
        if (!d) return;
        ((m[a.technicianId] ||= {})[d] ||= []).push(job.name);
      });
    });
    return m;
  }, [jobs]);

  return (
    <section>
      <div className="view-head">
        <div><h2>Who's on what</h2><p>Each tech's load by day. Empty cells are open.</p></div>
      </div>
      <div className="grid-wrap">
        <table className="sched">
          <thead>
            <tr>
              <th className="techcol">Technician</th>
              {dates.map((d) => <th key={d}>{fmtDate(d)}</th>)}
            </tr>
          </thead>
          <tbody>
            {techs.map((t) => (
              <tr key={t.id}>
                <td className="techcol"><div className="tn">{t.name}</div></td>
                {dates.map((d) => {
                  const items = grid[t.id]?.[d] || [];
                  return (
                    <td key={d} className={items.length ? '' : 'open'}>
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
    </section>
  );
}