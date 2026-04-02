require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const axios    = require('axios');
const polyline = require('@mapbox/polyline');
const db       = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

const STRAVA_CLIENT_ID     = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const REDIRECT_URI         = process.env.REDIRECT_URI;

const RUN_TYPES  = ['Run', 'VirtualRun', 'TrailRun'];
const GOAL_RUNS  = 2;
const GOAL_BANDS = 2;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 1000 * 60 * 60 * 2 },
}));

// ─── Date helpers ─────────────────────────────────────────────────────────────

function parseLocalDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function getWeekMonday(date) {
  const d   = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d;
}

function addDays(date, n) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + n);
  return d;
}

function toDateStr(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function todayDate() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function sportIcon(type) {
  const m = {
    Run:'🏃', VirtualRun:'🏃', TrailRun:'🏃',
    Ride:'🚴', VirtualRide:'🚴', EBikeRide:'🚴', GravelRide:'🚴', MountainBikeRide:'🚵',
    Swim:'🏊', Walk:'🚶', Hike:'🥾',
    WeightTraining:'🏋️', Yoga:'🧘', Workout:'💪',
    AlpineSki:'⛷️', NordicSki:'⛷️', BackcountrySki:'⛷️', Snowboard:'🏂',
    Kayaking:'🚣', Soccer:'⚽', Tennis:'🎾',
  };
  return m[type] || '🏅';
}

function fmtDist(m) {
  if (!m) return '—';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function fmtDistLong(m) {
  if (!m) return '—';
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function fmtDur(s) {
  if (!s) return '—';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = s % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${sc}s`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}

function fmtPace(distMeters, movingSecs) {
  if (!distMeters || !movingSecs || distMeters < 100) return null;
  const secsPerKm = movingSecs / (distMeters / 1000);
  const mins = Math.floor(secsPerKm / 60);
  const secs = Math.round(secsPerKm % 60);
  return `${mins}:${String(secs).padStart(2, '0')} /km`;
}

function fmtSpeed(mps) {
  if (!mps) return null;
  return `${(mps * 3.6).toFixed(1)} km/h`;
}

// ─── SVG route map ────────────────────────────────────────────────────────────
// Renders a pure SVG shape (no basemap) from a Strava encoded polyline.
// Returns empty string if no polyline or fewer than 2 points.

function polylineToSvg(encoded, w, h, strokeWidth) {
  if (!encoded) return '';
  let coords;
  try { coords = polyline.decode(encoded); } catch (_) { return ''; }
  if (!coords || coords.length < 2) return '';

  const lats = coords.map(c => c[0]);
  const lngs = coords.map(c => c[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const rangeLat = maxLat - minLat || 0.0001;
  const rangeLng = maxLng - minLng || 0.0001;

  const pad = strokeWidth + 1;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;

  // Maintain aspect ratio — fit within box without stretching
  const scaleX = innerW / rangeLng;
  const scaleY = innerH / rangeLat;
  const scale  = Math.min(scaleX, scaleY);

  // Center the route inside the box
  const offsetX = (innerW - rangeLng * scale) / 2 + pad;
  const offsetY = (innerH - rangeLat * scale) / 2 + pad;

  const pts = coords.map(([lat, lng]) => {
    const x = (lng - minLng) * scale + offsetX;
    const y = (maxLat - lat) * scale + offsetY; // flip Y
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0">`
    + `<polyline points="${pts}" fill="none" stroke="#FC4C02" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`
    + `</svg>`;
}

// ─── Goal & streak helpers ────────────────────────────────────────────────────

function computeStreak() {
  const today      = todayDate();
  const twoYearsAgo = toDateStr(addDays(today, -730));
  const runDates   = db.getRunDatesAfter(twoYearsAgo);
  const bandDates  = db.getBandDatesAfter(twoYearsAgo);

  const weekRuns  = {};
  const weekBands = {};
  for (const date of runDates) {
    const key = toDateStr(getWeekMonday(parseLocalDate(date)));
    weekRuns[key] = (weekRuns[key] || 0) + 1;
  }
  for (const date of bandDates) {
    const key = toDateStr(getWeekMonday(parseLocalDate(date)));
    weekBands[key] = (weekBands[key] || 0) + 1;
  }

  const isComplete = key =>
    (weekRuns[key] || 0) >= GOAL_RUNS && (weekBands[key] || 0) >= GOAL_BANDS;

  const currentMonday    = getWeekMonday(today);
  const currentMondayStr = toDateStr(currentMonday);

  let monday = isComplete(currentMondayStr) ? currentMonday : addDays(currentMonday, -7);
  let streak = 0;
  for (let i = 0; i < 104; i++) {
    if (isComplete(toDateStr(monday))) { streak++; monday = addDays(monday, -7); }
    else break;
  }
  return streak;
}

function getCurrentWeekProgress() {
  const today    = todayDate();
  const monday   = getWeekMonday(today);
  const fromDate = toDateStr(monday);
  const todayStr = toDateStr(today);

  const acts     = db.getActivitiesInRange(fromDate, todayStr);
  const runsDone = acts.filter(a => RUN_TYPES.includes(a.type)).length;
  const bandsDone = db.getBandSessionsInRange(fromDate, todayStr).length;
  const dayOfWeek = ((today.getDay() + 6) % 7) + 1; // Mon=1…Sun=7
  return { runsDone, bandsDone, daysLeft: 7 - dayOfWeek, showUrgency: dayOfWeek >= 3 };
}

// ─── Strava sync ──────────────────────────────────────────────────────────────

async function syncActivities(accessToken) {
  const mostRecent = db.getMostRecentActivityDate();
  if (mostRecent) {
    const after = Math.floor(new Date(mostRecent).getTime() / 1000) + 1;
    const { data } = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { after, per_page: 200 },
    });
    db.saveActivities(data);
  } else {
    for (let page = 1; page <= 5; page++) {
      const { data } = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { per_page: 200, page },
      });
      db.saveActivities(data);
      if (data.length < 200) break;
    }
  }
}

// ─── HTML shell ───────────────────────────────────────────────────────────────

function htmlShell({ title, activeTab, athleteName, streak, body }) {
  const streakHtml = streak > 0
    ? `<span class="streak-badge active">🔥 ${streak}</span>`
    : `<span class="streak-badge dim">🔥 0</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} – Strava</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;min-height:100vh;color:#1a1a1a}

    /* ── Header ── */
    header{background:#fff;border-bottom:1px solid #e5e7eb;padding:0 1.5rem;height:56px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
    .header-left{display:flex;align-items:center;gap:1.25rem}
    .brand{display:flex;align-items:center;gap:0.5rem;text-decoration:none}
    .brand-icon{font-size:1.3rem}
    .brand-name{font-size:1rem;font-weight:700;color:#FC4C02}
    nav{display:flex}
    nav a{padding:0 0.85rem;height:56px;line-height:56px;font-size:0.85rem;font-weight:500;color:#666;text-decoration:none;border-bottom:3px solid transparent;transition:color .15s,border-color .15s;white-space:nowrap}
    nav a:hover{color:#FC4C02}
    nav a.active{color:#FC4C02;border-bottom-color:#FC4C02}
    .header-right{display:flex;align-items:center;gap:0.85rem}
    .streak-badge{font-size:0.82rem;font-weight:700;padding:0.25rem 0.6rem;border-radius:20px;white-space:nowrap}
    .streak-badge.active{background:#fff3ee;color:#FC4C02}
    .streak-badge.dim{background:#f3f4f6;color:#aaa}
    .athlete-name{font-size:0.82rem;color:#666;white-space:nowrap}
    .btn-logout{background:none;border:1px solid #ddd;padding:0.35rem 0.8rem;border-radius:6px;font-size:0.8rem;cursor:pointer;color:#555;text-decoration:none;transition:border-color .2s,color .2s;white-space:nowrap}
    .btn-logout:hover{border-color:#FC4C02;color:#FC4C02}

    /* ── Layout ── */
    main{max-width:1360px;margin:0 auto;padding:1.75rem 1.5rem}
    .page-title{font-size:1.3rem;font-weight:700;margin-bottom:1.25rem}
    .error-banner{background:#fee2e2;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:.85rem 1.1rem;margin-bottom:1.25rem}
    .empty{color:#888;text-align:center;padding:3rem 0}

    /* ── Week progress banner ── */
    .progress-banner{background:#fff;border-radius:12px;padding:1.1rem 1.4rem;margin-bottom:1.5rem;box-shadow:0 1px 4px rgba(0,0,0,.06);display:flex;align-items:center;flex-wrap:wrap;gap:1.25rem}
    .progress-banner .label{font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#888;margin-bottom:.35rem}
    .dots{display:flex;align-items:center;gap:4px}
    .dot{width:11px;height:11px;border-radius:50%;display:inline-block}
    .dot.filled-run{background:#FC4C02}
    .dot.filled-band{background:#7c3aed}
    .dot.empty-dot{background:#e5e7eb}
    .progress-text{font-size:.82rem;color:#555;margin-top:.35rem}
    .progress-text strong{color:#1a1a1a}
    .progress-sep{width:1px;height:36px;background:#e5e7eb;flex-shrink:0}
    .status-msg{font-size:.88rem;font-weight:600;color:#059669}
    .status-msg.incomplete{color:#555}
    .urgency{font-size:.78rem;color:#d97706;margin-top:.2rem}
    .goal-complete-msg{font-size:1rem;font-weight:700;color:#059669}

    /* ── Calendar ── */
    .cal-nav{display:flex;align-items:center;gap:1rem;margin-bottom:1rem}
    .cal-nav a{display:inline-flex;align-items:center;gap:.4rem;background:#fff;border:1px solid #e5e7eb;padding:.4rem .9rem;border-radius:7px;font-size:.83rem;color:#555;text-decoration:none;font-weight:500;transition:border-color .15s,color .15s}
    .cal-nav a:hover{border-color:#FC4C02;color:#FC4C02}
    .cal-nav-title{font-size:1.05rem;font-weight:700;color:#1a1a1a}
    .calendar-wrapper{overflow-x:auto}
    .calendar{min-width:900px;border-radius:12px;overflow:hidden;box-shadow:0 1px 5px rgba(0,0,0,.07)}
    .cal-col-template{display:grid;grid-template-columns:64px repeat(7,1fr) 48px}
    .cal-header-row{background:#f8f9fa;border-bottom:2px solid #e5e7eb}
    .cal-header-row .ch{padding:.6rem .4rem;text-align:center;font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#888}
    .cal-header-row .ch:first-child{text-align:left;padding-left:.65rem}
    .cal-week{border-bottom:1px solid #f0f0f0;background:#fff}
    .cal-week.current-week{background:#fffaf8;border-left:3px solid #FC4C02}
    .cal-week.current-week .cal-week-label{color:#FC4C02}
    .cal-week-label{padding:.55rem .3rem .55rem .65rem;font-size:.68rem;font-weight:600;color:#bbb;display:flex;align-items:flex-start;padding-top:.7rem}
    .cal-day{padding:.4rem .3rem .5rem;border-right:1px solid #f5f5f5;min-height:90px;vertical-align:top;position:relative}
    .cal-day.out-month{background:#fafafa}
    .cal-day.out-month .day-num{color:#ccc}
    .cal-day.out-month .run-card{opacity:.45}
    .cal-day.out-month .day-badge{opacity:.45}
    .day-num{display:inline-flex;align-items:center;justify-content:center;width:21px;height:21px;font-size:.76rem;font-weight:500;border-radius:50%;color:#555;margin-bottom:.3rem}
    .cal-day.is-today .day-num{background:#FC4C02;color:#fff;font-weight:700}
    .goal-cell{display:flex;align-items:center;justify-content:center;padding:.4rem .2rem}
    .goal-icon{font-size:1rem;line-height:1}
    .goal-icon.met{color:#059669}
    .goal-icon.unmet{color:#d1d5db}
    .goal-icon.future{color:#e5e7eb}

    /* ── Mini run card in calendar cell ── */
    .run-card{
      display:flex;align-items:stretch;gap:0;
      background:#fff3ee;border:1px solid #fde0d0;border-radius:7px;
      margin-bottom:.3rem;overflow:hidden;cursor:pointer;
      transition:border-color .12s,box-shadow .12s;
    }
    .run-card:hover{border-color:#FC4C02;box-shadow:0 1px 5px rgba(252,76,2,.18)}
    .run-card-map{flex-shrink:0;background:#fff8f5;border-right:1px solid #fde0d0;display:flex;align-items:center;justify-content:center;width:56px}
    .run-card-map.no-map{width:0;border-right:none}
    .run-card-stats{padding:.3rem .45rem;display:flex;flex-direction:column;justify-content:center;gap:.1rem;min-width:0}
    .rc-dist{font-size:.72rem;font-weight:700;color:#d84900;white-space:nowrap}
    .rc-pace{font-size:.67rem;color:#e07030;white-space:nowrap}
    .rc-hr{font-size:.65rem;color:#c0392b;white-space:nowrap}

    /* ── Non-run badge ── */
    .day-badge{display:inline-flex;align-items:center;gap:2px;padding:1px 5px;border-radius:10px;font-size:.65rem;font-weight:600;white-space:nowrap;margin-bottom:.2rem;margin-right:.2rem}
    .day-badge.band{background:#ede9fe;color:#6d28d9;cursor:pointer}
    .day-badge.band:hover{background:#ddd6fe}
    .day-badge.other{background:#f0f0f0;color:#555}

    /* ── Activity detail modal ── */
    .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:300;display:none;align-items:center;justify-content:center}
    .modal-overlay.open{display:flex}
    .modal{background:#fff;border-radius:16px;box-shadow:0 12px 48px rgba(0,0,0,.22);width:500px;max-width:94vw;max-height:90vh;display:flex;flex-direction:column;overflow:hidden}
    .modal-header{display:flex;align-items:flex-start;justify-content:space-between;padding:1.1rem 1.3rem .9rem;border-bottom:1px solid #f0f0f0;gap:.75rem}
    .modal-title{font-size:1rem;font-weight:700;line-height:1.3;color:#1a1a1a}
    .modal-subtitle{font-size:.78rem;color:#888;margin-top:.2rem}
    .modal-close{background:none;border:none;font-size:1.4rem;cursor:pointer;color:#bbb;line-height:1;flex-shrink:0;padding:0;transition:color .15s}
    .modal-close:hover{color:#333}
    .modal-body{overflow-y:auto;padding:1.1rem 1.3rem 1.3rem}
    .modal-map{width:100%;height:200px;background:#fff8f5;border-radius:10px;overflow:hidden;display:flex;align-items:center;justify-content:center;margin-bottom:1.1rem;border:1px solid #f0ece8}
    .modal-map svg{width:100%;height:100%}
    .modal-map.no-map{display:none}
    .modal-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:.6rem;margin-bottom:1rem}
    .modal-stat{background:#f8f9fa;border-radius:9px;padding:.6rem .5rem;text-align:center}
    .modal-stat-label{display:block;font-size:.62rem;color:#999;text-transform:uppercase;letter-spacing:.04em;margin-bottom:.2rem}
    .modal-stat-value{display:block;font-size:.9rem;font-weight:700;color:#1a1a1a}
    .modal-stat-value.heart{color:#e53e3e}
    .strava-link{display:inline-flex;align-items:center;gap:.4rem;color:#FC4C02;font-size:.82rem;font-weight:600;text-decoration:none;padding:.45rem .9rem;border:1px solid #FC4C02;border-radius:7px;transition:background .15s}
    .strava-link:hover{background:#fff3ee}
    .strava-link svg{width:14px;height:14px;fill:currentColor}

    /* ── Day bands popover (lightweight) ── */
    .pop-overlay{position:fixed;inset:0;z-index:200;display:none}
    .pop-overlay.open{display:block}
    .popover{position:fixed;background:#fff;border-radius:12px;box-shadow:0 6px 28px rgba(0,0,0,.16);width:300px;max-width:90vw;z-index:201;display:none;overflow:hidden}
    .popover.open{display:block}
    .pop-header{display:flex;align-items:center;justify-content:space-between;padding:.8rem 1rem;border-bottom:1px solid #f0f0f0}
    .pop-header-date{font-size:.88rem;font-weight:700}
    .pop-close{background:none;border:none;font-size:1.2rem;cursor:pointer;color:#bbb;line-height:1;padding:0 .15rem}
    .pop-close:hover{color:#333}
    .pop-body{padding:.7rem 1rem .9rem}
    .pop-band-item{padding:.5rem .65rem;background:#f5f3ff;border-radius:7px;margin-bottom:.35rem;font-size:.83rem}
    .pop-band-item:last-child{margin-bottom:0}
    .pop-band-note{font-size:.77rem;color:#7c3aed;margin-top:.15rem}

    /* ── Top table ── */
    .toolbar{display:flex;align-items:center;gap:1rem;margin-bottom:1.25rem;flex-wrap:wrap}
    .toolbar label{font-size:.88rem;color:#555;font-weight:500}
    .toolbar select{padding:.4rem .75rem;border:1px solid #ddd;border-radius:7px;font-size:.88rem;background:#fff;cursor:pointer;color:#1a1a1a}
    .toolbar select:focus{outline:none;border-color:#FC4C02}
    .top-table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 5px rgba(0,0,0,.07)}
    .top-table thead{background:#f8f9fa}
    .top-table th{padding:.8rem 1rem;text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:#888;font-weight:600}
    .top-table td{padding:.85rem 1rem;font-size:.86rem;border-top:1px solid #f0f0f0;vertical-align:middle}
    .top-table tr:hover td{background:#fafafa}
    .rank{font-weight:700;color:#ccc;width:2.2rem}
    .rank-1{color:#F5A623}.rank-2{color:#9B9B9B}.rank-3{color:#C47722}
    .act-name{font-weight:600;max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .act-date{color:#888;font-size:.8rem}
    .badge{display:inline-block;background:#fff3ee;color:#FC4C02;border-radius:5px;padding:.12rem .45rem;font-size:.7rem;font-weight:600}
    .hr-pill::before{content:'♥ ';color:#e53e3e}

    /* ── Band sessions page ── */
    .form-card{background:#fff;border-radius:12px;padding:1.4rem;box-shadow:0 1px 5px rgba(0,0,0,.06);margin-bottom:1.5rem;max-width:480px}
    .form-card h2{font-size:1rem;font-weight:700;margin-bottom:1rem;color:#1a1a1a}
    .form-row{margin-bottom:.85rem}
    .form-row label{display:block;font-size:.8rem;font-weight:600;color:#555;margin-bottom:.3rem}
    .form-row input,.form-row textarea{width:100%;border:1px solid #ddd;border-radius:7px;padding:.5rem .75rem;font-size:.88rem;font-family:inherit;resize:vertical;color:#1a1a1a}
    .form-row input:focus,.form-row textarea:focus{outline:none;border-color:#FC4C02}
    .btn-primary{background:#7c3aed;color:#fff;border:none;padding:.6rem 1.3rem;border-radius:7px;font-size:.88rem;font-weight:600;cursor:pointer;transition:background .2s}
    .btn-primary:hover{background:#6d28d9}
    .sessions-list{background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 5px rgba(0,0,0,.06)}
    .session-item{display:flex;align-items:flex-start;gap:.85rem;padding:.9rem 1.2rem;border-bottom:1px solid #f5f5f5}
    .session-item:last-child{border-bottom:none}
    .session-date{font-size:.82rem;font-weight:700;color:#7c3aed;min-width:90px}
    .session-note{font-size:.85rem;color:#555;flex:1}
    .session-note.empty-note{color:#ccc;font-style:italic}
    .btn-delete{background:none;border:1px solid #fecaca;color:#e53e3e;padding:.25rem .65rem;border-radius:5px;font-size:.75rem;cursor:pointer;flex-shrink:0;transition:background .15s}
    .btn-delete:hover{background:#fee2e2}
  </style>
</head>
<body>
  <header>
    <div class="header-left">
      <a href="/dashboard" class="brand">
        <span class="brand-icon">🏅</span>
        <span class="brand-name">Strava</span>
      </a>
      <nav>
        <a href="/dashboard" class="${activeTab === 'dashboard' ? 'active' : ''}">Calendar</a>
        <a href="/top"       class="${activeTab === 'top'       ? 'active' : ''}">Top Activities</a>
        <a href="/bands"     class="${activeTab === 'bands'     ? 'active' : ''}">Resistance Bands</a>
      </nav>
    </div>
    <div class="header-right">
      ${streakHtml}
      <span class="athlete-name">${escapeHtml(athleteName)}</span>
      <a href="/logout" class="btn-logout">Logout</a>
    </div>
  </header>
  <main>${body}</main>

  <!-- Activity detail modal -->
  <div class="modal-overlay" id="actOverlay" onclick="if(event.target===this)closeModal()">
    <div class="modal" id="actModal">
      <div class="modal-header">
        <div>
          <div class="modal-title" id="actTitle"></div>
          <div class="modal-subtitle" id="actSubtitle"></div>
        </div>
        <button class="modal-close" onclick="closeModal()">×</button>
      </div>
      <div class="modal-body">
        <div class="modal-map" id="actMap"></div>
        <div class="modal-stats" id="actStats"></div>
        <a class="strava-link" id="actLink" href="#" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24"><path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7 13.828h4.169"/></svg>
          View on Strava
        </a>
      </div>
    </div>
  </div>

  <!-- Band sessions popover -->
  <div class="pop-overlay" id="popOverlay" onclick="closePopover()"></div>
  <div class="popover" id="popover">
    <div class="pop-header">
      <span class="pop-header-date" id="pop-date"></span>
      <button class="pop-close" onclick="closePopover()">×</button>
    </div>
    <div class="pop-body" id="pop-body"></div>
  </div>

  <script>
    // ── Data injected server-side ────────────────────────────────────────────
    const ACTIVITY_DATA = __ACTIVITY_DATA__;
    const BAND_DATA     = __BAND_DATA__;

    // ── Activity detail modal ────────────────────────────────────────────────
    function openActivity(id) {
      const a = ACTIVITY_DATA[id];
      if (!a) return;

      document.getElementById('actTitle').textContent = a.name;
      document.getElementById('actSubtitle').textContent =
        a.type + '  ·  ' + new Date(a.start_date_local).toLocaleDateString('en-US', {
          weekday:'long', month:'long', day:'numeric', year:'numeric'
        });
      document.getElementById('actLink').href = 'https://www.strava.com/activities/' + id;

      // Map SVG
      const mapEl = document.getElementById('actMap');
      if (a.svg_large) {
        mapEl.innerHTML = a.svg_large;
        mapEl.classList.remove('no-map');
      } else {
        mapEl.classList.add('no-map');
      }

      // Stats
      const stats = [];
      const isRun = ['Run','VirtualRun','TrailRun'].includes(a.type);
      stats.push({ label:'Distance',   value: fmtDistLong(a.distance) });
      stats.push({ label:'Moving time', value: fmtDur(a.moving_time) });
      if (isRun && a.distance && a.moving_time) {
        stats.push({ label:'Avg pace', value: fmtPace(a.distance, a.moving_time) || '—' });
      } else if (a.average_speed) {
        stats.push({ label:'Avg speed', value: fmtSpeed(a.average_speed) });
      } else {
        stats.push({ label:'Elapsed',   value: fmtDur(a.elapsed_time) });
      }
      if (a.average_heartrate) stats.push({ label:'Avg HR', value: Math.round(a.average_heartrate)+' bpm', heart:true });
      if (a.max_heartrate)     stats.push({ label:'Max HR', value: Math.round(a.max_heartrate)+' bpm', heart:true });
      if (a.total_elevation_gain != null) stats.push({ label:'Elevation', value: Math.round(a.total_elevation_gain)+' m' });

      document.getElementById('actStats').innerHTML = stats.map(s =>
        '<div class="modal-stat">'
        + '<span class="modal-stat-label">'+escHtml(s.label)+'</span>'
        + '<span class="modal-stat-value'+(s.heart?' heart':'')+'">'+escHtml(s.value)+'</span>'
        + '</div>'
      ).join('');

      document.getElementById('actOverlay').classList.add('open');
    }

    function closeModal() {
      document.getElementById('actOverlay').classList.remove('open');
    }

    // ── Band sessions popover ────────────────────────────────────────────────
    function openBandPopover(date, el) {
      const bands = BAND_DATA[date];
      if (!bands || !bands.length) return;

      const rect = el.getBoundingClientRect();
      const pop  = document.getElementById('popover');
      document.getElementById('pop-date').textContent =
        new Date(date+'T12:00:00').toLocaleDateString('en-US', {
          weekday:'short', month:'short', day:'numeric'
        });
      document.getElementById('pop-body').innerHTML = bands.map(b =>
        '<div class="pop-band-item">💪 Resistance band'
        + (b.note ? '<div class="pop-band-note">'+escHtml(b.note)+'</div>' : '')
        + '</div>'
      ).join('');

      // Position near the clicked badge, staying in viewport
      const top  = Math.min(rect.bottom + 6, window.innerHeight - 200);
      const left = Math.min(rect.left, window.innerWidth - 310);
      pop.style.top  = top + 'px';
      pop.style.left = left + 'px';
      document.getElementById('popOverlay').classList.add('open');
      pop.classList.add('open');
    }

    function closePopover() {
      document.getElementById('popOverlay').classList.remove('open');
      document.getElementById('popover').classList.remove('open');
    }

    // ── Keyboard close ───────────────────────────────────────────────────────
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { closeModal(); closePopover(); }
    });

    // ── Formatting (mirrors server-side) ────────────────────────────────────
    function fmtDistLong(m) {
      if (!m) return '—';
      return m >= 1000 ? (m/1000).toFixed(2)+' km' : Math.round(m)+' m';
    }
    function fmtDur(s) {
      if (!s) return '—';
      const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
      return h > 0 ? h+'h '+m+'m' : m+'m '+(s%60)+'s';
    }
    function fmtPace(dist, secs) {
      if (!dist || !secs || dist < 100) return null;
      const spk = secs / (dist / 1000);
      const mi  = Math.floor(spk / 60);
      const se  = Math.round(spk % 60);
      return mi+':'+(se<10?'0':'')+se+' /km';
    }
    function fmtSpeed(mps) {
      if (!mps) return null;
      return (mps*3.6).toFixed(1)+' km/h';
    }
    function escHtml(s) {
      if (typeof s !== 'string') return String(s ?? '—');
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
  </script>
</body>
</html>`;
}

// ─── Progress banner ──────────────────────────────────────────────────────────

function renderProgressBanner(prog) {
  const { runsDone, bandsDone, daysLeft, showUrgency } = prog;
  const complete = runsDone >= GOAL_RUNS && bandsDone >= GOAL_BANDS;

  if (complete) {
    return `<div class="progress-banner"><span class="goal-complete-msg">🎉 Goal complete this week!</span></div>`;
  }

  const runDots  = Array.from({ length: GOAL_RUNS },  (_, i) =>
    `<span class="dot ${i < runsDone  ? 'filled-run'  : 'empty-dot'}"></span>`).join('');
  const bandDots = Array.from({ length: GOAL_BANDS }, (_, i) =>
    `<span class="dot ${i < bandsDone ? 'filled-band' : 'empty-dot'}"></span>`).join('');

  const runsLeft  = GOAL_RUNS  - runsDone;
  const bandsLeft = GOAL_BANDS - bandsDone;
  const parts = [];
  if (runsLeft  > 0) parts.push(`<strong>${runsLeft} run${runsLeft   > 1 ? 's' : ''}</strong> to go`);
  else               parts.push('goal met for runs');
  if (bandsLeft > 0) parts.push(`<strong>${bandsLeft} band session${bandsLeft > 1 ? 's' : ''}</strong> to go`);
  else               parts.push('goal met for bands');

  const urgencyHtml = showUrgency
    ? `<div class="urgency">⏳ ${daysLeft} day${daysLeft !== 1 ? 's' : ''} left in the week</div>` : '';

  return `
  <div class="progress-banner">
    <div><div class="label">🏃 Runs</div><div class="dots">${runDots}</div><div class="progress-text">${runsDone} / ${GOAL_RUNS}</div></div>
    <div class="progress-sep"></div>
    <div><div class="label">💪 Bands</div><div class="dots">${bandDots}</div><div class="progress-text">${bandsDone} / ${GOAL_BANDS}</div></div>
    <div class="progress-sep"></div>
    <div><div class="status-msg incomplete">${parts.join(' · ')}</div>${urgencyHtml}</div>
  </div>`;
}

// ─── Calendar ─────────────────────────────────────────────────────────────────

function renderCalendar(year, month, actsByDate, bandsByDate, todayStr, weekGoals) {
  const firstDay = new Date(year, month, 1);
  const lastDay  = new Date(year, month + 1, 0);

  const weeks = [];
  let w = getWeekMonday(firstDay);
  while (w <= lastDay) { weeks.push(new Date(w)); w = addDays(w, 7); }

  const monthNames = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];
  const dayNames   = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const prevMonth  = month === 0  ? 11 : month - 1;
  const prevYear   = month === 0  ? year - 1 : year;
  const nextMonth  = month === 11 ? 0  : month + 1;
  const nextYear   = month === 11 ? year + 1 : year;

  const todayDateObj    = parseLocalDate(todayStr);
  const isCurrentMonth  = year === todayDateObj.getFullYear() && month === todayDateObj.getMonth();
  const isFutureMonth   = year > todayDateObj.getFullYear() ||
    (year === todayDateObj.getFullYear() && month > todayDateObj.getMonth());

  let html = `
  <div class="cal-nav">
    <a href="/dashboard?year=${prevYear}&month=${prevMonth}">← ${monthNames[prevMonth].slice(0,3)}</a>
    <span class="cal-nav-title">${monthNames[month]} ${year}</span>
    ${!isCurrentMonth && !isFutureMonth
      ? `<a href="/dashboard?year=${nextYear}&month=${nextMonth}">${monthNames[nextMonth].slice(0,3)} →</a>`
      : '<span></span>'}
  </div>
  <div class="calendar-wrapper"><div class="calendar">
    <div class="cal-header-row cal-col-template">
      <div class="ch">Week</div>
      ${dayNames.map(d => `<div class="ch">${d}</div>`).join('')}
      <div class="ch">✓</div>
    </div>`;

  for (const monday of weeks) {
    const mondayStr  = toDateStr(monday);
    const currentWk  = toDateStr(getWeekMonday(todayDateObj));
    const isThisWeek = mondayStr === currentWk;
    const isFuture   = monday > todayDateObj;

    let goalIcon = `<span class="goal-icon future">—</span>`;
    if (!isFuture) {
      const { runs, bands } = weekGoals[mondayStr] || { runs: 0, bands: 0 };
      goalIcon = (runs >= GOAL_RUNS && bands >= GOAL_BANDS)
        ? `<span class="goal-icon met" title="${runs} runs, ${bands} band sessions">✓</span>`
        : `<span class="goal-icon unmet" title="${runs} runs, ${bands} band sessions">✗</span>`;
    }

    const weekLabel = `${String(monday.getDate()).padStart(2,'0')}/${String(monday.getMonth()+1).padStart(2,'0')}`;
    html += `<div class="cal-week cal-col-template${isThisWeek ? ' current-week' : ''}">
      <div class="cal-week-label">${weekLabel}</div>`;

    for (let di = 0; di < 7; di++) {
      const day      = addDays(monday, di);
      const dateStr  = toDateStr(day);
      const inMonth  = day.getMonth() === month;
      const isToday  = dateStr === todayStr;
      const dayActs  = actsByDate[dateStr]  || [];
      const dayBands = bandsByDate[dateStr] || [];

      const classes = [
        'cal-day',
        !inMonth ? 'out-month' : '',
        isToday  ? 'is-today'  : '',
      ].filter(Boolean).join(' ');

      const runs   = dayActs.filter(a => RUN_TYPES.includes(a.type));
      const others = dayActs.filter(a => !RUN_TYPES.includes(a.type));

      // Mini run cards — one per run activity
      const runCardsHtml = runs.map(a => {
        const dist  = fmtDist(a.distance);
        const pace  = fmtPace(a.distance, a.moving_time);
        const hr    = a.average_heartrate ? `♥ ${Math.round(a.average_heartrate)}` : null;
        const svg   = polylineToSvg(a.map_polyline, 56, 44, 1.5);
        const mapPart = svg
          ? `<div class="run-card-map">${svg}</div>`
          : `<div class="run-card-map no-map"></div>`;
        return `<div class="run-card" onclick="openActivity(${a.id})" title="${escapeHtml(a.name)}">
          ${mapPart}
          <div class="run-card-stats">
            <span class="rc-dist">${dist}</span>
            ${pace ? `<span class="rc-pace">${pace}</span>` : ''}
            ${hr   ? `<span class="rc-hr">${hr}</span>`   : ''}
          </div>
        </div>`;
      }).join('');

      // Other activity badges
      const otherBadgesHtml = others.map(a =>
        `<span class="day-badge other">${sportIcon(a.type)}</span>`
      ).join('');

      // Band badge
      const bandBadgeHtml = dayBands.length > 0
        ? `<span class="day-badge band" onclick="event.stopPropagation();openBandPopover('${dateStr}',this)">💪${dayBands.length > 1 ? ' ×'+dayBands.length : ''}</span>`
        : '';

      html += `<div class="${classes}">
        <div class="day-num">${day.getDate()}</div>
        ${runCardsHtml}
        ${otherBadgesHtml}
        ${bandBadgeHtml}
      </div>`;
    }

    html += `<div class="goal-cell">${goalIcon}</div></div>`;
  }

  html += '</div></div>';
  return html;
}

// ─── Landing page ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  if (req.session.accessToken) return res.redirect('/dashboard');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Strava Activities</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f5f5}
    .hero{text-align:center;padding:3rem 2rem;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:480px;width:100%}
    .logo{font-size:3rem;margin-bottom:1rem}
    h1{font-size:1.8rem;color:#1a1a1a;margin-bottom:.5rem}
    p{color:#666;margin-bottom:2rem;line-height:1.5}
    .btn{display:inline-flex;align-items:center;gap:.6rem;background:#FC4C02;color:#fff;text-decoration:none;padding:.85rem 2rem;border-radius:8px;font-size:1rem;font-weight:600;transition:background .2s}
    .btn:hover{background:#e04300}
    .btn svg{width:20px;height:20px;fill:currentColor}
  </style>
</head>
<body>
  <div class="hero">
    <div class="logo">🏃</div>
    <h1>Strava Activities</h1>
    <p>Connect your Strava account to track runs, resistance band sessions, and weekly goals.</p>
    <a href="/auth/strava" class="btn">
      <svg viewBox="0 0 24 24"><path d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7 13.828h4.169"/></svg>
      Connect with Strava
    </a>
  </div>
</body>
</html>`);
});

// ─── OAuth ────────────────────────────────────────────────────────────────────

app.get('/auth/strava', (req, res) => {
  res.redirect('https://www.strava.com/oauth/authorize?' + new URLSearchParams({
    client_id: STRAVA_CLIENT_ID, redirect_uri: REDIRECT_URI,
    response_type: 'code', approval_prompt: 'auto', scope: 'activity:read_all',
  }));
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?error=access_denied');
  try {
    const { data } = await axios.post('https://www.strava.com/oauth/token', {
      client_id: STRAVA_CLIENT_ID, client_secret: STRAVA_CLIENT_SECRET,
      code, grant_type: 'authorization_code',
    });
    req.session.accessToken = data.access_token;
    req.session.athlete     = data.athlete;
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Token exchange failed:', err.response?.data || err.message);
    res.redirect('/?error=token_exchange_failed');
  }
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

app.get('/dashboard', async (req, res) => {
  if (!req.session.accessToken) return res.redirect('/');

  let syncError = null;
  try { await syncActivities(req.session.accessToken); }
  catch (err) {
    console.error('Sync error:', err.response?.data || err.message);
    syncError = 'Could not sync latest activities from Strava.';
  }

  const today    = todayDate();
  const todayStr = toDateStr(today);

  let year  = today.getFullYear();
  let month = today.getMonth();
  if (req.query.year && req.query.month) {
    const qy = parseInt(req.query.year,  10);
    const qm = parseInt(req.query.month, 10);
    if (!isNaN(qy) && !isNaN(qm) && qm >= 0 && qm <= 11) { year = qy; month = qm; }
  }

  const firstDay   = new Date(year, month, 1);
  const lastDay    = new Date(year, month + 1, 0);
  const rangeStart = toDateStr(getWeekMonday(firstDay));
  const rangeEnd   = toDateStr(addDays(getWeekMonday(lastDay), 6));

  const activitiesInRange = db.getActivitiesInRange(rangeStart, rangeEnd);
  const bandsInRange      = db.getBandSessionsInRange(rangeStart, rangeEnd);

  const actsByDate  = {};
  const bandsByDate = {};
  for (const a of activitiesInRange) {
    const d = a.start_date_local.slice(0, 10);
    (actsByDate[d] = actsByDate[d] || []).push(a);
  }
  for (const b of bandsInRange) {
    (bandsByDate[b.date] = bandsByDate[b.date] || []).push(b);
  }

  // Per-week goal counts
  const weekGoals = {};
  let wk = getWeekMonday(firstDay);
  while (wk <= lastDay) {
    const wkStr  = toDateStr(wk);
    const wkEnd  = toDateStr(addDays(wk, 6));
    const wkActs = db.getActivitiesInRange(wkStr, wkEnd);
    const wkBands = db.getBandSessionsInRange(wkStr, wkEnd);
    weekGoals[wkStr] = {
      runs:  wkActs.filter(a => RUN_TYPES.includes(a.type)).length,
      bands: wkBands.length,
    };
    wk = addDays(wk, 7);
  }

  // Build activity data map for JS modal (keyed by id)
  // Large SVG is rendered server-side so the modal doesn't need any decoding
  const activityData = {};
  for (const a of activitiesInRange) {
    activityData[a.id] = {
      name:                 a.name,
      type:                 a.type,
      start_date_local:     a.start_date_local,
      distance:             a.distance,
      moving_time:          a.moving_time,
      elapsed_time:         a.elapsed_time,
      average_heartrate:    a.average_heartrate,
      max_heartrate:        a.max_heartrate,
      average_speed:        a.average_speed,
      total_elevation_gain: a.total_elevation_gain,
      svg_large:            polylineToSvg(a.map_polyline, 460, 190, 2.5),
    };
  }

  // Band data map for JS popover (keyed by date)
  const bandData = {};
  for (const b of bandsInRange) {
    (bandData[b.date] = bandData[b.date] || []).push({ id: b.id, note: b.note });
  }

  const athlete     = req.session.athlete;
  const athleteName = athlete ? `${athlete.firstname} ${athlete.lastname}` : 'Athlete';
  const streak      = computeStreak();
  const progress    = getCurrentWeekProgress();

  const body = `
    ${syncError ? `<div class="error-banner">${escapeHtml(syncError)}</div>` : ''}
    ${renderProgressBanner(progress)}
    ${renderCalendar(year, month, actsByDate, bandsByDate, todayStr, weekGoals)}`;

  const page = htmlShell({ title:'Calendar', activeTab:'dashboard', athleteName, streak, body })
    .replace('__ACTIVITY_DATA__', JSON.stringify(activityData))
    .replace('__BAND_DATA__',     JSON.stringify(bandData));

  res.send(page);
});

// ─── Top Activities ───────────────────────────────────────────────────────────

const TYPE_MAP = {
  Running:  ['Run','VirtualRun','TrailRun'],
  Cycling:  ['Ride','VirtualRide','EBikeRide','GravelRide','MountainBikeRide'],
  Skiing:   ['AlpineSki','BackcountrySki','NordicSki'],
  Swimming: ['Swim'],
};

app.get('/top', (req, res) => {
  if (!req.session.accessToken) return res.redirect('/');

  const selectedType = TYPE_MAP[req.query.type] ? req.query.type : 'Running';
  const allowedTypes = TYPE_MAP[selectedType];
  const athlete      = req.session.athlete;
  const athleteName  = athlete ? `${athlete.firstname} ${athlete.lastname}` : 'Athlete';
  const streak       = computeStreak();

  const all        = db.getAllActivities().filter(a => allowedTypes.includes(a.type))
                       .sort((a, b) => b.distance - a.distance).slice(0, 12);
  const totalCount = db.getAllActivities().length;

  const rowsHtml = all.length === 0
    ? `<tr><td colspan="7" style="text-align:center;color:#888;padding:2rem">No ${selectedType} activities found.</td></tr>`
    : all.map((a, i) => {
        const rankClass = i < 3 ? ` rank-${i+1}` : '';
        const hr = a.average_heartrate
          ? `<span class="hr-pill">${Math.round(a.average_heartrate)} bpm</span>` : '—';
        return `<tr>
          <td class="rank${rankClass}">#${i+1}</td>
          <td><div class="act-name">${escapeHtml(a.name)}</div></td>
          <td><span class="badge">${escapeHtml(a.type)}</span></td>
          <td><strong>${fmtDistLong(a.distance)}</strong></td>
          <td>${fmtDur(a.moving_time)}</td>
          <td>${hr}</td>
          <td class="act-date">${fmtDate(a.start_date_local)}</td>
        </tr>`;
      }).join('');

  const body = `
    <p class="page-title">Top 12 Longest Activities</p>
    <div class="toolbar">
      <label for="type-sel">Activity type</label>
      <form method="GET" action="/top" style="display:inline">
        <select id="type-sel" name="type" onchange="this.form.submit()">
          ${Object.keys(TYPE_MAP).map(t =>
            `<option value="${t}"${t === selectedType ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
      </form>
      <span style="font-size:.8rem;color:#bbb">from ${totalCount} activities in database</span>
    </div>
    <table class="top-table">
      <thead><tr><th>#</th><th>Name</th><th>Type</th><th>Distance</th><th>Duration</th><th>Avg HR</th><th>Date</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;

  res.send(htmlShell({ title:'Top Activities', activeTab:'top', athleteName, streak, body })
    .replace('__ACTIVITY_DATA__', '{}').replace('__BAND_DATA__', '{}'));
});

// ─── Resistance Bands ─────────────────────────────────────────────────────────

app.get('/bands', (req, res) => {
  if (!req.session.accessToken) return res.redirect('/');

  const athlete     = req.session.athlete;
  const athleteName = athlete ? `${athlete.firstname} ${athlete.lastname}` : 'Athlete';
  const streak      = computeStreak();
  const sessions    = db.getAllBandSessions();

  const listHtml = sessions.length === 0
    ? '<p class="empty" style="padding:2rem 1.2rem">No sessions logged yet.</p>'
    : sessions.map(s => `
      <div class="session-item">
        <span class="session-date">${escapeHtml(s.date)}</span>
        <span class="session-note${s.note ? '' : ' empty-note'}">${s.note ? escapeHtml(s.note) : 'no note'}</span>
        <form method="POST" action="/bands/${s.id}/delete" style="display:inline"
              onsubmit="return confirm('Delete this session?')">
          <button class="btn-delete" type="submit">Delete</button>
        </form>
      </div>`).join('');

  const body = `
    <p class="page-title">Resistance Band Sessions</p>
    <div class="form-card">
      <h2>Log a session</h2>
      <form method="POST" action="/bands">
        <div class="form-row">
          <label for="band-date">Date</label>
          <input type="date" id="band-date" name="date" required>
        </div>
        <div class="form-row">
          <label for="band-note">Note <span style="font-weight:400;color:#aaa">(optional)</span></label>
          <textarea id="band-note" name="note" rows="2" placeholder="e.g. upper body, 3 sets…"></textarea>
        </div>
        <button type="submit" class="btn-primary">Save session</button>
      </form>
    </div>
    <div class="sessions-list">${listHtml}</div>
    <script>document.getElementById('band-date').value = new Date().toLocaleDateString('en-CA');</script>`;

  res.send(htmlShell({ title:'Resistance Bands', activeTab:'bands', athleteName, streak, body })
    .replace('__ACTIVITY_DATA__', '{}').replace('__BAND_DATA__', '{}'));
});

app.post('/bands', (req, res) => {
  if (!req.session.accessToken) return res.redirect('/');
  const { date, note } = req.body;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) db.addBandSession(date, note?.trim() || null);
  res.redirect('/bands');
});

app.post('/bands/:id/delete', (req, res) => {
  if (!req.session.accessToken) return res.redirect('/');
  const id = parseInt(req.params.id, 10);
  if (!isNaN(id)) db.deleteBandSession(id);
  res.redirect('/bands');
});

// ─── Logout ───────────────────────────────────────────────────────────────────

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
