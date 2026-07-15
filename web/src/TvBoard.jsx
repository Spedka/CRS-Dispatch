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

const HEX_RE = /^#[0-9a-f]{6}$/i;
// Luminance-based contrast pick -- hand-picked colors (set in Manage Techs,
// server/src/config.js's technicianColor -> Technician__c.Color__c) don't
// come with a pre-verified paired text color the way the fixed palette
// above does, so this decides light/dark text on the fly.
function hexToColor(hex) {
  const h = hex.slice(1);
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return { bg: hex, fg: luminance > 0.6 ? '#111827' : '#fff' };
}

// colorMap is techId -> hex (or falsy), built once from data.technicians --
// a tech with a hand-picked color uses it; everyone else keeps the old
// deterministic hash so they're still visually distinct from each other.
function colorFor(techId, techName, colorMap) {
  const custom = colorMap && colorMap[techId];
  if (custom && HEX_RE.test(custom)) return hexToColor(custom);
  return TV_PALETTE[hashTech(techId ?? techName) % TV_PALETTE.length];
}

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
const DEPLOY_CHECK_MS = 10 * 60 * 1000;

// Kiosk tabs never get manually refreshed, so a deploy wouldn't otherwise
// show up until the 6h hygiene reload (or someone remembers to refresh by
// hand). Every build gets a new hashed JS bundle, so index.html's own
// contents change on every deploy -- polling it and reloading the moment it
// differs from what was loaded at page-open picks up a fresh deploy within
// a minute, automatically. cache: 'no-store' plus a cache-busting query
// param both target the same goal (bypass any caching layer, browser or
// edge) since it's cheap insurance either way.
function useDeployWatcher() {
  useEffect(() => {
    let baseline = null;
    let stopped = false;

    const check = async () => {
      try {
        const res = await fetch(`${window.location.pathname}?_=${Date.now()}`, { cache: 'no-store' });
        const html = await res.text();
        if (stopped) return;
        if (baseline === null) { baseline = html; return; }
        if (html !== baseline) window.location.reload();
      } catch {
        // network hiccup -- just try again next interval
      }
    };

    check();
    const id = setInterval(check, DEPLOY_CHECK_MS);
    return () => { stopped = true; clearInterval(id); };
  }, []);
}

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

function TvWeekView({ jobs, technicians, requests, timeOff, colorMap }) {
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
          const color = colorFor(t.id, t.name, colorMap);
          return (
            <React.Fragment key={t.id}>
              <div className="tv-techname" style={{ color: color.bg }}>{t.name}</div>
              {days.map((d) => {
                const iso = isoOf(d);
                const items = grid[t.id]?.[iso] || [];
                const off = timeOffByTechDate[t.id]?.[iso];
                const shown = items.slice(0, 2);
                const overflow = items.length - shown.length;
                return (
                  <div key={iso} className={`tv-wdaycell ${iso === todayIso ? 'tv-todaycol' : ''}`}>
                    {off && <div className="tv-offchip">Off</div>}
                    {items.length === 0 && !off && <span className="tv-free">Open</span>}
                    {shown.map((item, i) => (
                      <TvChip key={i} color={color} pending={item.pending}>
                        <span className="tv-chip-time">{item.startTime} </span>
                        {item.name.split('—')[0].trim()}
                      </TvChip>
                    ))}
                    {overflow > 0 && <div className="tv-more">+{overflow} more</div>}
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

function TvDayView({ jobs, technicians, requests, timeOff, colorMap }) {
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
          const color = colorFor(t.id, t.name, colorMap);
          const items = byTech[t.id] || [];
          const off = offByTech[t.id];
          const shown = items.slice(0, 2);
          const overflow = items.length - shown.length;
          return (
            <div className="tv-dayrow" key={t.id}>
              <div className={`tv-techname ${off ? 'tv-techname-off' : ''}`} style={off ? undefined : { color: color.bg }}>{t.name}</div>
              <div className="tv-dayrow-items">
                {off && <div className="tv-offchip">Off all day</div>}
                {items.length === 0 && !off && <span className="tv-free">Open</span>}
                {shown.map((item, i) => (
                  <TvChip key={i} color={color} pending={item.pending}>
                    <span className="tv-chip-time">{item.startTime} </span>
                    {item.name.split('—')[0].trim()}
                  </TvChip>
                ))}
                {overflow > 0 && <div className="tv-more">+{overflow} more</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TvMonthView({ jobs, requests, timeOff, colorMap }) {
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

  // Keeps every assignment (jobId + tech) per date -- jobCount below dedupes
  // by jobId for the summary line, while the bubble row dedupes by
  // technicianId (one bubble per tech working that day, not one per job --
  // a tech double-booked that day still only gets a single bubble).
  const scheduledByDate = useMemo(() => {
    const m = {};
    jobs.forEach((j) => (j.assignments || []).forEach((a) => {
      if (!a.workDate) return;
      (m[a.workDate] ||= []).push({ jobId: j.id, technicianId: a.technicianId, technicianName: a.technicianName });
    }));
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
  const rows = cells.length / 7;

  return (
    <div className="tv-month" style={{ gridTemplateRows: `auto repeat(${rows}, 1fr)` }}>
      {WD.map((w) => <div className="tv-monthwd" key={w}>{w}</div>)}
      {cells.map((d) => {
        const iso = isoOf(d);
        const out = d.getMonth() !== month;
        const entries = scheduledByDate[iso] || [];
        const jobCount = new Set(entries.map((e) => e.jobId)).size;
        const pendingCount = (pendingByDate[iso] || []).length;
        const offCount = (offByDate[iso] || []).length;

        // One bubble per tech working that day, not one per assignment.
        const techMap = new Map();
        entries.forEach((e) => {
          if (e.technicianId && !techMap.has(e.technicianId)) techMap.set(e.technicianId, e.technicianName);
        });

        const summary = [];
        if (jobCount > 0) summary.push(`${jobCount} job${jobCount === 1 ? '' : 's'}`);
        if (offCount > 0) summary.push(`${offCount} time off`);
        if (pendingCount > 0) summary.push(`${pendingCount} request${pendingCount === 1 ? '' : 's'}`);

        return (
          <div className={`tv-daycell ${out ? 'tv-pad' : ''} ${iso === todayIso ? 'tv-today' : ''}`} key={iso}>
            <div className="tv-daycell-head">
              <span className="tv-daynum">{d.getDate()}</span>
              {summary.length > 0 && <span className="tv-daysummary" title={summary.join(' · ')}>{summary.join(' · ')}</span>}
            </div>
            <div className="tv-dotgrid">
              {[...techMap.entries()].map(([techId, techName]) => {
                const c = colorFor(techId, techName, colorMap);
                return (
                  <span key={techId} className="tv-bubble" style={{ background: c.bg, color: c.fg }} title={techName}>
                    {initials(techName)}
                  </span>
                );
              })}
            </div>
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
    console.error('[TvBoard] render error, reloading shortly', err);
    // The fallback below says "will retry shortly" -- this is what actually
    // makes that true. Catching the error unmounts everything under this
    // boundary, including TvBoardInner's own 6h periodic-reload timer (its
    // cleanup fires on unmount, cancelling it), so without this the page
    // would otherwise sit on the fallback text forever with nobody around
    // to notice and refresh it.
    setTimeout(() => window.location.reload(), 15000);
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

  // Computed unconditionally (with a data?.technicians ?? [] guard) rather
  // than after the !data early return below -- calling useMemo only on some
  // renders would violate the rules of hooks (React expects the same hooks
  // in the same order every render) and throw, which is exactly what was
  // tripping the error boundary here.
  const colorMap = useMemo(
    () => Object.fromEntries((data?.technicians ?? []).map((t) => [t.id, t.color])),
    [data]
  );

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
      {view === 'day' && <TvDayView jobs={data.jobs} technicians={data.technicians} requests={data.requests} timeOff={data.timeOff} colorMap={colorMap} />}
      {view === 'week' && <TvWeekView jobs={data.jobs} technicians={data.technicians} requests={data.requests} timeOff={data.timeOff} colorMap={colorMap} />}
      {view === 'month' && <TvMonthView jobs={data.jobs} requests={data.requests} timeOff={data.timeOff} colorMap={colorMap} />}
    </div>
  );
}

export default function TvBoard() {
  // Outside the error boundary on purpose -- a render crash unmounts
  // everything inside TvErrorBoundary (see its own comment), and a stuck
  // kiosk tab is exactly the case a deploy needs to reach regardless.
  useDeployWatcher();
  return (
    <TvErrorBoundary>
      <FullscreenPrompt />
      <TvBoardInner />
    </TvErrorBoundary>
  );
}
