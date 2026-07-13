// HYROX Race Tracker — sync job.
// Runs at 14:00 and 23:00 Europe/Rome via GitHub Actions (see .github/workflows/sync.yml).
// Reads each athlete's Google Sheet CSV, scores workouts, updates Supabase, awards trophies.
//
// Env vars (GitHub Actions secrets — never in code):
//   SUPABASE_URL             e.g. https://kdeqfsnteprdxeboirus.supabase.co
//   SUPABASE_SERVICE_KEY     service_role key

import { pathToFileURL } from 'node:url';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RACE_START = new Date(Date.UTC(2026, 6, 6)); // the duel officially starts Mon 6 Jul — earlier sessions don't score
const REQUEST_TIMEOUT_MS = 20_000;

// ---- scoring config: one completed workout + running distance, adjusted gently by RPE ----
const SCORE = {
  workout: 50,
  perKm: 7,
  rpeRef: 7,
  rpeStep: 0.05,
};

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    signal: opts.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.method === 'POST' ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// -- CSV parsing (handles quoted fields) --
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function utcDate(year, month, day) {
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? date : null;
}
function parseSheetDate(s) {
  // "Mon 22 Jun", "July 6", "2026-07-06" -> training-plan year dates.
  const text = String(s || '').trim();
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (isoDate) {
    return utcDate(+isoDate[1], +isoDate[2] - 1, +isoDate[3]);
  }
  for (const m of text.matchAll(/\b(\d{1,2})\s+([A-Za-z]{3,9})\b/g)) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo != null) return utcDate(2026, mo, +m[1]);
  }
  for (const m of text.matchAll(/\b([A-Za-z]{3,9})\s+(\d{1,2})\b/g)) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo != null) return utcDate(2026, mo, +m[2]);
  }
  return null;
}
const iso = (d) => d.toISOString().slice(0, 10);

const normHeader = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function headerMap(headers) {
  const map = new Map();
  headers.forEach((h, i) => {
    const key = normHeader(h);
    if (key && !map.has(key)) map.set(key, i);
  });
  return map;
}
function cell(row, map, aliases, fallbackIndex = null) {
  for (const alias of aliases) {
    const idx = map.get(normHeader(alias));
    if (idx != null) return row[idx] ?? '';
  }
  return fallbackIndex == null ? '' : row[fallbackIndex] ?? '';
}
function cellNum(row, map, aliases, fallbackIndex = null) {
  const raw = cell(row, map, aliases, fallbackIndex);
  if (raw == null || String(raw).trim() === '') return null;
  const m = String(raw).replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
const nonnegative = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};
const validRpe = (value) => {
  const number = Number.parseFloat(String(value ?? '').replace(',', '.'));
  return Number.isFinite(number) && number >= 1 && number <= 10 ? number : null;
};
function firstLineDate(text) {
  const first = String(text || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean);
  return first ? parseSheetDate(first) : null;
}

const REQUIRED_SCORING_HEADERS = {
  done: ['done'],
  km: ['km', 'run km'],
  rpe: ['rpe'],
};

function validateScoringHeaders(headers) {
  const map = headerMap(headers);
  const missing = Object.entries(REQUIRED_SCORING_HEADERS)
    .filter(([, aliases]) => !aliases.some((alias) => map.has(normHeader(alias))))
    .map(([name]) => name.toUpperCase());
  if (missing.length) throw new Error(`missing required scoring columns: ${missing.join(', ')}`);
  return map;
}

function rpeMultiplier(rpe) {
  const value = validRpe(rpe);
  return value == null ? 1 : 1 + (value - SCORE.rpeRef) * SCORE.rpeStep;
}

function scoreWorkout({ status, km, rpe }) {
  if (status !== 'completed') return 0;
  const subtotal = SCORE.workout + nonnegative(km) * SCORE.perKm;
  return Math.round(subtotal * rpeMultiplier(rpe) * 10) / 10;
}

function workoutStatus({ isRest, logged, skipped }) {
  if (isRest) return 'rest';
  if (logged) return 'completed';
  return skipped ? 'skipped' : 'pending';
}

function applyMovedWorkoutGrace(normalizedRows) {
  const completedDates = new Set(
    normalizedRows
      .filter((n) => n?.logged && !n.skipped)
      .map((n) => iso(n.date)),
  );
  return normalizedRows.map((n) => {
    if (!n || n.logged || !n.skipped || !completedDates.has(iso(n.date))) return n;
    return { ...n, skipped: false };
  });
}

function publicWorkoutTitle(session) {
  const title = String(session || '').replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 80) : 'Workout';
}

function isRecoveryPlan(planned) {
  const text = String(planned || '');
  return /^\s*(recovery|rest)\b/i.test(text)
    || (/\b(?:intervals?|workout|session)\s+(?:were\s+)?moved\b/i.test(text) && /\b(rest|shakeout|recovery)\b/i.test(text))
    || (/\btravel\s+day\b/i.test(text) && /\b(rest|shakeout|recovery)\b/i.test(text));
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}
function isoWeekStart(period) {
  const [, year, week] = /^(\d{4})-W(\d{2})$/.exec(period) || [];
  if (!year) return null;
  const jan4 = new Date(Date.UTC(+year, 0, 4));
  const day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - day + 1 + (+week - 1) * 7);
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}
function isoWeekClosesAt(period) {
  const monday = isoWeekStart(period);
  if (!monday) return null;
  const close = new Date(monday);
  close.setUTCDate(monday.getUTCDate() + 6);
  close.setUTCHours(23, 0, 0, 0);
  return close;
}
function monthClosesAt(period) {
  const [, year, month] = /^(\d{4})-(\d{2})$/.exec(period) || [];
  if (!year) return null;
  return new Date(Date.UTC(+year, +month, 0, 23, 0, 0, 0));
}

// Both existing sheet layouts are supported, but scoring always comes from the
// same explicit columns: Done | KM | RPE. Free text remains private context only.
function normalizeRow(r, format, today) {
  const map = headerMap(format.headers || []);
  const done = ['TRUE', 'YES', '1', 'DONE'].includes(String(cell(r, map, ['done'])).trim().toUpperCase());
  const km = nonnegative(cellNum(r, map, ['km', 'run km']));
  const graceDays = (plannedDate) => (today - plannedDate) / 86400000;

  if (format.name === 'checkbox') {
    const plannedDate = parseSheetDate(cell(r, map, ['date'], 4));
    if (!plannedDate) return null;
    const actual = cell(r, map, ['actual workout', 'actually done', 'actual notes', 'result'], 9).trim(); // optional free-text column
    const actualDate = parseSheetDate(cell(r, map, ['actual date', 'completed date', 'workout date'])) || firstLineDate(actual) || plannedDate;
    const sessionTitle = cell(r, map, ['session'], 5).trim();
    const planned = [sessionTitle, cell(r, map, ['planned workout', 'what to do', 'planned'], 7)].filter(Boolean).join(' — ');
    // grace period: an unticked session only counts as skipped after 2 days
    return {
      date: done ? actualDate : plannedDate,
      idDate: plannedDate,
      planned,
      sessionTitle,
      result: done ? (actual || 'TRUE') : '',
      rpeRaw: cell(r, map, ['rpe']),
      notes: cell(r, map, ['score notes', 'notes']),
      km,
      logged: done,
      skipped: !done && graceDays(plannedDate) > 2,
    };
  }
  const plannedDate = parseSheetDate(cell(r, map, ['date'], 0));
  if (!plannedDate) return null;
  const sessionTitle = cell(r, map, ['session coach fills detailed each week', 'session', 'planned'], 3).trim();
  const planned = sessionTitle;
  const result = cell(r, map, ['my result weights reps time', 'my result', 'result'], 4);
  const notes = cell(r, map, ['notes'], 6);
  const actualDate = parseSheetDate(cell(r, map, ['actual date', 'completed date', 'workout date'])) || plannedDate;
  return {
    date: done ? actualDate : plannedDate,
    idDate: plannedDate,
    planned,
    sessionTitle,
    result: done ? (result || 'TRUE') : '',
    rpeRaw: cell(r, map, ['rpe']),
    notes,
    km,
    logged: done,
    skipped: !done && graceDays(plannedDate) > 2,
  };
}

async function syncAthlete(athlete, today) {
  const existing = Object.fromEntries(
    (await sb(`workouts?athlete_id=eq.${athlete.id}&select=id`, { method: 'GET', headers: { Prefer: '' } }))
      .map((w) => [w.id, w]),
  );
  const res = await fetch(athlete.sheet_csv_url, { redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`sheet ${athlete.id}: ${res.status}`);
  const rows = parseCsv(await res.text());
  const header = rows.findIndex((r) => {
    const map = headerMap(r);
    return map.has('date') && [...map.keys()].some((key) => key.startsWith('session'));
  });
  if (header === -1) throw new Error(`sheet ${athlete.id}: no recognizable header row`);
  const headers = rows[header];
  validateScoringHeaders(headers);
  const normalizedHeaders = headers.map(normHeader);
  const formatName = normalizedHeaders.some((key) => key.startsWith('myresult')) ? 'coach' : 'checkbox';
  const format = { name: formatName, headers };
  const workouts = [];
  const normalizedRows = applyMovedWorkoutGrace(rows.slice(header + 1).map((r) => normalizeRow(r, format, today)).filter(Boolean));
  if (!normalizedRows.length) throw new Error(`sheet ${athlete.id}: no workout rows found; refusing to erase stored data`);
  const dateOccurrences = new Map();
  for (const n of normalizedRows) {
    // future-dated rows are skipped UNLESS already done (sessions completed ahead of plan count now)
    if (!n || n.date < RACE_START || (n.date > today && !n.logged)) continue;
    const { date, planned, sessionTitle, result, rpeRaw, notes, logged, skipped } = n;
    const isRest = isRecoveryPlan(planned);

    const baseId = `${athlete.id}:${iso(n.idDate || date)}`;
    const occurrence = (dateOccurrences.get(baseId) || 0) + 1;
    dateOccurrences.set(baseId, occurrence);
    const id = occurrence === 1 ? baseId : `${baseId}:${occurrence}`;
    // Planned recovery rows never earn the completion bonus, even when their
    // sheet checkbox is ticked. Log a replacement workout as its own row.
    const status = workoutStatus({ isRest, logged, skipped });
    const km = status === 'completed' ? nonnegative(n.km) : 0;
    const rpe = validRpe(rpeRaw);
    const points = scoreWorkout({ status, km, rpe });

    workouts.push({
      id, athlete_id: athlete.id, date: iso(date),
      planned, result_raw: result, notes, rpe,
      status, km, kg_volume: 0,
      points, parsed_by: 'structured',
      public_title: publicWorkoutTitle(sessionTitle), updated_at: new Date().toISOString(),
    });
  }
  if (workouts.length) await sb('workouts?on_conflict=id', { method: 'POST', body: JSON.stringify(workouts) });
  const currentIds = new Set(workouts.map((w) => w.id));
  const staleIds = Object.keys(existing).filter((id) => !currentIds.has(id));
  for (const id of staleIds) {
    await sb(`workouts?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  return workouts;
}

function computeState(workouts, now = new Date()) {
  // streak: consecutive planned sessions completed (not calendar days — plans differ:
  // Andrea trains 7 days/week, Paw 5), counting back from the most recent resolved session
  const resolved = workouts.filter((w) => w.status !== 'pending').sort((a, b) => a.date.localeCompare(b.date));
  let streak = 0;
  for (let i = resolved.length - 1; i >= 0; i--) {
    if (resolved[i].status === 'completed' || resolved[i].status === 'rest') streak++;
    else break;
  }
  const thisWeek = isoWeek(now);
  const base = workouts.reduce((s, w) => s + w.points, 0);
  return {
    total_points: Math.round(base * 10) / 10,
    week_points: Math.round(workouts.filter((w) => isoWeek(new Date(w.date)) === thisWeek).reduce((s, w) => s + w.points, 0) * 10) / 10,
    streak,
    total_km: Math.round(workouts.reduce((s, w) => s + w.km, 0) * 10) / 10,
    total_kg: 0,
    sessions_completed: workouts.filter((w) => w.status === 'completed').length,
    sessions_skipped: workouts.filter((w) => w.status === 'skipped').length,
  };
}

async function loadStoredWorkouts(athleteId) {
  return sb(`workouts?athlete_id=eq.${athleteId}&select=id,athlete_id,date,status,km,points`, {
    method: 'GET', headers: { Prefer: '' },
  });
}

async function awardTrophies(athletes, allWorkouts, now) {
  const trophies = [];
  const award = (id, athlete_id, kind, label, emoji, period = null) =>
    trophies.push({ id, athlete_id, kind, label, emoji, period, awarded_at: now.toISOString() });

  // Weekly medals are catch-up/idempotent: any closed ISO week can be awarded.
  const closedWeeks = new Set();
  for (const workouts of Object.values(allWorkouts)) {
    for (const w of workouts) {
      const wk = isoWeek(new Date(w.date));
      const closesAt = isoWeekClosesAt(wk);
      if (closesAt && closesAt <= now) closedWeeks.add(wk);
    }
  }
  for (const wk of [...closedWeeks].sort()) {
    const scores = athletes.map((a) => ({ a, pts: allWorkouts[a.id].filter((w) => isoWeek(new Date(w.date)) === wk).reduce((s, w) => s + w.points, 0) }));
    scores.sort((x, y) => y.pts - x.pts);
    if (scores[0].pts > 0 && scores[0].pts !== scores[1]?.pts)
      award(`weekly:${wk}`, scores[0].a.id, 'weekly', `Week ${wk.split('W')[1]} champion`, '🥇', wk);
  }

  // Monthly belts are catch-up/idempotent too.
  const closedMonths = new Set();
  for (const workouts of Object.values(allWorkouts)) {
    for (const w of workouts) {
      const mo = w.date.slice(0, 7);
      const closesAt = monthClosesAt(mo);
      if (closesAt && closesAt <= now) closedMonths.add(mo);
    }
  }
  for (const mo of [...closedMonths].sort()) {
    const scores = athletes.map((a) => ({ a, pts: allWorkouts[a.id].filter((w) => w.date.startsWith(mo)).reduce((s, w) => s + w.points, 0) }));
    scores.sort((x, y) => y.pts - x.pts);
    if (scores[0].pts > 0 && scores[0].pts !== scores[1]?.pts)
      award(`monthly:${mo}`, scores[0].a.id, 'monthly', `${new Date(`${mo}-01T00:00:00Z`).toLocaleString('en', { month: 'long' })} championship belt`, '🏆', mo);
  }
  // Milestone badges
  for (const a of athletes) {
    const km = allWorkouts[a.id].reduce((s, w) => s + w.km, 0);
    if (km >= 100) award(`badge:100km:${a.id}`, a.id, 'badge', '100 km club', '👟');
  }
  if (trophies.length)
    await sb('trophies?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(trophies) });
  return trophies.length;
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY');
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
  const athletes = await sb('athletes?select=*', { method: 'GET', headers: { Prefer: '' } });
  const allWorkouts = {};
  let allSynced = true;
  const failures = [];
  for (const a of athletes) {
    if (!a.sheet_csv_url) {
      allWorkouts[a.id] = await loadStoredWorkouts(a.id);
      console.log(`${a.name}: no sheet configured; preserving ${allWorkouts[a.id].length} stored workouts`);
      continue;
    }
    // one athlete's broken/private sheet must not take down the other's sync
    try {
      allWorkouts[a.id] = await syncAthlete(a, now);
      const state = computeState(allWorkouts[a.id], now);
      await sb(`race_state?athlete_id=eq.${a.id}`, { method: 'PATCH', body: JSON.stringify({ ...state, updated_at: new Date().toISOString() }) });
      console.log(a.name, state);
    } catch (e) {
      allWorkouts[a.id] = [];
      allSynced = false;
      failures.push(a.id);
      console.error(`sync failed for ${a.id}:`, e.message);
    }
  }
  const awarded = allSynced ? await awardTrophies(athletes, allWorkouts, now) : 0;
  await sb('sync_log', { method: 'POST', body: JSON.stringify({ detail: `synced ${athletes.length} athletes${allSynced ? '' : ' with failures'}, ${awarded} trophies` }) });
  if (!allSynced) throw new Error(`Sync failed for: ${failures.join(', ')}`);
  console.log('done');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

export {
  SCORE,
  applyMovedWorkoutGrace,
  computeState,
  firstLineDate,
  headerMap,
  isRecoveryPlan,
  normalizeRow,
  parseCsv,
  parseSheetDate,
  publicWorkoutTitle,
  rpeMultiplier,
  scoreWorkout,
  validateScoringHeaders,
  workoutStatus,
};
