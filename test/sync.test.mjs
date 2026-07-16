import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCORE,
  applyMovedWorkoutGrace,
  computeState,
  isRecoveryPlan,
  normalizeRow,
  parseSheetDate,
  publicWorkoutTitle,
  rpeMultiplier,
  scoreWorkout,
  validateScoringHeaders,
  workoutStatus,
} from '../sync/sync.mjs';

const iso = (date) => date.toISOString().slice(0, 10);

test('scoring constants match the agreed simplified model', () => {
  assert.deepEqual(SCORE, {
    workout: 50,
    perKm: 7,
    rpeRef: 7,
    rpeStep: 0.05,
  });
});

test('scoreWorkout gives 50 points for a non-running workout at RPE 7', () => {
  assert.equal(scoreWorkout({ status: 'completed', km: 0, rpe: 7 }), 50);
});

test('scoreWorkout adds 7 points per KM before applying the RPE multiplier', () => {
  assert.equal(scoreWorkout({ status: 'completed', km: 8, rpe: 7 }), 106);
  assert.equal(scoreWorkout({ status: 'completed', km: 15, rpe: 8 }), 162.8);
  assert.equal(scoreWorkout({ status: 'completed', km: 5, rpe: 6 }), 80.8);
});

test('RPE multiplier changes by five percent around RPE 7', () => {
  assert.equal(rpeMultiplier(5), 0.9);
  assert.equal(rpeMultiplier(7), 1);
  assert.equal(rpeMultiplier(10), 1.15);
  assert.equal(rpeMultiplier(''), 1);
  assert.equal(rpeMultiplier(11), 1);
});

test('only completed workouts score and negative KM is ignored', () => {
  assert.equal(scoreWorkout({ status: 'rest', km: 10, rpe: 10 }), 0);
  assert.equal(scoreWorkout({ status: 'skipped', km: 10, rpe: 10 }), 0);
  assert.equal(scoreWorkout({ status: 'pending', km: 10, rpe: 10 }), 0);
  assert.equal(scoreWorkout({ status: 'completed', km: -10, rpe: 7 }), 50);
});

test('planned rest always resolves to REST and earns zero points', () => {
  const status = workoutStatus({ isRest: true, logged: true, skipped: false });
  assert.equal(status, 'rest');
  assert.equal(scoreWorkout({ status, km: 10, rpe: 10 }), 0);
});

test('non-rest rows resolve from Done and the skip grace period', () => {
  assert.equal(workoutStatus({ isRest: false, logged: true, skipped: false }), 'completed');
  assert.equal(workoutStatus({ isRest: false, logged: false, skipped: true }), 'skipped');
  assert.equal(workoutStatus({ isRest: false, logged: false, skipped: false }), 'pending');
});

test('required scoring columns accept KM and the legacy Run KM spelling', () => {
  assert.doesNotThrow(() => validateScoringHeaders(['Date', 'Session', 'Done', 'KM', 'RPE']));
  assert.doesNotThrow(() => validateScoringHeaders(['Done', 'Date', 'Session', 'Run KM', 'RPE']));
  assert.throws(
    () => validateScoringHeaders(['Date', 'Session', 'Done', 'RPE']),
    /missing required scoring columns: KM/,
  );
  assert.throws(
    () => validateScoringHeaders(['Date', 'Session', 'KM']),
    /missing required scoring columns: DONE, RPE/,
  );
});

test('parseSheetDate handles plan dates and rejects invalid dates', () => {
  assert.equal(iso(parseSheetDate('Mon 22 Jun')), '2026-06-22');
  assert.equal(iso(parseSheetDate('July 6')), '2026-07-06');
  assert.equal(iso(parseSheetDate('2026-07-08')), '2026-07-08');
  assert.equal(parseSheetDate('2026-02-30'), null);
  assert.equal(parseSheetDate('31 Jun'), null);
});

test('normalizeRow reads explicit scoring values from Andrea coach-log rows', () => {
  const format = {
    name: 'coach',
    headers: [
      'Date', 'Day', 'Wk', 'Session (coach fills detailed each week)',
      'My result (weights / reps / time)', 'RPE', 'Notes', 'Weight AM', 'Done', 'KM',
    ],
  };
  const row = ['Mon 6 Jul', 'Mon', '3', 'KEY RUN', '6km done', '8.5', '', '', 'TRUE', '6.03'];
  const normalized = normalizeRow(row, format, new Date('2026-07-09T10:00:00Z'));

  assert.equal(iso(normalized.date), '2026-07-06');
  assert.equal(normalized.planned, 'KEY RUN');
  assert.equal(normalized.sessionTitle, 'KEY RUN');
  assert.equal(normalized.result, '6km done');
  assert.equal(normalized.rpeRaw, '8.5');
  assert.equal(normalized.km, 6.03);
  assert.equal(normalized.logged, true);
  assert.equal(normalized.skipped, false);
});

test('Andrea free text no longer marks a workout complete without Done', () => {
  const format = {
    name: 'coach',
    headers: ['Date', 'Day', 'Wk', 'Session', 'My result', 'RPE', 'Notes', 'Done', 'KM'],
  };
  const row = ['Wed 8 Jul', 'Wed', '3', 'STRENGTH A', 'Completed everything', '9', '', 'FALSE', '4'];
  const normalized = normalizeRow(row, format, new Date('2026-07-11T10:00:00Z'));

  assert.equal(normalized.logged, false);
  assert.equal(normalized.skipped, true);
  assert.equal(normalized.result, '');
  assert.equal(normalized.km, 4);
});

test('normalizeRow reads Paw checkbox values and preserves actual workout date', () => {
  const format = {
    name: 'checkbox',
    headers: [
      'Done', 'Week', 'Phase', '#', 'Date', 'Session', 'Location', 'What to do',
      'Coaching cue', 'Actually done', 'RPE', 'KM', 'Actual Date',
    ],
  };
  const row = [
    'TRUE', '1', 'Foundation', '2', 'Tue 7 Jul', 'Run - Intervals', 'Park',
    '5 x 800m hard', 'Even splits', 'Total distance: 6.03km', '7.5', '6.03', 'July 8',
  ];
  const normalized = normalizeRow(row, format, new Date('2026-07-09T10:00:00Z'));

  assert.equal(iso(normalized.idDate), '2026-07-07');
  assert.equal(iso(normalized.date), '2026-07-08');
  assert.equal(normalized.rpeRaw, '7.5');
  assert.equal(normalized.km, 6.03);
  assert.equal(normalized.logged, true);
  assert.equal(normalized.planned, 'Run - Intervals — 5 x 800m hard');
  assert.equal(normalized.sessionTitle, 'Run - Intervals');
});

test('negative spreadsheet KM is clamped to zero', () => {
  const format = {
    name: 'coach',
    headers: ['Date', 'Session', 'Done', 'KM', 'RPE'],
  };
  const normalized = normalizeRow(
    ['July 8', 'Strength', 'TRUE', '-5', '7'],
    format,
    new Date('2026-07-09T10:00:00Z'),
  );

  assert.equal(normalized.km, 0);
});

test('moved workouts do not create a skipped row on the same actual date', () => {
  const rows = applyMovedWorkoutGrace([
    {
      date: parseSheetDate('July 6'),
      idDate: parseSheetDate('July 6'),
      planned: 'Strength',
      logged: false,
      skipped: true,
    },
    {
      date: parseSheetDate('July 6'),
      idDate: parseSheetDate('July 11'),
      planned: 'Long Run',
      logged: true,
      skipped: false,
    },
  ]);

  assert.equal(rows[0].skipped, false);
  assert.equal(rows[1].skipped, false);
});

test('computeState totals the simplified workout metrics', () => {
  const state = computeState([
    { date: '2026-07-06', status: 'completed', points: 106, km: 8 },
    { date: '2026-07-07', status: 'completed', points: 50, km: 0 },
    { date: '2026-07-08', status: 'rest', points: 0, km: 0 },
  ], new Date('2026-07-08T10:00:00Z'));

  assert.equal(state.total_points, 156);
  assert.equal(state.week_points, 156);
  assert.equal(state.total_km, 8);
  assert.equal(state.total_kg, 0);
  assert.equal(state.sessions_completed, 2);
  assert.equal(state.sessions_skipped, 0);
});

test('recovery detection works and public titles use the Session column verbatim', () => {
  assert.equal(isRecoveryPlan('Rest — mobility only'), true);
  assert.equal(isRecoveryPlan('Travel day. Intervals were moved. Rest or easy shakeout.'), true);
  assert.equal(isRecoveryPlan('Intervals 5x800m with 90s jog recovery'), false);
  assert.equal(publicWorkoutTitle('  Football / Soccer  '), 'Football / Soccer');
  assert.equal(publicWorkoutTitle('Run - Intervals'), 'Run - Intervals');
  assert.equal(publicWorkoutTitle(''), 'Workout');
});
