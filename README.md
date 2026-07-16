# 🏁 Road to HYROX Budapest — Andrea vs Paw

Gamified training race. Two Google Sheets in → points, trophies, and a cartoon race out.

## Architecture
- **Google Sheets** (one each) — source of truth for workouts.
- **Supabase** (free tier) — Postgres storing workouts, race state, trophies. The site can read only sanitized workout summaries and race results with the publishable key; sheet URLs and raw notes stay private.
- **GitHub Actions** (.github/workflows/sync.yml) — the "official situation check" at 14:00 & 23:00 Rome time: fetches both sheets, scores their explicit `Done`, `KM`, and `RPE` values, awards weekly medals (Sun 23:00) and monthly belts.
- **index.html** — static race site (GitHub Pages), reads only from Supabase.

## Scoring (tune in `sync/sync.mjs` → `SCORE`)
- Completed session subtotal: 50 pts + 7 pts/km
- RPE multiplier: `1 + ((RPE - 7) × 0.05)` — RPE 7 is 1.00×, RPE 8 is 1.05×, RPE 6 is 0.95×
- Final score: `(50 + 7 × KM) × RPE multiplier`
- Missing or invalid RPE uses 1.00×. Planned recovery, skipped, and pending rows score 0 pts, even if a recovery checkbox is ticked.
- Workout frequency: completed workouts in finished race weeks divided by the number of finished race weeks; the current partial week is excluded and planned rest or pending rows are hidden from the workout log
- Finish line = 6,600 pts (~450/week to race day)

## Sheet logging
Both sheets must contain these exact scoring columns somewhere in their header row:

`Done | KM | RPE`

- `Done`: Google Sheets checkbox (`TRUE` means a workout happened; leave planned rest days unticked)
- `KM`: total running distance for that workout; use `0` for a non-running workout
- `RPE`: effort from 1 to 10

The rest of each existing layout can stay as it is. Andrea can keep the coach-log columns and add `Done` and `KM`; the existing `RPE` column is reused. Paw can keep the checkbox-plan columns and add `KM`; the existing `Done` and `RPE` columns are reused.

Only these three structured columns affect scoring. The public workout log shows status, KM, RPE, and points, while the `Session` cell is used directly as the workout name. Detailed prescriptions (`What to do`), results, notes, weights, repetitions, and workout duration remain private and do not affect scoring.

Before enabling this version, add the columns to both sheets and backfill `Done`, `KM`, and `RPE` for every scoring row from 6 July onward. If a required column is missing, that athlete's sync fails safely without overwriting their stored results.

## One-time setup (remaining)
1. **Database**: Supabase Dashboard → SQL Editor → paste supabase/schema.sql → Run. Rerun it after pulling schema changes; it also applies the privacy grants used by the public site.
2. **Sheets access**: each sheet must be readable by the sync job — File → Share → "Anyone with the link: Viewer" (or Publish to web as CSV). Add both CSV URLs directly to the private `athletes` table; do not commit them to this repository.
3. **GitHub secrets** (Settings → Secrets and variables → Actions):
   - `SUPABASE_URL` = https://kdeqfsnteprdxeboirus.supabase.co
   - `SUPABASE_SERVICE_KEY` = service_role key (never in code!)
4. Trigger the first sync manually: repo → Actions → "Race sync" → Run workflow. It will recalculate stored workout points from the structured sheet values.

## Local preview
From this repository's root: `python3 -m http.server 4173` → http://localhost:4173
Shows an empty fallback state with a warning if the database is unavailable.
