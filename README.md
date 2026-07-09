# 🏁 Road to HYROX Budapest — Andrea vs Paw

Gamified training race. Two Google Sheets in → points, trophies, and a cartoon race out.

## Architecture
- **Google Sheets** (one each) — source of truth for workouts.
- **Supabase** (free tier) — Postgres storing workouts, race state, trophies. Site reads with the publishable key; RLS makes everything read-only to the public.
- **GitHub Actions** (.github/workflows/sync.yml) — the "official situation check" at 14:00 & 23:00 Rome time: fetches both sheets, scores each session (base × RPE + km/kg bonuses + streaks), awards weekly medals (Sun 23:00) and monthly belts.
- **index.html** — static race site (GitHub Pages), reads only from Supabase.

## Scoring (tune in `sync/sync.mjs` → `SCORE`)
- Completed session: 50 pts × (RPE/7), + 10 pts/km run, + 1 pt/100 kg lifted
- Prescribed recovery day done: 10 pts · Skipped: 0 pts 💀
- Streak: +5 pts/consecutive day (max 50)
- Finish line = 6,600 pts (~450/week to race day)

## Sheet logging
Andrea's sheet is supported in the coach-log format:

`Date | Day | Wk | Session | My result | RPE | Notes | Weight AM`

Paw's sheet is supported in the checkbox-plan format:

`Done | Week | Phase | # | Date | Session | Location | What to do | Coaching cue | Actually done | RPE`

Paw can add optional structured scoring columns after `Actually done` to avoid brittle note parsing:

`Actual Date | Run KM | External KG Volume | Bodyweight KG | Bodyweight Reps | Score Notes`

Keep it simple: one row per workout. For a run, fill `Actual Date`, `Run KM`, and `RPE`. For calisthenics, fill `Actual Date`, `Bodyweight KG`, `Bodyweight Reps`, and `RPE`. Free-text notes are still fine, but structured columns win when present.

Bodyweight equivalent volume is always `Bodyweight KG × Bodyweight Reps × 0.70`. `External KG Volume` is only for weighted/gym work where you already know the load volume. The sync adds them together.

## One-time setup (remaining)
1. **Database**: Supabase Dashboard → SQL Editor → paste supabase/schema.sql → Run.
2. **Sheets access**: each sheet must be readable by the sync job — File → Share → "Anyone with the link: Viewer" (or Publish to web as CSV). Add Paw's CSV URL to his row in the `athletes` table.
3. **GitHub secrets** (Settings → Secrets and variables → Actions):
   - `SUPABASE_URL` = https://kdeqfsnteprdxeboirus.supabase.co
   - `SUPABASE_SERVICE_KEY` = service_role key (never in code!)
   - `CLAUDE_CODE_OAUTH_TOKEN` = run `claude setup-token` locally and paste the result; lets the sync parse free-text results with `claude -p` on your Claude subscription (regex fallback if missing). Rows already parsed are cached in the DB and never re-parsed.
4. Trigger the first sync manually: repo → Actions → "Race sync" → Run workflow.

## Local preview
`python3 -m http.server 4173 --directory hyrox-race` → http://localhost:4173
Shows demo data until the database has real rows.
