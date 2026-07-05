// HYROX Race Tracker — sync job.
// Runs at 14:00 and 23:00 Europe/Rome via GitHub Actions (see .github/workflows/sync.yml).
// Reads each athlete's Google Sheet CSV, scores workouts, updates Supabase, awards trophies.
//
// Env vars (GitHub Actions secrets — never in code):
//   SUPABASE_URL             e.g. https://kdeqfsnteprdxeboirus.supabase.co
//   SUPABASE_SERVICE_KEY     service_role key
//   CLAUDE_CODE_OAUTH_TOKEN  in CI only — lets `claude -p` use the Claude subscription
//                            (generate once with `claude setup-token`). Locally the
//                            installed claude CLI is already authenticated.
// Free-text results are parsed by `claude -p`; regex fallback if the CLI is unavailable.
// Rows whose result text hasn't changed since the last sync are never re-parsed.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RACE_DAY = new Date('2026-10-17');
const RACE_START = new Date(Date.UTC(2026, 6, 6)); // the duel officially starts Mon 6 Jul — earlier sessions don't score

// ---- scoring config: argue about fairness here ----
const SCORE = {
  base: 50,            // points for completing the planned session
  rpeRef: 7,           // base is multiplied by rpe/rpeRef (missing RPE -> 1.0)
  perKm: 10,           // bonus per km run
  per100kg: 1,         // bonus per 100 kg of lifted volume
  restDay: 10,         // doing the prescribed recovery still pays
  streakPerDay: 5,     // bonus per consecutive active day, capped
  streakCap: 50,
};

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
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
function parseSheetDate(s) {
  // "Mon 22 Jun" -> Date in the training-plan year (Jun-Oct 2026)
  const m = /(\d{1,2})\s+([A-Za-z]{3})/.exec(s || '');
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  if (mo == null) return null;
  return new Date(Date.UTC(2026, mo, +m[1]));
}
const iso = (d) => d.toISOString().slice(0, 10);

// -- regex fallback extraction of km and kg-volume from free text --
function regexExtract(text) {
  let km = 0, kg = 0;
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)\s*km\b(?!\/)/gi)) km += parseFloat(m[1].replace(',', '.')); // (?!\/) skips "km/h" speeds
  for (const m of text.matchAll(/(\d{3,4})\s*m\b/gi)) km += parseInt(m[1]) / 1000; // "2305m", "800m"
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)\s*kg\b/gi)) kg += parseFloat(m[1].replace(',', '.'));
  return { km: Math.round(km * 100) / 100, kg_volume: kg, parsed_by: 'regex' };
}

async function claudeExtract(planned, result, notes) {
  const prompt = `A coach prescribed: "${planned}". The athlete logged result: "${result}" and notes: "${notes}".
Reply with ONLY a JSON object: {"status":"completed"|"skipped"|"rest", "km": <total km run, number>, "kg_volume": <estimated total kg lifted = sum of (weight x sets x reps) where stated, else weight totals mentioned; number>, "rpe": <number or null>}. "rest" only if the plan was a recovery day. If the athlete did anything at all, status is "completed".`;
  const { stdout } = await run('claude', ['-p', prompt, '--model', 'haiku'], { timeout: 60000 });
  const json = JSON.parse(stdout.match(/\{[\s\S]*\}/)[0]);
  return { ...json, parsed_by: 'claude' };
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}

// Two sheet formats are supported, detected from the header row:
//  - "coach log" (Andrea): Date | Day | Wk | Session | My result | RPE | Notes | Weight AM
//  - "checkbox plan" (Paw): Done | Week | Phase | # | Date | Session | Location | What to do | Coaching cue
function normalizeRow(r, format, today) {
  if (format === 'checkbox') {
    const date = parseSheetDate(r[4]);
    if (!date) return null;
    const done = String(r[0]).trim().toUpperCase() === 'TRUE';
    const planned = [r[5], r[7]].filter(Boolean).join(' — ');
    // grace period: an unticked session only counts as skipped after 2 days
    const graceDays = (today - date) / 86400000;
    return {
      date, planned,
      result: done ? 'TRUE' : '',
      rpeRaw: '', notes: '',
      logged: done,
      skipped: !done && graceDays > 2,
      // when done, credit the prescribed volume from the plan text
      parseText: planned,
      parseResult: 'Athlete ticked the session as completed exactly as prescribed',
    };
  }
  const date = parseSheetDate(r[0]);
  if (!date) return null;
  const [_, __, ___, planned = '', result = '', rpeRaw = '', notes = ''] = r;
  return {
    date, planned, result, rpeRaw, notes,
    logged: (result + notes).trim().length > 0,
    skipped: /skip|no training/i.test(result + ' ' + notes) && !/run|km|kg|min|completed|done/i.test(result),
    parseText: result + ' ' + notes,
    parseResult: result,
  };
}

async function syncAthlete(athlete, today) {
  if (!athlete.sheet_csv_url) return [];
  // rows already parsed in a previous sync: skip re-parsing if the text is unchanged
  const existing = Object.fromEntries(
    (await sb(`workouts?athlete_id=eq.${athlete.id}&select=id,result_raw,notes,status,km,kg_volume,parsed_by`, { method: 'GET', headers: { Prefer: '' } }))
      .map((w) => [w.id, w]),
  );
  const res = await fetch(athlete.sheet_csv_url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`sheet ${athlete.id}: ${res.status}`);
  const rows = parseCsv(await res.text());
  let format = 'coach', header = rows.findIndex((r) => (r[0] || '').trim().toLowerCase() === 'date');
  if (header === -1) {
    header = rows.findIndex((r) => (r[0] || '').trim().toLowerCase() === 'done');
    format = 'checkbox';
  }
  if (header === -1) throw new Error(`sheet ${athlete.id}: no recognizable header row`);
  const workouts = [];
  for (const r of rows.slice(header + 1)) {
    const n = normalizeRow(r, format, today);
    if (!n || n.date > today || n.date < RACE_START) continue;
    const { date, planned, result, rpeRaw, notes, logged, skipped } = n;
    // a rest day is one whose plan STARTS with recovery/rest — "Rest 90s" or "jog recovery"
    // inside an interval description must not turn a real workout into a rest day
    const isRest = /^\s*(recovery|rest)\b/i.test(planned);

    const id = `${athlete.id}:${iso(date)}`;
    const prev = existing[id];
    // regex-parsed rows are re-parsed every run (cheap, and they upgrade themselves to
    // claude parses once the token is configured); claude-parsed rows are cached forever
    const unchanged = prev && prev.result_raw === result && prev.notes === notes && prev.status !== 'pending' && prev.parsed_by === 'claude';

    let parsed = { km: 0, kg_volume: 0, parsed_by: 'regex' };
    let status = skipped ? 'skipped' : logged ? 'completed' : 'pending';
    if (unchanged) {
      parsed = { km: prev.km, kg_volume: prev.kg_volume, parsed_by: prev.parsed_by };
      status = prev.status;
    } else if (logged && !skipped) {
      try {
        parsed = await claudeExtract(planned, n.parseResult, notes);
        if (parsed.status) status = parsed.status;
      } catch { parsed = regexExtract(n.parseText); }
    }
    // training for real on a planned recovery day still counts as a full session
    if (isRest && status === 'completed' && parsed.km < 1 && !parsed.kg_volume) status = 'rest';

    const rpe = parseFloat(String(rpeRaw).replace(',', '.')) || parsed.rpe || null;
    let points = 0;
    if (status === 'completed') points = SCORE.base * ((rpe || SCORE.rpeRef) / SCORE.rpeRef) + parsed.km * SCORE.perKm + (parsed.kg_volume / 100) * SCORE.per100kg;
    if (status === 'rest') points = SCORE.restDay;

    workouts.push({
      id: `${athlete.id}:${iso(date)}`, athlete_id: athlete.id, date: iso(date),
      planned, result_raw: result, notes, rpe,
      status, km: parsed.km || 0, kg_volume: parsed.kg_volume || 0,
      points: Math.round(points * 10) / 10, parsed_by: parsed.parsed_by, updated_at: new Date().toISOString(),
    });
  }
  if (workouts.length) await sb('workouts?on_conflict=id', { method: 'POST', body: JSON.stringify(workouts) });
  return workouts;
}

function computeState(workouts) {
  // streak: consecutive planned sessions completed (not calendar days — plans differ:
  // Andrea trains 7 days/week, Paw 5), counting back from the most recent resolved session
  const resolved = workouts.filter((w) => w.status !== 'pending').sort((a, b) => a.date.localeCompare(b.date));
  let streak = 0;
  for (let i = resolved.length - 1; i >= 0; i--) {
    if (resolved[i].status === 'completed' || resolved[i].status === 'rest') streak++;
    else break;
  }
  const thisWeek = isoWeek(new Date());
  const base = workouts.reduce((s, w) => s + w.points, 0);
  return {
    total_points: Math.round((base + Math.min(streak * SCORE.streakPerDay, SCORE.streakCap)) * 10) / 10,
    week_points: Math.round(workouts.filter((w) => isoWeek(new Date(w.date)) === thisWeek).reduce((s, w) => s + w.points, 0) * 10) / 10,
    streak,
    total_km: Math.round(workouts.reduce((s, w) => s + w.km, 0) * 10) / 10,
    total_kg: Math.round(workouts.reduce((s, w) => s + w.kg_volume, 0)),
    sessions_completed: workouts.filter((w) => w.status === 'completed').length,
    sessions_skipped: workouts.filter((w) => w.status === 'skipped').length,
  };
}

async function awardTrophies(athletes, allWorkouts, now) {
  const trophies = [];
  const award = (id, athlete_id, kind, label, emoji, period) =>
    trophies.push({ id, athlete_id, kind, label, emoji, period, awarded_at: now.toISOString() });

  // Weekly medal: Sunday 23:00 run closes the ISO week
  if (now.getDay() === 0 && now.getHours() >= 20) {
    const wk = isoWeek(now);
    const scores = athletes.map((a) => ({ a, pts: allWorkouts[a.id].filter((w) => isoWeek(new Date(w.date)) === wk).reduce((s, w) => s + w.points, 0) }));
    scores.sort((x, y) => y.pts - x.pts);
    if (scores[0].pts > 0 && scores[0].pts !== scores[1]?.pts)
      award(`weekly:${wk}`, scores[0].a.id, 'weekly', `Week ${wk.split('W')[1]} champion`, '🥇', wk);
  }
  // Monthly belt: last day of month, 23:00 run
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  if (tomorrow.getDate() === 1 && now.getHours() >= 20) {
    const mo = now.toISOString().slice(0, 7);
    const scores = athletes.map((a) => ({ a, pts: allWorkouts[a.id].filter((w) => w.date.startsWith(mo)).reduce((s, w) => s + w.points, 0) }));
    scores.sort((x, y) => y.pts - x.pts);
    if (scores[0].pts > 0 && scores[0].pts !== scores[1]?.pts)
      award(`monthly:${mo}`, scores[0].a.id, 'monthly', `${now.toLocaleString('en', { month: 'long' })} championship belt`, '🏆', mo);
  }
  // Milestone badges
  for (const a of athletes) {
    const km = allWorkouts[a.id].reduce((s, w) => s + w.km, 0);
    const kg = allWorkouts[a.id].reduce((s, w) => s + w.kg_volume, 0);
    if (km >= 100) award(`badge:100km:${a.id}`, a.id, 'badge', '100 km club', '👟');
    if (kg >= 10000) award(`badge:10t:${a.id}`, a.id, 'badge', '10-ton lifter', '🏋️');
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
  for (const a of athletes) {
    // one athlete's broken/private sheet must not take down the other's sync
    try {
      allWorkouts[a.id] = await syncAthlete(a, now);
      const state = computeState(allWorkouts[a.id]);
      await sb(`race_state?athlete_id=eq.${a.id}`, { method: 'PATCH', body: JSON.stringify({ ...state, updated_at: new Date().toISOString() }) });
      console.log(a.name, state);
    } catch (e) {
      allWorkouts[a.id] = [];
      console.error(`sync failed for ${a.id}:`, e.message);
    }
  }
  const awarded = await awardTrophies(athletes, allWorkouts, now);
  await sb('sync_log', { method: 'POST', body: JSON.stringify({ detail: `synced ${athletes.length} athletes, ${awarded} trophies` }) });
  console.log('done');
}

main().catch((e) => { console.error(e); process.exit(1); });
