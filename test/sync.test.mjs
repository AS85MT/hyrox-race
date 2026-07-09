import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyMovedWorkoutGrace,
  computeState,
  headerMap,
  normalizeRow,
  parseSheetDate,
  regexExtract,
  structuredMetrics,
} from '../sync/sync.mjs';

const iso = (date) => date.toISOString().slice(0, 10);

test('parseSheetDate handles coach-log dates with weekday prefixes', () => {
  assert.equal(iso(parseSheetDate('Mon 22 Jun')), '2026-06-22');
  assert.equal(iso(parseSheetDate('July 6')), '2026-07-06');
  assert.equal(iso(parseSheetDate('2026-07-08')), '2026-07-08');
});

test('regexExtract prefers explicit total distance over interval splits', () => {
  const text = `July 8
Interval runs
400m 2:26
800m 3:10
400m 2:40
800m 3:13
1200m 7:32
Total distance: 6.03km
Total time: 31m31s`;

  assert.deepEqual(regexExtract(text), {
    km: 6.03,
    kg_volume: 0,
    parsed_by: 'regex',
  });
});

test('regexExtract ignores bodyweight as external kg and scores bodyweight reps', () => {
  const text = `July 7
Pull-ups body weight: 12, 12, 10, 10, 10, full ROM
Inverted rows body weight: 12, 12, 12, full ROM
Dips body weight: 10, 10, 10, full ROM
Dead hangs body weight: 40s, 50s, 60s
Body weight: 75kg`;

  assert.deepEqual(regexExtract(text), {
    km: 0,
    kg_volume: 6300,
    parsed_by: 'regex',
  });
});

test('normalizeRow preserves Andrea coach-log format', () => {
  const format = {
    name: 'coach',
    headers: ['Date', 'Day', 'Wk', 'Session (coach fills detailed each week)', 'My result (weights / reps / time)', 'RPE', 'Notes', 'Weight AM'],
  };
  const row = ['Mon 6 Jul', 'Mon', '3', 'KEY RUN', '6km done', '8.5', '', ''];
  const normalized = normalizeRow(row, format, new Date('2026-07-09T10:00:00Z'));

  assert.equal(iso(normalized.date), '2026-07-06');
  assert.equal(normalized.planned, 'KEY RUN');
  assert.equal(normalized.result, '6km done');
  assert.equal(normalized.rpeRaw, '8.5');
  assert.equal(normalized.logged, true);
});

test('normalizeRow treats explicit no-training coach results as skipped', () => {
  const format = {
    name: 'coach',
    headers: ['Date', 'Day', 'Wk', 'Session (coach fills detailed each week)', 'My result (weights / reps / time)', 'RPE', 'Notes', 'Weight AM'],
  };
  const row = ['Wed 8 Jul', 'Wed', '3', 'STRENGTH A', 'Did not train', '', '', ''];
  const normalized = normalizeRow(row, format, new Date('2026-07-11T10:00:00Z'));

  assert.equal(normalized.logged, true);
  assert.equal(normalized.skipped, true);
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

test('computeState keeps streaks visible without hidden point bonuses', () => {
  const state = computeState([
    { date: '2026-07-06', status: 'completed', points: 100, km: 0, kg_volume: 0 },
    { date: '2026-07-07', status: 'completed', points: 50, km: 0, kg_volume: 0 },
  ]);

  assert.equal(state.streak, 2);
  assert.equal(state.total_points, 150);
});

test('normalizeRow reads Paw checkbox RPE and actual date from first note line', () => {
  const format = {
    name: 'checkbox',
    headers: ['Done', 'Week', '#', 'Phase', 'Date', 'Session', 'Location', 'Planned workout', 'Coaching cue', 'RPE', 'Actual Date', 'Run KM', 'Run time', 'External KG Volume', 'Bodyweight KG', 'Bodyweight Reps', 'Actual workout'],
  };
  const row = [
    'TRUE', '1', '2', 'Foundation', 'Tue 7 Jul', 'Run - Intervals', 'Park',
    '5 x 800m hard', 'Even splits', '7.5', 'July 8', '6.03', '31m31s', '', '75', '5',
    'July 8\nTotal distance: 6.03km',
  ];
  const normalized = normalizeRow(row, format, new Date('2026-07-09T10:00:00Z'));

  assert.equal(iso(normalized.idDate), '2026-07-07');
  assert.equal(iso(normalized.date), '2026-07-08');
  assert.equal(normalized.rpeRaw, '7.5');
  assert.equal(normalized.logged, true);
  assert.equal(normalized.planned, 'Run - Intervals — 5 x 800m hard');
  assert.equal(normalized.result, 'July 8\nTotal distance: 6.03km');
  assert.equal(normalized.notes, 'Run time: 31m31s');
  assert.deepEqual(normalized.structured, {
    km: 6.03,
    kg_volume: 263,
    parsed_by: 'structured',
  });
});

test('structuredMetrics supports one-row bodyweight logging', () => {
  const headers = ['Run KM', 'External KG Volume', 'Bodyweight KG', 'Bodyweight Reps'];
  const row = ['', '500', '75', '100'];
  const metrics = structuredMetrics(row, headerMap(headers), '');

  assert.deepEqual(metrics, {
    km: 0,
    kg_volume: 5750,
    parsed_by: 'structured',
  });
});
