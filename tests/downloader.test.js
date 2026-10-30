import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownloaderService, downloaderDates, requestDailyDownloader } from '../downloader.js';
import { compareDownloaderCounts } from '../web/downloaders.js';

const platforms = [{ slug: 'jadiasn', name: 'JadiASN' }, { slug: 'jadibumn', name: 'JadiBUMN' }];
const service = (options = {}) => createDownloaderService({ platforms, today: () => '2026-10-29', requestDaily: async () => 0, ...options });

test('date ranges are inclusive across leap days and month/year boundaries', () => {
  assert.deepEqual(downloaderDates('2024-02-28', '2024-03-01'), ['2024-02-28', '2024-02-29', '2024-03-01']);
  assert.deepEqual(downloaderDates('2025-12-31', '2026-01-01'), ['2025-12-31', '2026-01-01']);
  assert.equal(downloaderDates('2026-01-01', '2027-02-04').length, 400);
  for (const range of [['2026-02-29', '2026-03-01'], ['2026-13-01', '2026-13-01'], ['2026-10-30', '2026-10-29'], ['', ''], ['2026-01-01', '2027-02-05']]) {
    assert.throws(() => downloaderDates(...range), { code: 400 });
  }
});

test('upstream requests use the documented date and the verified required platform with server-side authorization', async () => {
  let called;
  const total = await requestDailyDownloader({
    baseUrl: 'https://markaz.example', apiKey: 'test-secret', authMode: { header: 'Authorization' }, platform: 'jadiasn', date: '2026-10-29',
    fetchImpl: async (url, options) => { called = { url, options }; return Response.json({ status: true, data: { total: 165 } }); },
  });
  assert.equal(total, 165);
  assert.equal(called.url.pathname, '/api/user-daily');
  assert.equal(called.url.searchParams.get('platform'), 'jadiasn');
  assert.equal(called.url.searchParams.get('date'), '2026-10-29');
  assert.equal(called.url.searchParams.has('start_date'), false);
  assert.equal(called.options.headers.Authorization, 'test-secret');
  assert.equal(called.url.toString().includes('test-secret'), false);
});

test('upstream authentication overrides remain supported', async () => {
  await requestDailyDownloader({
    baseUrl: 'https://markaz.example', apiKey: 'test-secret', authMode: { query: 'api_key' }, platform: 'jadiasn', date: '2026-10-29',
    fetchImpl: async (url) => { assert.equal(url.searchParams.get('api_key'), 'test-secret'); return Response.json({ status: true, data: { total: 0 } }); },
  });
});

test('invalid keys, malformed totals, non-JSON responses and network failures are not treated as zero', async () => {
  const options = { baseUrl: 'https://markaz.example', apiKey: 'test-secret', authMode: { header: 'Authorization' }, platform: 'jadiasn', date: '2026-10-29' };
  await assert.rejects(requestDailyDownloader({ ...options, fetchImpl: async () => Response.json({ status: false, message: 'Invalid API Key' }, { status: 401 }) }), { code: 401 });
  for (const total of [null, -1, '12', 1.5]) {
    await assert.rejects(requestDailyDownloader({ ...options, fetchImpl: async () => Response.json({ status: true, data: { total } }) }), { code: 502 });
  }
  await assert.rejects(requestDailyDownloader({ ...options, fetchImpl: async () => new Response('not JSON') }), { code: 502 });
  await assert.rejects(requestDailyDownloader({ ...options, fetchImpl: async () => { throw new Error('private infrastructure information'); } }), { code: 502, message: 'Tidak dapat terhubung ke API downloader Markaz.' });
});

test('all platforms are summed per date without sending platform=all upstream', async () => {
  const calls = [];
  const api = service({ requestDaily: async (platform, date) => {
    calls.push([platform, date]);
    return platform === 'jadiasn' ? (date.endsWith('28') ? 10 : 15) : 5;
  } });
  const result = await api.getRange('all', '2026-10-28', '2026-10-29');
  assert.deepEqual(result.data.map((row) => row.total), [15, 20]);
  assert.deepEqual(result.summary, { complete: true, total: 35, known_total: 35, complete_days: 2, days: 2 });
  assert.deepEqual(result.per_platform, [
    { platform: 'jadiasn', complete: true, total: 25, known_total: 25, complete_days: 2, days: 2 },
    { platform: 'jadibumn', complete: true, total: 10, known_total: 10, complete_days: 2, days: 2 },
  ]);
  assert.equal(calls.length, 4);
  assert.equal(calls.some(([platform]) => platform === 'all'), false);
  const single = await api.getRange('jadiasn', '2026-10-29', '2026-10-29');
  assert.equal(single.summary.total, 15);
  assert.equal(calls.length, 4, 'single-platform requests reuse the same successful daily cache');
});

test('missing data remains null, partial counts are labelled, and failed days can be retried', async () => {
  let failing = true;
  const api = service({ requestDaily: async (platform, date) => {
    if (platform === 'jadibumn' && date.endsWith('29') && failing) throw new Error('upstream unavailable');
    return platform === 'jadiasn' ? 10 : 5;
  } });
  const result = await api.getRange('all', '2026-10-28', '2026-10-29');
  assert.equal(result.summary.complete, false);
  assert.equal(result.summary.total, null);
  assert.equal(result.summary.known_total, 25);
  assert.deepEqual(result.data[1], { date: '2026-10-29', total: null, known_total: 10, missing_platforms: ['jadibumn'] });
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(result.per_platform, [
    { platform: 'jadiasn', complete: true, total: 20, known_total: 20, complete_days: 2, days: 2 },
    { platform: 'jadibumn', complete: false, total: null, known_total: 5, complete_days: 1, days: 2 },
  ]);
  failing = false;
  const retried = await api.getRange('all', '2026-10-28', '2026-10-29');
  assert.equal(retried.summary.total, 30);
  assert.deepEqual(retried.warnings, []);
});

test('authentication failures fail the request rather than returning partial successful totals', async () => {
  const api = service({ requestDaily: async () => { throw Object.assign(new Error('Invalid API Key'), { code: 401 }); } });
  await assert.rejects(api.getRange('all', '2026-10-01', '2026-10-29'), { code: 401 });
  await assert.rejects(api.getRange('unknown-platform', '2026-10-29', '2026-10-29'), { code: 400 });
});

test('concurrent overlapping requests deduplicate calls and never exceed three upstream requests', async () => {
  let active = 0;
  let maximum = 0;
  const calls = new Map();
  const api = service({ requestDaily: async (platform, date) => {
    active++;
    maximum = Math.max(maximum, active);
    const key = `${platform}|${date}`;
    calls.set(key, (calls.get(key) || 0) + 1);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return 1;
  } });
  const [first, second] = await Promise.all([
    api.getRange('all', '2026-10-25', '2026-10-29'),
    api.getRange('all', '2026-10-25', '2026-10-29'),
  ]);
  assert.equal(first.summary.total, 10);
  assert.equal(second.summary.total, 10);
  assert.equal(maximum, 3);
  assert.equal(calls.size, 10);
  assert.equal([...calls.values()].every((count) => count === 1), true);
});

test('valid zero counts are cached, with a shorter TTL for recent days', async () => {
  let clock = Date.parse('2026-10-29T03:00:00Z');
  let calls = 0;
  const api = service({ now: () => clock, requestDaily: async () => { calls++; return 0; } });
  assert.equal((await api.getRange('jadiasn', '2026-10-29', '2026-10-29')).summary.total, 0);
  await api.getRange('jadiasn', '2026-10-01', '2026-10-01');
  await api.getRange('jadiasn', '2026-10-29', '2026-10-29');
  assert.equal(calls, 2);
  clock += 2 * 60000;
  await api.getRange('jadiasn', '2026-10-29', '2026-10-29');
  await api.getRange('jadiasn', '2026-10-01', '2026-10-01');
  assert.equal(calls, 3);
  clock += 30 * 60000;
  await api.getRange('jadiasn', '2026-10-01', '2026-10-01');
  assert.equal(calls, 4);
});

test('time budget exhaustion reports missing days and does not silently fill them with zeros', async () => {
  const api = service({ budgetMs: 0, requestDaily: async () => { throw new Error('must not request'); } });
  const result = await api.getRange('all', '2026-10-28', '2026-10-29');
  assert.equal(result.summary.total, null);
  assert.equal(result.summary.complete_days, 0);
  assert.equal(result.data.every((row) => row.total === null && row.missing_platforms.length === 2), true);
});

test('demo data are deterministic and never contact Markaz', async () => {
  const api = service({ demo: true, requestDaily: async () => { throw new Error('must not request'); } });
  const first = await api.getRange('all', '2026-10-28', '2026-10-29');
  assert.deepEqual(await api.getRange('all', '2026-10-28', '2026-10-29'), first);
  assert.ok(first.summary.total > 0);
});

test('comparisons distinguish unavailable data, zero and percentage growth', () => {
  assert.equal(compareDownloaderCounts(null, 10), '—');
  assert.equal(compareDownloaderCounts(0, null), '—');
  assert.equal(compareDownloaderCounts(0, 0), 'Tidak berubah (0)');
  assert.equal(compareDownloaderCounts(10, 0), 'Bertambah 10 (pembanding 0)');
  assert.equal(compareDownloaderCounts(15, 10), '▲ 50%');
  assert.equal(compareDownloaderCounts(0, 10), '▼ 100%');
});
