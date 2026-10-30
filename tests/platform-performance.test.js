import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformDownloader, platformMetrics } from '../web/platform-performance.js';
import { fetchDownloaderRange } from '../web/downloader-data.js';

const range = { start: '2026-10-28', end: '2026-10-29', days: 2 };
const apiUrl = (path) => new URL(path, 'http://localhost');
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('platform modes keep success transactions and use their own denominators', () => {
  const sales = { total: 10, success: 6 };
  const downloads = { complete: true, total: 30 };
  assert.deepEqual(platformMetrics(sales, 'purchase', downloads), { denominator: 10, conversion: 0.6 });
  assert.deepEqual(platformMetrics(sales, 'conversion', downloads), { denominator: 30, conversion: 0.2 });
  assert.equal(platformMetrics({ total: 2, success: 2 }, 'conversion', { complete: true, total: 1 }).conversion, 2);
  assert.equal(platformMetrics({ total: 0, success: 0 }, 'conversion', downloads).conversion, 0);
});

test('unavailable, partial, and zero downloads never produce a misleading percentage', () => {
  for (const downloads of [undefined, { complete: false, total: null, known_total: 20 }, { complete: true, total: 0 }]) {
    assert.ok(Number.isNaN(platformMetrics({ total: 10, success: 6 }, 'conversion', downloads).conversion));
  }
  assert.equal(platformMetrics({ total: 10, success: 6 }, 'conversion', { complete: true, total: 0 }).denominator, 0);
  assert.equal(platformMetrics({ total: 10, success: 6 }, 'conversion', undefined).denominator, null);
  assert.ok(Number.isNaN(platformMetrics({ total: 10, success: 6 }, 'conversion', { complete: true, total: 20 }, false).conversion));
});

test('daily chunks preserve independent platform completeness across the full selected period', async () => {
  const calls = [];
  const progress = [];
  const result = await fetchDownloaderRange({ apiUrl, platform: 'all', range, signal: new AbortController().signal,
    onProgress: (days) => progress.push(days),
    fetchImpl: async (url) => {
      calls.push(url);
      const missing = url.searchParams.get('start_date') === range.end;
      return Response.json({ status: true, demo: true,
        data: [{ date: url.searchParams.get('start_date'), total: missing ? null : 10, known_total: 10, missing_platforms: missing ? ['b'] : [] }],
        per_platform: [
          { platform: 'a', complete: true, total: 10, known_total: 10, complete_days: 1, days: 1 },
          { platform: 'b', complete: !missing, total: missing ? null : 0, known_total: 0, complete_days: missing ? 0 : 1, days: 1 },
        ],
      });
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((url) => [url.searchParams.get('start_date'), url.searchParams.get('end_date')]), [[range.start, range.start], [range.end, range.end]]);
  assert.deepEqual(progress, [1, 2]);
  assert.deepEqual(result.per_platform, [
    { platform: 'a', known_total: 20, complete_days: 2, days: 2, complete: true, total: 20 },
    { platform: 'b', known_total: 0, complete_days: 1, days: 2, complete: false, total: null },
  ]);
  assert.equal(result.summary.total, null);
  assert.equal(result.demo, true);
  assert.equal(result.warnings.length, 1);
});

test('default purchase mode makes no downloader request; conversion loads the entire sales period', async () => {
  const calls = [];
  const loader = createPlatformDownloader({ apiUrl, onUpdate: () => {}, request: async (options) => { calls.push(options); return { per_platform: [] }; } });
  loader.setContext({ platform: 'all', range });
  assert.equal(calls.length, 0);
  loader.setMode('conversion');
  await tick();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].range, range);
  loader.setMode('purchase');
  loader.setMode('conversion');
  assert.equal(calls.length, 1, 'switching back reuses completed data for the applied range');
  loader.setContext({ platform: 'jadiasn', range });
  await tick();
  assert.equal(calls.length, 1, 'hidden platform comparison does not fetch downloads');
});

test('changing period or leaving conversion aborts requests and ignores late results/progress', async () => {
  const pending = [];
  const updates = [];
  const loader = createPlatformDownloader({ apiUrl, onUpdate: (value) => updates.push(value), request: (options) => new Promise((resolve) => pending.push({ ...options, resolve })) });
  loader.setMode('conversion');
  loader.setContext({ platform: 'all', range });
  const nextRange = { start: '2026-10-27', end: '2026-10-27', days: 1 };
  loader.setContext({ platform: 'all', range: nextRange });
  assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve({ marker: 'new', per_platform: [] });
  await tick();
  const count = updates.length;
  pending[0].onProgress(2);
  pending[0].resolve({ marker: 'old', per_platform: [] });
  await tick();
  assert.equal(updates.length, count);
  assert.equal(loader.snapshot().data.marker, 'new');
  loader.setContext({ platform: 'all', range });
  loader.setMode('purchase');
  assert.equal(pending[2].signal.aborted, true);
  pending[2].resolve({ marker: 'canceled', per_platform: [] });
  await tick();
  assert.equal(loader.snapshot().data, null);
  assert.equal(loader.snapshot().loading, false);
});

test('failed downloads can be retried without reloading sales', async () => {
  let calls = 0;
  const loader = createPlatformDownloader({ apiUrl, onUpdate: () => {}, request: async () => {
    if (++calls === 1) throw new Error('Gagal memuat downloader');
    return { per_platform: [] };
  } });
  loader.setMode('conversion');
  loader.setContext({ platform: 'all', range });
  await tick();
  assert.match(loader.snapshot().error, /Gagal/);
  loader.retry();
  await tick();
  assert.equal(calls, 2);
  assert.equal(loader.snapshot().error, '');
  assert.ok(loader.snapshot().data);
});
