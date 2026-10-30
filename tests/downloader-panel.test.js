import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownloaderPanel } from '../web/downloaders.js';

function setup(fetchImpl, onUpdate) {
  const elements = new Map();
  globalThis.document = { documentElement: {}, getElementById(id) {
    if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', hidden: false, disabled: false, handlers: {}, addEventListener(event, fn) { this.handlers[event] = fn; } });
    return elements.get(id);
  } };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#3987e5' });
  globalThis.fetch = fetchImpl;
  const charts = [];
  const exports = [];
  const panel = createDownloaderPanel({
    chart: (...args) => charts.push(args), downloadCsv: (...args) => exports.push(args),
    dateLabel: (date) => date, rangeLabel: (a, b) => `${a}–${b}`, num: (n) => String(n),
    esc: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    apiUrl: (path) => new URL(path, 'http://localhost'),
    onUpdate,
  });
  globalThis.document.getElementById('downloaderMode').value = 'range';
  return { panel, elements, charts, exports };
}

const view = {
  platform: 'jadiasn', platformLabel: 'JadiASN', platformNames: { jadiasn: 'JadiASN' },
  range: { start: '2026-10-28', end: '2026-10-29', days: 2 },
  compare: { start: '2026-10-26', end: '2026-10-27', short: '2 hari sebelumnya' },
};

function payload(start, values) {
  const data = values.map((total, i) => ({ date: new Date(Date.parse(start) + i * 86400000).toISOString().slice(0, 10), total, known_total: total ?? 2, missing_platforms: total === null ? ['jadiasn'] : [] }));
  const complete = values.every((value) => value !== null);
  return { status: true, demo: true, data, warnings: complete ? [] : ['Data tidak lengkap'], summary: { complete, total: complete ? values.reduce((a, b) => a + b, 0) : null, known_total: data.reduce((a, row) => a + row.known_total, 0), complete_days: values.filter((n) => n !== null).length, days: values.length } };
}

test('dashboard shows daily counts, comparison dates, chart gaps and truthful partial CSV data', async () => {
  const ui = setup(async (url) => Response.json(url.searchParams.get('start_date') === view.range.start ? payload(view.range.start, [10, null]) : payload(view.compare.start, [5, 0])));
  await ui.panel.load(view);
  assert.match(ui.elements.get('downloaderKpi').innerHTML, /Data belum tersedia\/lengkap/);
  assert.match(ui.elements.get('downloaderTable').innerHTML, /2026-10-26/);
  assert.match(ui.elements.get('downloaderTable').innerHTML, /Tidak lengkap/);
  assert.equal(ui.elements.get('downloaderWarning').hidden, false);
  assert.deepEqual(ui.charts[0][1].data.datasets[0].data, [10, null]);
  assert.deepEqual(ui.charts[0][1].data.datasets[1].data, [5, 0]);
  ui.elements.get('exportDownloaders').handlers.click();
  const [, rows, columns] = ui.exports[0];
  const column = (name) => columns.find(([label]) => label === name)[1];
  assert.equal(column('downloader')(rows[1]), '');
  assert.equal(column('downloader_pembanding')(rows[1]), 0);
  assert.equal(column('status_data')(rows[1]), 'tidak lengkap');
  assert.equal(column('tanggal_pembanding')(rows[0]), '2026-10-26');
  assert.equal(column('mode_data')(rows[0]), 'demo');
});

test('a failed comparison remains unavailable instead of showing growth from zero', async () => {
  const ui = setup(async (url) => url.searchParams.get('start_date') === view.range.start
    ? Response.json(payload(view.range.start, [10, 20]))
    : Response.json({ status: false, message: 'Pembanding gagal' }, { status: 502 }));
  await ui.panel.load(view);
  assert.match(ui.elements.get('downloaderWarning').textContent, /Pembanding gagal/);
  assert.match(ui.elements.get('downloaderKpi').innerHTML, /Pembanding belum tersedia\/lengkap/);
  assert.deepEqual(ui.charts[0][1].data.datasets[1].data, [null, null]);
  assert.equal(ui.elements.get('reloadDownloaders').disabled, false);
});

test('failed current data leave an explicit error and disable exporting', async () => {
  const ui = setup(async () => Response.json({ status: false, message: '<private upstream error>' }, { status: 401 }));
  await ui.panel.load(view);
  assert.equal(ui.elements.get('exportDownloaders').disabled, true);
  assert.equal(ui.elements.get('downloaderChartWrap').hidden, true);
  assert.match(ui.elements.get('downloaderStatus').textContent, /Data sales tetap ditampilkan/);
  assert.equal(ui.elements.get('reloadDownloaders').disabled, false);
});

test('late responses from an old platform filter never overwrite the selected filter', async () => {
  const pending = [];
  const ui = setup((url) => new Promise((resolve) => pending.push({ url, resolve })));
  const oldLoad = ui.panel.load(view);
  const newLoad = ui.panel.load({ ...view, platform: 'jadibumn', platformLabel: 'JadiBUMN' });
  for (const request of pending.filter((entry) => entry.url.searchParams.get('platform') === 'jadibumn')) request.resolve(Response.json(payload(request.url.searchParams.get('start_date'), [20, 30])));
  await newLoad;
  for (const request of pending.filter((entry) => entry.url.searchParams.get('platform') === 'jadiasn')) request.resolve(Response.json(payload(request.url.searchParams.get('start_date'), [1, 1])));
  await oldLoad;
  assert.match(ui.elements.get('downloaderStatus').textContent, /JadiBUMN/);
  assert.match(ui.elements.get('downloaderKpi').innerHTML, />50</);
  assert.equal(ui.charts.length, 1);
});

test('daily mode requests only the final day and its matching comparison date', async () => {
  const calls = [];
  const ui = setup(async (url) => {
    calls.push(url);
    return Response.json(payload(url.searchParams.get('start_date'), [10]));
  });
  ui.elements.get('downloaderMode').value = 'daily';
  await ui.panel.load(view);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((url) => [url.searchParams.get('start_date'), url.searchParams.get('end_date')]), [['2026-10-29', '2026-10-29'], ['2026-10-27', '2026-10-27']]);
  assert.match(ui.elements.get('downloaderKpi').innerHTML, /Downloader harian/);
  assert.match(ui.elements.get('downloaderKpi').innerHTML, /vs 2 hari sebelumnya \(10\)/);
  assert.match(ui.elements.get('downloaderRange').textContent, /2026-10-29–2026-10-29/);
});

test('all-platform period mode chunks requests by day instead of one long-running server invocation', async () => {
  const calls = [];
  const ui = setup(async (url) => {
    calls.push(url);
    return Response.json(payload(url.searchParams.get('start_date'), [10]));
  });
  await ui.panel.load({ ...view, platform: 'all', platformLabel: 'Semua platform' });
  assert.equal(calls.length, 4);
  assert.equal(calls.every((url) => url.searchParams.get('start_date') === url.searchParams.get('end_date')), true);
  assert.match(ui.elements.get('downloaderKpi').innerHTML, />20</);
});

test('downloader occupies one KPI and asynchronous updates preserve the transaction cards', async () => {
  const pending = [];
  const ui = setup((url) => new Promise((resolve) => pending.push({ url, resolve })));
  const sales = globalThis.document.getElementById('salesKpis');
  sales.innerHTML = '<div class="kpi">Omzet (sukses)</div><div class="kpi">Transaksi sukses</div>';
  const originalSales = sales.innerHTML;
  const load = ui.panel.load(view);
  assert.equal((ui.elements.get('downloaderKpi').innerHTML.match(/class="kpi"/g) || []).length, 1);
  assert.match(ui.elements.get('downloaderKpi').innerHTML, /Sedang memuat/);
  for (const request of pending) request.resolve(Response.json(payload(request.url.searchParams.get('start_date'), request.url.searchParams.get('start_date') === view.range.start ? [10, 20] : [5, 10])));
  await load;
  const kpi = ui.elements.get('downloaderKpi').innerHTML;
  assert.equal((kpi.match(/class="kpi"/g) || []).length, 1);
  assert.match(kpi, /class="value">30</);
  assert.match(kpi, /class="up">▲ 100%/);
  assert.match(kpi, /vs 2 hari sebelumnya \(15\)/);
  assert.match(kpi, /2026-10-28–2026-10-29/);
  assert.equal(sales.innerHTML, originalSales);
});

test('conversion receives the same filtered downloader totals and daily scope displayed by the panel', async () => {
  const updates = [];
  const ui = setup(async (url) => Response.json(payload(url.searchParams.get('start_date'), [10])), (value) => updates.push(value));
  ui.elements.get('downloaderMode').value = 'daily';
  await ui.panel.load({ ...view, requestId: 7 });
  assert.equal(updates[0].loading, true);
  const latest = updates.at(-1);
  assert.equal(latest.loading, false);
  assert.equal(latest.view.requestId, 7);
  assert.deepEqual(latest.view.range, { start: '2026-10-29', end: '2026-10-29', days: 1 });
  assert.equal(latest.current.summary.total, 10);
  assert.equal(latest.previous.data[0].date, '2026-10-27');
  assert.equal(latest.view.compare.short, '2 hari sebelumnya');
});

test('daily mode preserves the selected year comparison label and dates for conversion', async () => {
  const updates = [];
  const ui = setup(async (url) => Response.json(payload(url.searchParams.get('start_date'), [10])), (value) => updates.push(value));
  ui.elements.get('downloaderMode').value = 'daily';
  await ui.panel.load({ ...view, compare: { mode: 'yoy', short: 'tahun lalu', start: '2025-10-28', end: '2025-10-29' } });
  const latest = updates.at(-1);
  assert.equal(latest.view.compare.short, 'tahun lalu');
  assert.equal(latest.view.compare.start, '2025-10-29');
  assert.equal(latest.previous.data[0].date, '2025-10-29');
});
