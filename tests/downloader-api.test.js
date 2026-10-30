import test from 'node:test';
import assert from 'node:assert/strict';

// These settings are confined to this test process; importing server.js does not start a listener.
process.env.DEMO = '1';
process.env.API_KEY = '';
process.env.API_KEY_QUERY = '';
process.env.PLATFORMS = 'jadiasn:JadiASN,jadibumn:JadiBUMN';
process.env.DEFAULT_PLATFORM = 'all';
process.env.DASHBOARD_USER = 'test-sales';
process.env.DASHBOARD_PASSWORD = 'test-password';
process.env.VERCEL = '1';
const { handler } = await import('../server.js');

async function request(url, { method = 'GET', authenticated = true } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: 'localhost' };
    if (authenticated) headers.authorization = `Basic ${Buffer.from('test-sales:test-password').toString('base64')}`;
    const response = { status: null, headers: {}, writeHead(code, values = {}) { this.status = code; this.headers = values; }, end(body = '') { resolve({ ...this, body: String(body) }); } };
    Promise.resolve(handler({ url, method, headers }, response)).catch(reject);
  });
}

test('downloader endpoints are protected by dashboard authentication', async () => {
  const response = await request('/api/downloaders?platform=all&date=2026-10-29', { authenticated: false });
  assert.equal(response.status, 401);
  assert.match(response.headers['WWW-Authenticate'], /Basic/);
  assert.equal(response.body.includes('test-password'), false);
});

test('date alias returns demo daily totals; all and platform filters use consistent aggregates', async () => {
  const single = await request('/api/downloaders?platform=jadiasn&date=2026-10-29');
  const second = await request('/api/downloaders?platform=jadibumn&date=2026-10-29');
  const all = await request('/api/downloaders?platform=all&start_date=2026-10-29&end_date=2026-10-29');
  assert.equal(single.status, 200);
  assert.equal(all.status, 200);
  const data = JSON.parse(all.body);
  assert.equal(data.demo, true);
  assert.equal(data.summary.total, JSON.parse(single.body).summary.total + JSON.parse(second.body).summary.total);
  assert.equal(data.data[0].date, '2026-10-29');
  assert.deepEqual(data.per_platform.map((row) => row.total), [JSON.parse(single.body).summary.total, JSON.parse(second.body).summary.total]);
  assert.equal(all.headers['Cache-Control'], 'no-store');
});

test('invalid dates and unknown platforms are rejected before data access', async () => {
  for (const query of ['platform=all&date=2026-02-30', 'platform=all', 'platform=notconfigured&date=2026-10-29']) {
    const result = await request(`/api/downloaders?${query}`);
    assert.equal(result.status, 400);
    assert.equal(JSON.parse(result.body).status, false);
  }
  assert.equal((await request('/api/downloaders?date=2026-10-29', { method: 'POST' })).status, 405);
});
