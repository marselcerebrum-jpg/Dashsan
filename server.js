// Dashboard Sales — server kecil tanpa dependency.
// - Menyajikan file statis di ./public
// - Proxy ke API transaksi (API key disimpan di server, tidak pernah dikirim ke browser)
// - Memecah rentang tanggal panjang menjadi potongan <= 31 hari + cache in-memory
// - Mode demo (data contoh) bila API_BASE_URL belum diisi atau DEMO=1

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);
const API_BASE_URL = (process.env.API_BASE_URL || '').replace(/\/+$/, '');
const API_KEY = process.env.API_KEY || '';
const API_KEY_HEADER = process.env.API_KEY_HEADER || 'x-api-key';
const API_KEY_QUERY = process.env.API_KEY_QUERY || ''; // isi mis. "api_key" jika key dikirim lewat query string
const DEFAULT_PLATFORM = process.env.DEFAULT_PLATFORM || 'jadiasn';
const DEMO = process.env.DEMO === '1' || !API_BASE_URL;
const CHUNK_DAYS = 31;
const MAX_RANGE_DAYS = 400;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const val = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

// ---------- util tanggal (pakai UTC agar tidak tergeser timezone) ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const toDate = (s) => new Date(`${s}T00:00:00Z`);
const fmt = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const todayStr = () => fmt(new Date(Date.now() + 7 * 3600000)); // WIB

function splitRange(start, end) {
  const chunks = [];
  let cur = toDate(start);
  const last = toDate(end);
  while (cur <= last) {
    const chunkEnd = addDays(cur, CHUNK_DAYS - 1);
    chunks.push([fmt(cur), fmt(chunkEnd < last ? chunkEnd : last)]);
    cur = addDays(chunkEnd, 1);
  }
  return chunks;
}

// ---------- cache ----------
const cache = new Map();
function cacheTtl(chunkEnd) {
  // Data periode lampau jarang berubah (kecuali status pending) → cache lebih lama
  return chunkEnd < todayStr() ? 30 * 60 * 1000 : 2 * 60 * 1000;
}

async function fetchChunk(platform, start, end, status) {
  const key = `${platform}|${start}|${end}|${status}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;

  const url = new URL(`${API_BASE_URL}/api/transaction`);
  url.searchParams.set('platform', platform);
  if (start === end) url.searchParams.set('date', start);
  else {
    url.searchParams.set('start_date', start);
    url.searchParams.set('end_date', end);
  }
  if (status !== '') url.searchParams.set('status', status);
  if (API_KEY_QUERY) url.searchParams.set(API_KEY_QUERY, API_KEY);

  const headers = { Accept: 'application/json' };
  if (!API_KEY_QUERY) headers[API_KEY_HEADER] = API_KEY;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
  let body;
  try {
    body = await res.json();
  } catch {
    throw Object.assign(new Error(`Respons API bukan JSON (HTTP ${res.status})`), { code: 502 });
  }
  if (!res.ok || body.status === false) {
    throw Object.assign(new Error(body.message || `API error HTTP ${res.status}`), {
      code: res.status === 401 ? 401 : 502,
    });
  }
  const data = Array.isArray(body.data) ? body.data : [];
  cache.set(key, { data, expires: Date.now() + cacheTtl(end) });
  return data;
}

async function getTransactions(platform, start, end, status) {
  if (DEMO) return demoTransactions(platform, start, end, status);
  const chunks = splitRange(start, end);
  const out = [];
  // maksimal 3 request paralel agar tidak membebani API
  for (let i = 0; i < chunks.length; i += 3) {
    const part = await Promise.all(
      chunks.slice(i, i + 3).map(([s, e]) => fetchChunk(platform, s, e, status)),
    );
    for (const p of part) out.push(...p);
  }
  // hilangkan duplikat bila ada
  const seen = new Set();
  return out.filter((t) => (seen.has(t.id) ? false : seen.add(t.id)));
}

// ---------- data demo ----------
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const pick = (r, arr, weights) => {
  if (!weights) return arr[Math.floor(r() * arr.length)];
  const total = weights.reduce((a, b) => a + b, 0);
  let x = r() * total;
  for (let i = 0; i < arr.length; i++) if ((x -= weights[i]) < 0) return arr[i];
  return arr[arr.length - 1];
};
const DEMO_PRODUCTS = [
  ['Bimbel Persiapan Tes SKD CPNS 2026 - Masa Aktif 2 Tahun', 213000],
  ['Bimbel Persiapan Tes SKD CPNS 2026 - Masa Aktif 1 Tahun', 149000],
  ['Paket Tryout SKD CPNS Premium', 79000],
  ['Bimbel SKB Teknis + SKD Bundling', 299000],
  ['Kelas Intensif TWK TIU TKP 30 Hari', 99000],
  ['Paket Tryout Akbar Nasional', 39000],
  ['Bimbel PPPK Teknis 2026', 189000],
];
const DEMO_NAMES = ['Salamah', 'Rizky', 'Dewi', 'Andi', 'Siti', 'Budi', 'Nur', 'Fajar', 'Putri', 'Agus', 'Rina', 'Hendra', 'Lestari', 'Yusuf', 'Wulan', 'Dimas', 'Indah', 'Arif', 'Maya', 'Ilham'];
const DEMO_PAY = ['BNI', 'BRI', 'Mandiri', 'BCA', 'QRIS', 'DANA', 'OVO', 'ShopeePay'];
const DEMO_STATUS_MSG = ['Pending', 'Success', 'Expired', 'Canceled', 'Failed'];

function demoTransactions(platform, start, end, status) {
  const out = [];
  let d = toDate(start);
  const last = toDate(end);
  while (d <= last) {
    const ds = fmt(d);
    const r = rng(Number(ds.replace(/-/g, '')));
    const dow = d.getUTCDay();
    const base = 35 + (dow === 0 || dow === 6 ? -8 : 6) + Math.floor(r() * 25);
    for (let i = 0; i < base; i++) {
      const [product, price] = pick(r, DEMO_PRODUCTS, [30, 22, 18, 8, 10, 14, 6]);
      const hour = pick(r, [...Array(24).keys()], [1, 1, 1, 1, 1, 2, 4, 6, 7, 8, 8, 9, 10, 8, 7, 7, 8, 9, 10, 13, 15, 14, 9, 4]);
      const time = `${String(hour).padStart(2, '0')}:${String(Math.floor(r() * 60)).padStart(2, '0')}:${String(Math.floor(r() * 60)).padStart(2, '0')}`;
      const pay = pick(r, DEMO_PAY, [18, 20, 12, 10, 22, 8, 5, 5]);
      const failBias = pay === 'Mandiri' ? 1.6 : 1;
      const st = pick(r, [0, 1, 2, 3, 4], [4, 62, 20 * failBias, 8, 6 * failBias]);
      const promo = r() < 0.28 ? pick(r, ['CPNS26', 'HEMAT20', 'FLASHSALE', 'ALUMNI'], [40, 30, 20, 10]) : null;
      const disc = promo ? (promo === 'HEMAT20' ? 0.8 : promo === 'FLASHSALE' ? 0.7 : 0.9) : 1;
      const cust = Math.floor(r() * 900);
      const id = Number(ds.replace(/-/g, '').slice(2)) * 100 + i;
      out.push({
        id,
        trx_id: `${platform}-${id}`,
        date: `${ds} ${time}`,
        paid_date: st === 1 ? `${ds} ${time}` : null,
        payment_method: pay,
        nominal: Math.round((price * disc) / 1000) * 1000,
        promo_code: promo,
        product,
        product_price: price,
        product_type: pick(r, ['Perdana', 'Perpanjangan', 'Upgrade'], [70, 18, 12]),
        customer_name: `${DEMO_NAMES[cust % DEMO_NAMES.length]} ${cust}`,
        customer_phone: `8${String(1200000000 + cust * 7919).slice(0, 10)}`,
        customer_email: `customer${cust}@example.com`,
        status: st,
        status_message: DEMO_STATUS_MSG[st],
      });
    }
    d = addDays(d, 1);
  }
  return status === '' ? out : out.filter((t) => String(t.status) === status);
}

// ---------- HTTP ----------
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/config') {
    return sendJson(res, 200, { demo: DEMO, defaultPlatform: DEFAULT_PLATFORM, today: todayStr() });
  }
  if (url.pathname !== '/api/transactions') return sendJson(res, 404, { status: false, message: 'Not found' });

  const platform = (url.searchParams.get('platform') || DEFAULT_PLATFORM).trim();
  const start = url.searchParams.get('start_date') || '';
  const end = url.searchParams.get('end_date') || start;
  const status = url.searchParams.get('status') ?? '';

  if (!/^[a-z0-9_-]+$/i.test(platform)) return sendJson(res, 400, { status: false, message: 'platform tidak valid' });
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) return sendJson(res, 400, { status: false, message: 'Format tanggal harus YYYY-MM-DD' });
  if (end < start) return sendJson(res, 400, { status: false, message: 'end_date tidak boleh kurang dari start_date' });
  if ((toDate(end) - toDate(start)) / 86400000 > MAX_RANGE_DAYS) return sendJson(res, 400, { status: false, message: `Rentang maksimal ${MAX_RANGE_DAYS} hari` });
  if (status !== '' && !/^[0-4]$/.test(status)) return sendJson(res, 400, { status: false, message: 'status harus 0-4' });

  try {
    const data = await getTransactions(platform, start, end, status);
    sendJson(res, 200, { status: true, demo: DEMO, fetched_at: new Date().toISOString(), data });
  } catch (err) {
    console.error('[api]', err.message);
    sendJson(res, err.code || 502, { status: false, message: err.message, data: null });
  }
}

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(__dirname, 'public', rel));
  if (!file.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method !== 'GET') {
    res.writeHead(405);
    return res.end();
  }
  if (url.pathname.startsWith('/api/')) return void handleApi(req, res, url);
  serveStatic(req, res, url);
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => {
    console.log(`Dashboard Sales berjalan di http://localhost:${PORT}`);
    console.log(DEMO ? '⚠  MODE DEMO: API_BASE_URL belum diisi, menampilkan data contoh.' : `Sumber data: ${API_BASE_URL}/api/transaction`);
  });
}

export { server, splitRange, demoTransactions };
