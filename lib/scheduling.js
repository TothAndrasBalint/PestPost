// /lib/scheduling.js
import { supabaseAdmin } from './supabase.js';

const TZ = 'Europe/Budapest';
const DEFAULTS = {
  weekday: ['18:30'],   // Mon–Fri preferred time(s)
  weekend: ['10:30'],   // Sat–Sun preferred time(s)
  min_gap_hours: 20,    // cooldown between posts
  max_per_day: 1,
  quiet_hours: [],      // e.g., ["21:00","06:30"] if you want later
  jitter_sec: 720       // ±12 minutes
};

export async function loadWindows() {
  try {
    const { data, error } = await supabaseAdmin
      .from('settings').select('value').eq('key', 'scheduling_windows').single();
    if (error || !data?.value) return DEFAULTS;
    return { ...DEFAULTS, ...data.value };
  } catch {
    return DEFAULTS;
  }
}

// ---- timezone helpers (no external deps) ----
function pad(n){ return String(n).padStart(2,'0'); }

function offsetLabel(tz, atDate) {
  // returns like "+02:00"
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(atDate);
  const raw = (parts.find(p => p.type === 'timeZoneName')?.value || 'GMT+00:00').replace('GMT','').trim();
  const m = raw.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) return '+00:00';
  const hh = pad(m[2]); const mm = pad(m[3] || '00');
  return `${m[1]}${hh}:${mm}`;
}

function partsInTZ(tz, d) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d);
  const g = t => Number(f.find(p => p.type === t).value);
  const Y=g('year'), M=g('month'), D=g('day'), h=g('hour'), m=g('minute'), s=g('second');
  const off = offsetLabel(tz, d);
  return { Y, M, D, h, m, s, off, iso: `${Y}-${pad(M)}-${pad(D)}T${pad(h)}:${pad(m)}:${pad(s)}${off}` };
}

function buildISO(tz, Y, M, D, h, m, s){
  const off = offsetLabel(tz, new Date(Date.UTC(Y, M-1, D, h, m, s)));
  return `${Y}-${pad(M)}-${pad(D)}T${pad(h)}:${pad(m)}:${pad(s)}${off}`;
}

function isWeekend(tz, d){
  const { iso } = partsInTZ(tz, d);
  const local = new Date(iso);
  const dow = local.getUTCDay();
  return dow === 0 || dow === 6;
}

function withinQuiet(tz, d, quiet){
  if (!quiet || quiet.length !== 2) return false;
  const [qStart, qEnd] = quiet; // "21:00","06:30"
  const { Y, M, D } = partsInTZ(tz, d);
  const mk = t => {
    const [hh, mm] = t.split(':').map(Number);
    return new Date(buildISO(tz, Y, M, D, hh, mm, 0));
  };
  const s = mk(qStart), e = mk(qEnd);
  if (e > s) return d >= s && d <= e;         // same-day quiet window
  return d >= s || d <= new Date(e.getTime() + 24*3600*1000); // overnight quiet window
}

// Core: next slot today/tomorrow in TZ, honoring quiet + simple cooldown
export function nextSlotSimple({ windows, nowUtc = new Date(), tz = TZ, lastAt = null }) {
  const today = partsInTZ(tz, nowUtc);
  const baseMidnightUTC = new Date(`${today.Y}-${pad(today.M)}-${pad(today.D)}T00:00:00Z`).getTime();

  const candidates = [];
  for (let dOffset = 0; dOffset < 2; dOffset++) {
    const dayRef = new Date(baseMidnightUTC + dOffset * 86400000);
    const weekend = isWeekend(tz, dayRef);
    const slots = weekend ? (windows.weekend || []) : (windows.weekday || []);
    for (const t of slots) {
      const [hh, mm] = String(t).split(':').map(Number);
      const { Y, M, D } = partsInTZ(tz, dayRef);
      const iso = buildISO(tz, Y, M, D, hh, mm, 0);
      const dt = new Date(iso);
      if (dt > nowUtc) candidates.push(dt);
    }
  }

  // Cooldown + quiet hours filters
  const minGapMs = (windows.min_gap_hours ?? 20) * 3600 * 1000;
  const ok = candidates.filter(dt => {
    if (withinQuiet(tz, dt, windows.quiet_hours)) return false;
    if (lastAt && (dt.getTime() - new Date(lastAt).getTime()) < minGapMs) return false;
    return true;
  });

  const pick = ok[0] || candidates[0] || new Date(nowUtc.getTime() + 30*60*1000);
  const jitter = ((Math.random() * (windows.jitter_sec ?? 720)) * 1000) * (Math.random() < 0.5 ? -1 : 1);
  return new Date(pick.getTime() + jitter).toISOString();
}
