import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversionKpi, downloaderConversion } from '../web/conversion.js';

const view = {
  requestId: 1, platform: 'jadiasn',
  range: { start: '2026-10-28', end: '2026-10-29' },
  compare: { start: '2026-10-26', end: '2026-10-27', short: '2 hari sebelumnya' },
};
const row = (custKey, day = '2026-10-29', status = 1, platform = 'jadiasn') => ({ custKey, day, status, platform });
const downloads = (total, complete = true) => ({ summary: { complete, total } });

test('conversion uses unique successful buyers, not checkouts or repeat transactions', () => {
  const rows = [row('a'), row('a'), row('b'), row('pending', '2026-10-29', 0), row('failed', '2026-10-29', 4)];
  assert.deepEqual(downloaderConversion(rows, view, downloads(10)), { users: 2, downloads: 10, rate: 0.2, reason: '' });
});

test('buyers and downloaders are matched to the same date range and platform', () => {
  const rows = [row('yesterday', '2026-10-28'), row('today'), row('old', '2026-10-27'), row('future', '2026-10-30'), row('other-app', '2026-10-29', 1, 'jadibumn')];
  assert.equal(downloaderConversion(rows, view, downloads(10)).rate, 0.2);
  const dailyView = { ...view, range: { start: '2026-10-29', end: '2026-10-29' } };
  assert.equal(downloaderConversion(rows, dailyView, downloads(10)).rate, 0.1);
  assert.equal(downloaderConversion(rows, { ...dailyView, platform: 'all' }, downloads(20)).rate, 0.1);
});

test('all-platform unique buyers follow the dashboard customer identity instead of counting purchases twice', () => {
  const rows = [row('same-person'), row('same-person', '2026-10-29', 1, 'jadibumn')];
  assert.equal(downloaderConversion(rows, { ...view, platform: 'all' }, downloads(10)).users, 1);
});

test('missing, partial, invalid or zero downloader counts never produce a false conversion', () => {
  for (const result of [null, downloads(null, false), downloads(10, false), downloads(-1), downloads('10'), downloads(0)]) {
    assert.equal(downloaderConversion([row('a')], view, result).rate, null);
  }
  assert.equal(downloaderConversion(null, view, downloads(10)).rate, null);
  assert.equal(downloaderConversion([row('a')], view, downloads(10), false).rate, null);
  assert.equal(downloaderConversion([], view, downloads(10)).rate, 0);
});

test('a period volume ratio above 100% is not clamped to a fabricated funnel percentage', () => {
  assert.equal(downloaderConversion([row('a'), row('b')], view, downloads(1)).rate, 2);
});

function setup() {
  const element = { innerHTML: '' };
  const kpi = createConversionKpi({
    element, esc: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    num: (value) => String(value), pct: (value) => `${Number((value * 100).toFixed(1))}%`, rangeLabel: (start, end) => `${start}–${end}`,
  });
  return { kpi, element };
}
const sales = { rows: [row('a'), row('b')], previousRows: [row('old', '2026-10-26')], complete: true, previousComplete: true };
const update = { view, current: downloads(10), previous: downloads(10), loading: false };

test('conversion waits for both independently loaded data sources in either arrival order', () => {
  for (const order of ['sales-first', 'downloader-first']) {
    const { kpi, element } = setup();
    kpi.begin(1);
    if (order === 'sales-first') kpi.setSales(1, sales);
    else kpi.setDownloaders(update);
    assert.match(element.innerHTML, /class="value">…</);
    if (order === 'sales-first') kpi.setDownloaders(update);
    else kpi.setSales(1, sales);
    assert.match(element.innerHTML, /class="value">20%</);
    assert.match(element.innerHTML, /class="label">Konversi</);
    assert.match(element.innerHTML, /2 pembeli \/ 10 downloader/);
    assert.match(element.innerHTML, /▲ 100%/);
    assert.match(element.innerHTML, /vs 2 hari sebelumnya \(10%\)/);
    assert.match(element.innerHTML, /2026-10-28–2026-10-29/);
  }
});

test('new filters clear old conversion and ignore stale sales and downloader responses', () => {
  const { kpi, element } = setup();
  kpi.begin(1);
  kpi.setSales(1, sales);
  kpi.setDownloaders(update);
  kpi.begin(2);
  kpi.setSales(1, sales);
  kpi.setDownloaders(update);
  assert.match(element.innerHTML, /class="value">…</);
  kpi.setSales(2, { ...sales, rows: [row('one')] });
  kpi.setDownloaders({ ...update, view: { ...view, requestId: 2 } });
  assert.match(element.innerHTML, /class="value">10%</);
});

test('changing downloader display to daily recalculates buyers for that day only', () => {
  const { kpi, element } = setup();
  kpi.begin(1);
  kpi.setSales(1, { ...sales, rows: [row('yesterday', '2026-10-28'), row('today')] });
  kpi.setDownloaders(update);
  assert.match(element.innerHTML, /class="value">20%</);
  kpi.setDownloaders({ ...update, view: { ...view, daily: true, range: { start: '2026-10-29', end: '2026-10-29' } } });
  assert.match(element.innerHTML, /class="value">10%</);
  assert.match(element.innerHTML, /1 pembeli \/ 10 downloader/);
});

test('missing comparison does not invent growth from zero and does not hide a valid current rate', () => {
  const { kpi, element } = setup();
  kpi.begin(1);
  kpi.setSales(1, { ...sales, previousComplete: false });
  kpi.setDownloaders(update);
  assert.match(element.innerHTML, /class="value">20%</);
  assert.match(element.innerHTML, /Pembanding belum tersedia\/lengkap/);
  assert.doesNotMatch(element.innerHTML, /▲/);
});

test('incomplete transactions withhold the conversion while a genuine zero buyer count remains zero percent', () => {
  const { kpi, element } = setup();
  kpi.begin(1);
  kpi.setSales(1, { ...sales, complete: false });
  kpi.setDownloaders(update);
  assert.match(element.innerHTML, /class="value">—</);
  assert.match(element.innerHTML, /Data transaksi belum tersedia\/lengkap/);
  kpi.setSales(1, { ...sales, rows: [] });
  assert.match(element.innerHTML, /class="value">0%</);
  assert.match(element.innerHTML, /▼ 100%/);
});

test('a zero comparison rate does not render infinity or fabricate percentage growth', () => {
  const { kpi, element } = setup();
  kpi.begin(1);
  kpi.setSales(1, { ...sales, previousRows: [] });
  kpi.setDownloaders(update);
  assert.match(element.innerHTML, /vs 2 hari sebelumnya \(0%\)/);
  assert.doesNotMatch(element.innerHTML, /Infinity|NaN|▲/);
});

test('Konversi compares the current rate against the selected year or previous period', () => {
  for (const compare of [
    { mode: 'yoy', start: '2025-10-28', end: '2025-10-29', short: 'tahun lalu' },
    { mode: 'prev', start: '2026-10-26', end: '2026-10-27', short: '2 hari sebelumnya' },
  ]) {
    const { kpi, element } = setup();
    kpi.begin(1);
    kpi.setSales(1, { ...sales, previousRows: [row('previous-user', compare.end)] });
    kpi.setDownloaders({ ...update, view: { ...view, compare } });
    assert.match(element.innerHTML, /class="label">Konversi</);
    assert.match(element.innerHTML, /class="value">20%</);
    assert.ok(element.innerHTML.includes(`vs ${compare.short} (10%)`));
    assert.match(element.innerHTML, /▲ 100%/);
  }
});
