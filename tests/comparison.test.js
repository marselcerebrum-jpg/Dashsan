import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRange } from '../web/comparison.js';

const dates = (result) => [result.start, result.end];
const days = (result) => (Date.parse(result.end) - Date.parse(result.start)) / 86400000 + 1;

test('four selected days compare with four matching days in the previous month', () => {
  assert.deepEqual(dates(compareRange('mom', '2026-11-01', '2026-11-04')), ['2026-10-01', '2026-10-04']);
  assert.deepEqual(dates(compareRange('mom', '2026-11-10', '2026-11-13')), ['2026-10-10', '2026-10-13']);
  const result = compareRange('mom', '2026-11-01', '2026-11-04');
  assert.equal(days(result), 4);
  assert.equal(result.short, 'bulan lalu');
  assert.equal(result.series, 'Omzet bulan lalu');
  assert.equal(result.label, 'periode sama bulan lalu');
});

test('monthly comparisons cross years and handle a single selected date', () => {
  assert.deepEqual(dates(compareRange('mom', '2026-01-01', '2026-01-04')), ['2025-12-01', '2025-12-04']);
  assert.deepEqual(dates(compareRange('mom', '2026-03-31', '2026-03-31')), ['2026-02-28', '2026-02-28']);
});

test('shorter previous months preserve four days by aligning to their final available date', () => {
  assert.deepEqual(dates(compareRange('mom', '2026-03-28', '2026-03-31')), ['2026-02-25', '2026-02-28']);
  assert.deepEqual(dates(compareRange('mom', '2024-03-28', '2024-03-31')), ['2024-02-26', '2024-02-29']);
  assert.deepEqual(dates(compareRange('mom', '2026-05-28', '2026-05-31')), ['2026-04-27', '2026-04-30']);
});

test('a full long month does not spill into two months when the previous month is shorter', () => {
  const result = compareRange('mom', '2026-03-01', '2026-03-31');
  assert.deepEqual(dates(result), ['2026-02-01', '2026-02-28']);
  assert.equal(days(result), 28);
  assert.deepEqual(dates(compareRange('mom', '2024-03-01', '2024-03-31')), ['2024-02-01', '2024-02-29']);
});

test('rolling ranges spanning months keep their selected number of days', () => {
  const result = compareRange('mom', '2026-10-29', '2026-11-01');
  assert.deepEqual(dates(result), ['2026-09-28', '2026-10-01']);
  assert.equal(days(result), 4);
});

test('previous-period and year comparisons retain their existing date rules', () => {
  assert.deepEqual(dates(compareRange('prev', '2026-11-01', '2026-11-04')), ['2026-10-28', '2026-10-31']);
  assert.deepEqual(dates(compareRange('yoy', '2026-11-01', '2026-11-04')), ['2025-11-01', '2025-11-04']);
  assert.deepEqual(dates(compareRange('yoy', '2024-02-28', '2024-03-01')), ['2023-02-28', '2023-03-01']);
  assert.equal(compareRange('prev', '2026-11-01', '2026-11-04').short, '4 hari sebelumnya');
  assert.equal(compareRange('yoy', '2026-11-01', '2026-11-04').short, 'tahun lalu');
});
