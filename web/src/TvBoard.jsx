import React, { useEffect, useMemo, useRef, useState } from 'react';
import './tv.css';

// Self-contained warehouse TV calendar, mounted separately from <App/> at
// /tv (see main.jsx) -- no login, no clicks, no remote. Auto-rotates
// between a day, week, and month view, colored per-technician, and
// force-refreshes the moment something relevant changes via a WebSocket
// push (server/src/tvChannel.js), with a 5-minute poll as a catch-up
// fallback. App.jsx exports nothing, so the handful of small pure helpers
// this needs are duplicated below rather than shared.

// ---- date helpers (mirrors App.jsx's own, local-time, no UTC drift) ----
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = (d) => { const x = startOfDay(d); x.setDate(x.getDate() - x.getDay()); return x; };
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const initials = (name) => name ? name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() : '?';

function nextScheduledAssignmentDate(job) {
  const dates = (job.assignments || [])
    .filter((a) => a.workDate && !a.completed)
    .map((a) => a.workDate)
    .sort();
  return dates[0] || '';
}

// ---- deterministic per-tech color ----
const TV_PALETTE = [
  { bg: '#DC2626', fg: '#fff' }, { bg: '#2563EB', fg: '#fff' }, { bg: '#059669', fg: '#fff' },
  { bg: '#D97706', fg: '#1A1200' }, { bg: '#7C3AED', fg: '#fff' }, { bg: '#0891B2', fg: '#fff' },
  { bg: '#DB2777', fg: '#fff' }, { bg: '#65A30D', fg: '#0E1A00' }, { bg: '#EA580C', fg: '#fff' },
  { bg: '#4338CA', fg: '#fff' }, { bg: '#0D9488', fg: '#fff' }, { bg: '#991B1B', fg: '#fff' },
  { bg: '#7E22CE', fg: '#fff' }, { bg: '#15803D', fg: '#fff' },
];
function hashTech(key) {
  const s = String(key ?? '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}
const colorFor = (techId, techName) => TV_PALETTE[hashTech(techId ?? techName) % TV_PALETTE.length];

// Grid rows are sized 1fr each so every technician row is always visible
// (never clipped off the bottom the way a fixed-height table row could be)
// -- this scale factor keeps text/chips from feeling oversized once there
// are enough techs that each row's actual pixel height shrinks.
function scaleForCount(n) {
  if (n <= 6) return 1;
  if (n <= 9) return 0.86;
  if (n <= 12) return 0.74;
  if (n <= 16) return 0.62;
  return 0.52;
}

const TV_POLL_MS = 5 * 60 * 1000; // matches App.jsx's own POLL_MS
const VIEWS = ['day', 'week', 'month'];
const ROTATE_MS = 45 * 1000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

function useTvData() {
  const [data, setData] = useState(null);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const loadingRef = useRef(false);

  const load = useRef(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const res = await fetch('/api/tv/data');
      if (!res.ok) throw new Error(res.statusText);
      const json = await res.json();
      setData(json);
      setLastSyncedAt(Date.now());
    } catch (err) {
      console.error('[TvBoard] fetch failed', err.message);
    } finally {
      loadingRef.current = false;
    }
  }).current;

  useEffect(() => {
    load();
    const pollId = setInterval(load, TV_POLL_MS);

    let socket = null;
    let reconnectAttempt = 0;
    let reconnectTimer = null;
    let stopped = false;

    const scheduleReconnect = () => {
      if (stopped) return;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    };

    function connect() {
      if (stopped) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${proto}//${window.location.host}/api/tv/ws`);
      socket.onopen = () => {
        reconnectAttempt = 0;
        load(); // may have missed a push while disconnected
      };
      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg?.type === 'refresh') load();
        } catch {
          // ignore malformed messages
        }
      };
      socket.onclose = () => scheduleReconnect();
      socket.onerror = () => socket?.close();
    }
    connect();

    return () => {
      stopped = true;
      clearInterval(pollId);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [load]);

  return { data, lastSyncedAt };
}

function TvChip({ color, pending, children }) {
  const style = pending
    ? { borderColor: color.bg, color: color.bg }
    : { background: color.bg, color: color.fg };
  return <div className="tv-chip" style={style}>{children}{pending && <span className="tv-pending-badge">PENDING</span>}</div>;
}

function TvWeekView({ jobs, technicians, requests, timeOff }) {
  const days = useMemo(() => {
    const s = startOfWeek(new Date());
    return Array.from({ length: 7 }, (_, i) => addDays(s, i));
  }, []);
  const todayIso = isoOf(startOfDay(new Date()));

  const grid = useMemo(() => {
    const m = {};
    jobs.forEach((job) => (job.assignments || []).forEach((a) => {
      if (!a.workDate) return;
      ((m[a.technicianId] ||= {})[a.workDate] ||= []).push({
        name: job.name, startTime: a.startTime || '07:00', completed: !!a.completed, pending: false,
      });
    }));
    requests.forEach((r) => {
      if (!r.technicianId || !r.proposedDate || r.isTimeOff) return;
      ((m[r.technicianId] ||= {})[r.proposedDate] ||= []).push({
        name: r.jobName || 'Pending job', startTime: r.proposedStart || '07:00', completed: false, pending: true,
      });
    });
    Object.values(m).forEach((byDate) =>
      Object.values(byDate).forEach((items) => items.sort((a, b) => a.startTime.localeCompare(b.startTime)))
    );
    return m;
  }, [jobs, requests]);

  const timeOffByTechDate = useMemo(() => {
    const m = {};
    timeOff.forEach((r) => {
      if (!r.technicianId || !r.workDate) return;
      (m[r.technicianId] ||= {})[r.workDate] = r;
    });
    return m;
  }, [timeOff]);

  // A grid (not a table) so rows are always sized 1fr -- every technician
  // gets a row that's always visible, however thin, instead of a table row
  // that can grow past the viewport and get silently clipped by
  // .tv-grid-wrap's overflow:hidden (the bug that made only ~2 techs show).
  const scale = scaleForCount(technicians.length);

  return (
    <div className="tv-grid-wrap">
      <div
        className="tv-weekgrid"
        style={{ '--tv-scale': scale, gridTemplateRows: `auto repeat(${technicians.length}, 1fr)` }}
      >
        <div className="tv-corner" />
        {days.map((d) => {
          const iso = isoOf(d);
          return (
            <div key={iso} className={`tv-daytitle ${iso === todayIso ? 'tv-todaycol' : ''}`}>
              {d.toLocaleDateString(undefined, { weekday: 'short' })} {d.getDate()}
            </div>
          );
        })}
        {technicians.map((t) => {
          const color = colorFor(t.id, t.name);
          return (
            <React.Fragment key={t.id}>
              <div className="tv-techname" style={{ color: color.bg }}>{t.name}</div>
              {days.map((d) => {
                const iso = isoOf(d);
                const items = grid[t.id]?.[iso] || [];
                const off = timeOffByTechDate[t.id]?.[iso];
                return (
                  <div key={iso} className={`tv-wdaycell ${iso === todayIso ? 'tv-todaycol' : ''}`}>
                    {off && <div className="tv-offchip">Off</div>}
                    {items.length === 0 && !off && <span className="tv-free">Open</span>}
                    {items.map((item, i) => (
                      <TvChip key={i} color={color} pending={item.pending}>
                        <span className="tv-chip-time">{item.startTime} </span>
                        {item.name.split('—')[0].trim()}
                      </TvChip>
                    ))}
                  </div>
                );
              })}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

function TvDayView({ jobs, technicians, requests, timeOff }) {
  const todayIso = isoOf(startOfDay(new Date()));

  const byTech = useMemo(() => {
    const m = {};
    jobs.forEach((job) => (job.assignments || []).forEach((a) => {
      if (a.workDate !== todayIso) return;
      (m[a.technicianId] ||= []).push({
        name: job.name, startTime: a.startTime || '07:00', completed: !!a.completed, pending: false,
      });
    }));
    requests.forEach((r) => {
      if (r.proposedDate !== todayIso || !r.technicianId || r.isTimeOff) return;
      (m[r.technicianId] ||= []).push({
        name: r.jobName || 'Pending job', startTime: r.proposedStart || '07:00', completed: false, pending: true,
      });
    });
    Object.values(m).forEach((items) => items.sort((a, b) => a.startTime.localeCompare(b.startTime)));
    return m;
  }, [jobs, requests, todayIso]);

  const offByTech = useMemo(() => {
    const m = {};
    timeOff.forEach((r) => {
      if (r.workDate === todayIso && r.technicianId) m[r.technicianId] = r;
    });
    return m;
  }, [timeOff, todayIso]);

  const scale = scaleForCount(technicians.length);

  return (
    <div className="tv-grid-wrap">
      <div
        className="tv-daygrid"
        style={{ '--tv-scale': scale, gridTemplateRows: `repeat(${technicians.length}, 1fr)` }}
      >
        {technicians.map((t) => {
          const color = colorFor(t.id, t.name);
          const items = byTech[t.id] || [];
          const off = offByTech[t.id];
          return (
            <div className="tv-dayrow" key={t.id}>
              <div className="tv-techname" style={{ color: color.bg }}>{t.name}</div>
              <div className="tv-dayrow-items">
                {off && <div className="tv-offchip">Off all day</div>}
                {items.length === 0 && !off && <span className="tv-free">Open</span>}
                {items.map((item, i) => (
                  <TvChip key={i} color={color} pending={item.pending}>
                    <span className="tv-chip-time">{item.startTime} </span>
                    {item.name.split('—')[0].trim()}
                  </TvChip>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TvMonthView({ jobs, requests, timeOff }) {
  const now = new Date();
  const month = now.getMonth();
  const todayIso = isoOf(startOfDay(now));

  const cells = useMemo(() => {
    const first = new Date(now.getFullYear(), month, 1);
    const last = new Date(now.getFullYear(), month + 1, 0);
    const gridStart = startOfWeek(first);
    const gridEnd = addDays(startOfWeek(last), 6);
    const total = Math.round((gridEnd - gridStart) / 86400000) + 1;
    return Array.from({ length: total }, (_, i) => addDays(gridStart, i));
  }, [month]);

  const byDate = useMemo(() => {
    const m = {};
    jobs.forEach((j) => {
      const date = nextScheduledAssignmentDate(j);
      if (!date) return;
      (m[date] ||= []).push(j);
    });
    return m;
  }, [jobs]);

  const pendingByDate = useMemo(() => {
    const m = {};
    requests.forEach((r) => {
      if (!r.proposedDate || r.isTimeOff) return;
      (m[r.proposedDate] ||= []).push(r);
    });
    return m;
  }, [requests]);

  const offByDate = useMemo(() => {
    const m = {};
    timeOff.forEach((r) => {
      if (!r.workDate) return;
      (m[r.workDate] ||= []).push(r);
    });
    return m;
  }, [timeOff]);

  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div className="tv-month">
      {WD.map((w) => <div className="tv-daynum" key={w}>{w}</div>)}
      {cells.map((d) => {
        const iso = isoOf(d);
        const out = d.getMonth() !== month;
        const items = byDate[iso] || [];
        const pending = pendingByDate[iso] || [];
        const offItems = offByDate[iso] || [];
        return (
          <div className={`tv-daycell ${out ? 'tv-pad' : ''} ${iso === todayIso ? 'tv-today' : ''}`} key={iso}>
            <div className="tv-daynum">{d.getDate()}</div>
            {offItems.map((r) => (
              <div className="tv-dayoff" key={r.id}>{r.technicianName}</div>
            ))}
            {items.map((j) => {
              const primary = [...(j.assignments || [])]
                .filter((a) => a.workDate === iso)
                .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''))[0] || j.assignments?.[0];
              const color = colorFor(primary?.technicianId, primary?.technicianName);
              return (
                <div className="tv-dayjob" key={j.id} style={{ background: color.bg, color: color.fg }} title={j.name}>
                  {j.name.split('—')[0].trim()}
                  {j.assignments?.length > 0 && <span className="tv-inits"> {j.assignments.map((a) => initials(a.technicianName)).join(' ')}</span>}
                </div>
              );
            })}
            {pending.map((r) => {
              const color = colorFor(r.technicianId, r.technicianName);
              return (
                <div className="tv-dayjob tv-pending" key={r.id} style={{ borderColor: color.bg, color: color.bg }} title={`${r.jobName || 'Pending'} (pending)`}>
                  {(r.jobName || 'Pending').split('—')[0].trim()} <span className="tv-inits">{initials(r.technicianName)}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

class TvErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(err) {
    console.error('[TvBoard] render error, showing fallback', err);
  }
  render() {
    if (this.state.hasError) {
      return <div className="tv-fallback">Schedule display unavailable — will retry shortly.</div>;
    }
    return this.props.children;
  }
}

// One-tap fullscreen: for casting/mirroring this page from a tablet (e.g.
// Smart View to a Samsung TV) with no browser address bar/tabs in the
// mirrored picture. The Fullscreen API only hides in-page browser chrome --
// it's not a home-screen app install -- but that's exactly what a "share my
// screen" mirror needs, and it's a single tap instead of any install/setup
// flow. Vendor-prefixed fallbacks cover older Samsung Internet/Safari.
function requestFullscreen(el) {
  const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
  if (!fn) return Promise.reject(new Error('Fullscreen not supported'));
  return fn.call(el);
}
function isFullscreenSupported() {
  const el = document.documentElement;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen);
}
function isCurrentlyFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
}
function useFullscreenState() {
  const [isFs, setIsFs] = useState(() => isCurrentlyFullscreen());
  useEffect(() => {
    const handler = () => setIsFs(isCurrentlyFullscreen());
    const events = ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'];
    events.forEach((e) => document.addEventListener(e, handler));
    return () => events.forEach((e) => document.removeEventListener(e, handler));
  }, []);
  return isFs;
}

function FullscreenPrompt() {
  const isFs = useFullscreenState();
  const supported = useRef(isFullscreenSupported()).current;
  if (!supported || isFs) return null;
  return (
    <div className="tv-fs-prompt" onClick={() => requestFullscreen(document.documentElement).catch(() => {})}>
      <div className="tv-fs-prompt-box">Tap anywhere to go fullscreen, then start screen mirroring</div>
    </div>
  );
}

function titleFor(view) {
  if (view === 'day') return new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  if (view === 'week') return 'This Week';
  return new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function TvBoardInner() {
  const { data, lastSyncedAt } = useTvData();
  const [viewIdx, setViewIdx] = useState(0);
  const view = VIEWS[viewIdx];

  useEffect(() => {
    const id = setInterval(() => setViewIdx((i) => (i + 1) % VIEWS.length), ROTATE_MS);
    return () => clearInterval(id);
  }, []);

  // Standard kiosk hygiene: full reload every ~6h clears any accumulated
  // memory bloat and recovers from a wedged timer/socket the error boundary
  // above wouldn't catch.
  useEffect(() => {
    const id = setTimeout(() => window.location.reload(), 6 * 60 * 60 * 1000);
    return () => clearTimeout(id);
  }, []);

  if (!data) {
    return (
      <div className="tv-page">
        <div className="tv-loading">Loading schedule…</div>
      </div>
    );
  }

  const syncedLabel = lastSyncedAt
    ? new Date(lastSyncedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : '—';

  return (
    <div className="tv-page">
      <div className="tv-header">
        <h1>{titleFor(view)}</h1>
        <div className="tv-meta">{data.technicians.length} techs · as of {syncedLabel}</div>
      </div>
      {view === 'day' && <TvDayView jobs={data.jobs} technicians={data.technicians} requests={data.requests} timeOff={data.timeOff} />}
      {view === 'week' && <TvWeekView jobs={data.jobs} technicians={data.technicians} requests={data.requests} timeOff={data.timeOff} />}
      {view === 'month' && <TvMonthView jobs={data.jobs} requests={data.requests} timeOff={data.timeOff} />}
    </div>
  );
}

export default function TvBoard() {
  return (
    <TvErrorBoundary>
      <FullscreenPrompt />
      <TvBoardInner />
    </TvErrorBoundary>
  );
}
