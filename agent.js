// Agent Tele — kirim insight & rekomendasi sales per platform ke grup Telegram CS.
// - Penyimpanan pengaturan: Vercel Blob (private) bila BLOB_READ_WRITE_TOKEN ada, selain itu file lokal .data/
// - Penulis pesan: Claude (ANTHROPIC_API_KEY); tanpa key memakai template sederhana
// - Pengiriman: Telegram Bot API (TELEGRAM_BOT_TOKEN)
// - Jadwal: Vercel Cron memanggil /api/agent/cron tiap 3 jam (lihat vercel.json)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { get as blobGet, put as blobPut } from '@vercel/blob';

const TELEGRAM_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || '';
const CLAUDE_MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const STATE_PATH = 'agent/state.json';
const SLOTS = [0, 3, 6, 9, 12, 15, 18, 21]; // jam WIB
const HISTORY_MAX = 150;

const DEFAULT_STATE = {
  groups: [], // { chatId, title, type, platforms: [slug | 'all'], enabled, addedAt, removed }
  schedule: { enabled: false, slots: [...SLOTS] },
  instructions: '',
  history: [], // { at, chatId, title, trigger, ok, error, preview }
  lastSlot: '',
};

// ---------- util waktu (WIB) ----------
const wibNow = () => new Date(Date.now() + 7 * 3600000);
const ymd = (d) => d.toISOString().slice(0, 10);
const addDaysStr = (s, n) => ymd(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000));
const hhmmss = (d) => d.toISOString().slice(11, 19);

// ---------- penyimpanan ----------
const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const localFile = (root) => path.join(root, '.data', 'agent-state.json');

async function loadState(root) {
  let raw = null;
  try {
    if (useBlob()) {
      const r = await blobGet(STATE_PATH, { access: 'private', useCache: false });
      if (r?.statusCode === 200) raw = await new Response(r.stream).text();
    } else if (fs.existsSync(localFile(root))) {
      raw = fs.readFileSync(localFile(root), 'utf8');
    }
  } catch (err) {
    // blob belum pernah ditulis → mulai dari default
    if (!/not.?found|404/i.test(String(err?.message))) throw err;
  }
  const s = raw ? JSON.parse(raw) : {};
  return { ...structuredClone(DEFAULT_STATE), ...s, schedule: { ...DEFAULT_STATE.schedule, ...(s.schedule || {}) } };
}

async function saveState(root, state) {
  const body = JSON.stringify(state, null, 1);
  if (useBlob()) {
    await blobPut(STATE_PATH, body, { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
  } else {
    fs.mkdirSync(path.dirname(localFile(root)), { recursive: true });
    fs.writeFileSync(localFile(root), body);
  }
}

// ---------- Telegram ----------
async function tg(method, body) {
  if (!TELEGRAM_TOKEN()) throw Object.assign(new Error('TELEGRAM_BOT_TOKEN belum diatur'), { code: 400 });
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw Object.assign(new Error(`Telegram: ${data.description || `HTTP ${res.status}`}`), { code: 502, tgCode: data.error_code });
  return data.result;
}

// Telegram menerima HTML terbatas. Semua teks di-escape, lalu hanya tag aman yang dikembalikan.
function telegramHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/&lt;(\/?)(b|i|u|s|code)&gt;/g, '<$1$2>');
}

function splitMessage(text, max = 3800) {
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

async function sendTelegram(chatId, text) {
  for (const part of splitMessage(text)) {
    try {
      await tg('sendMessage', { chat_id: chatId, text: telegramHtml(part), parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    } catch (err) {
      // tag tidak seimbang dsb. → kirim ulang sebagai teks biasa
      if (err.tgCode === 400 && /parse/i.test(err.message)) await tg('sendMessage', { chat_id: chatId, text: part.replace(/<\/?(b|i|u|s|code)>/g, '') });
      else throw err;
    }
  }
}

// Grup terdeteksi dari update Telegram (bot dimasukkan/dikeluarkan dari grup, atau ada pesan di grup).
// getUpdates hanya menyimpan update ±24 jam terakhir.
async function detectGroups(state) {
  const updates = await tg('getUpdates', { allowed_updates: ['my_chat_member', 'message'], limit: 100 });
  const found = new Map();
  for (const u of updates) {
    const chat = u.my_chat_member?.chat || u.message?.chat;
    if (!chat || !['group', 'supergroup'].includes(chat.type)) continue;
    const status = u.my_chat_member?.new_chat_member?.status;
    found.set(String(chat.id), { chatId: String(chat.id), title: chat.title || String(chat.id), type: chat.type, removed: status ? ['left', 'kicked'].includes(status) : undefined });
  }
  let added = 0;
  for (const g of found.values()) {
    const cur = state.groups.find((x) => x.chatId === g.chatId);
    if (cur) {
      cur.title = g.title;
      if (g.removed !== undefined) cur.removed = g.removed;
    } else if (!g.removed) {
      state.groups.push({ ...g, platforms: [], enabled: false, removed: false, addedAt: new Date().toISOString() });
      added++;
    }
  }
  // tandai update sudah dibaca supaya tidak menumpuk
  if (updates.length) await tg('getUpdates', { offset: updates[updates.length - 1].update_id + 1, limit: 1 });
  return { added, seen: found.size };
}

// ---------- ringkasan data per platform ----------
function promoCode(v) {
  let c = v;
  if (typeof v === 'string') { try { c = JSON.parse(v); } catch { c = v; } }
  if (!Array.isArray(c)) c = c == null ? [] : [c];
  const out = [...new Set(c.map((x) => String(x ?? '').trim().toUpperCase()).filter((x) => x && x !== 'NULL'))];
  return out.length ? out.join(', ') : null;
}
const closingTime = (t) => String(Number(t.status) === 1 && /^\d{4}-/.test(String(t.paid_date)) ? t.paid_date : t.date).slice(11, 19);
const personKey = (t) => String(t.customer_phone || '').replace(/\D/g, '').replace(/^(62|0)/, '') || String(t.customer_email || '').toLowerCase();
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

function summarize(rows) {
  const ok = rows.filter((t) => Number(t.status) === 1);
  const revenue = ok.reduce((a, t) => a + (Number(t.nominal) || 0), 0);
  return {
    checkout: rows.length,
    sukses: ok.length,
    omzet: revenue,
    conversion_pct: pct(ok.length, rows.length),
    pending: rows.filter((t) => Number(t.status) === 0).length,
    expired: rows.filter((t) => Number(t.status) === 2).length,
    gagal: rows.filter((t) => Number(t.status) === 4).length,
  };
}

function topBy(rows, keyFn, n = 3) {
  const m = new Map();
  for (const t of rows) {
    const k = keyFn(t);
    if (!k) continue;
    const g = m.get(k) || { nama: k, checkout: 0, sukses: 0, omzet: 0 };
    g.checkout++;
    if (Number(t.status) === 1) { g.sukses++; g.omzet += Number(t.nominal) || 0; }
    m.set(k, g);
  }
  return [...m.values()].map((g) => ({ ...g, conversion_pct: pct(g.sukses, g.checkout) })).sort((a, b) => b.omzet - a.omzet || b.checkout - a.checkout).slice(0, n);
}

// Calon pembeli hari ini: orang dengan checkout tidak sukses dan tanpa pembelian sukses di 8 hari terakhir
function leadsToday(today, recent) {
  const bought = new Set(recent.filter((t) => Number(t.status) === 1).map(personKey).filter(Boolean));
  const people = new Map();
  for (const t of today) {
    if (Number(t.status) === 1) continue;
    const k = personKey(t);
    if (!k || bought.has(k)) continue;
    people.set(k, t);
  }
  const list = [...people.values()];
  return { jumlah_orang: list.length, masih_pending: list.filter((t) => Number(t.status) === 0).length, potensi_omzet: list.reduce((a, t) => a + (Number(t.nominal) || 0), 0) };
}

async function buildFacts(deps, platforms) {
  const now = wibNow();
  const today = ymd(now);
  const cutoff = hhmmss(now);
  const slugs = platforms.includes('all') ? deps.PLATFORMS.map((p) => p.slug) : platforms;
  const name = (s) => deps.PLATFORMS.find((p) => p.slug === s)?.name || s;
  const start = addDaysStr(today, -8);
  const rows = [];
  const warnings = [];
  if (platforms.includes('all')) {
    const r = await deps.getTransactions('all', start, today, '');
    rows.push(...r.rows);
    warnings.push(...r.warnings);
  } else {
    for (let i = 0; i < slugs.length; i += 3) {
      for (const r of await Promise.all(slugs.slice(i, i + 3).map((s) => deps.getTransactions(s, start, today, '')))) {
        rows.push(...r.rows);
        warnings.push(...r.warnings);
      }
    }
  }
  const mine = rows.filter((t) => slugs.includes(t.platform));
  const upToNow = (t) => closingTime(t) <= cutoff;
  const day = (d) => mine.filter((t) => t.closing_date === d);
  const yesterday = addDaysStr(today, -1);
  const lastWeek = addDaysStr(today, -7);

  const perPlatform = slugs.map((slug) => {
    const r = mine.filter((t) => t.platform === slug);
    const d = (x) => r.filter((t) => t.closing_date === x);
    const last7 = r.filter((t) => t.closing_date >= addDaysStr(today, -7) && t.closing_date < today);
    const t0 = d(today);
    return {
      platform: name(slug),
      hari_ini: summarize(t0),
      kemarin_jam_sama: summarize(d(yesterday).filter(upToNow)),
      minggu_lalu_hari_sama_jam_sama: summarize(d(lastWeek).filter(upToNow)),
      kemarin_full: summarize(d(yesterday)),
      rata2_harian_7_hari: (() => { const s = summarize(last7); return { checkout: Math.round(s.checkout / 7), sukses: Math.round(s.sukses / 7), omzet: Math.round(s.omzet / 7) }; })(),
      produk_teratas_hari_ini: topBy(t0, (t) => t.product),
      metode_bayar_hari_ini: topBy(t0, (t) => t.payment_method, 5),
      promo_teratas_hari_ini: topBy(t0, (t) => promoCode(t.promo_code)),
      calon_pembeli_belum_bayar_hari_ini: leadsToday(t0, r),
    };
  });
  return {
    waktu: `${today} ${cutoff.slice(0, 5)} WIB`,
    catatan: 'Data hari ini dihitung dari 00.00 WIB sampai jam sekarang; pembanding memakai rentang jam yang sama. Omzet = nominal transaksi sukses (termasuk biaya admin pembayaran). Transaksi sukses dihitung di tanggal bayar.',
    total: { hari_ini: summarize(day(today)), kemarin_jam_sama: summarize(day(yesterday).filter(upToNow)) },
    per_platform: perPlatform,
    peringatan_data: warnings,
  };
}

// ---------- penulisan pesan ----------
const SYSTEM_PROMPT = `Anda adalah analis sales untuk bisnis bimbel online (persiapan CPNS, BUMN, Polri/TNI, kedinasan, TOEFL, dll.). Tugas Anda menulis pesan update berkala untuk grup Telegram tim Customer Service (CS) agar mereka sadar kondisi penjualan per platform dan tahu apa yang harus dikerjakan sekarang.

Aturan:
- Bahasa Indonesia yang santai tapi profesional, langsung ke inti. Maksimal ±200 kata.
- Pakai HANYA angka dari data JSON yang diberikan. Jangan mengarang angka, nama, atau penyebab yang tidak didukung data; bila menduga penyebab, sebut sebagai dugaan.
- Struktur: 1 baris judul (platform + jam), ringkasan angka utama hari ini vs kemarin di jam yang sama, lalu 2-4 rekomendasi aksi konkret untuk CS (misal follow-up calon pembeli yang belum bayar, bantu customer dengan metode bayar yang sering gagal, dorong produk/promo yang sedang laku).
- Format Telegram: gunakan hanya tag <b> dan <i> untuk penekanan, "•" untuk butir. Jangan pakai Markdown (**, #), tabel, atau tag lain.
- Format rupiah seperti Rp1,2 jt atau Rp185 rb. Persentase satu desimal.
- Jika hari ini masih sepi karena masih pagi/dini hari, katakan dengan wajar; jangan panik.
- Jika lebih dari satu platform, beri ringkasan gabungan singkat lalu sorot platform yang paling perlu perhatian.`;

const rupiah = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `Rp${(n / 1e6).toLocaleString('id-ID', { maximumFractionDigits: 1 })} jt`;
  if (a >= 1e3) return `Rp${Math.round(n / 1e3).toLocaleString('id-ID')} rb`;
  return `Rp${Math.round(n)}`;
};

// Tanpa ANTHROPIC_API_KEY: pesan dari template (tetap berguna untuk uji coba pengiriman)
function templateMessage(group, facts) {
  const lines = [`<b>Update Sales ${facts.waktu}</b>`, `<i>${group.title}</i>`, ''];
  for (const p of facts.per_platform) {
    const h = p.hari_ini, k = p.kemarin_jam_sama;
    const ch = k.omzet ? Math.round(((h.omzet - k.omzet) / k.omzet) * 100) : null;
    lines.push(`<b>${p.platform}</b>: ${rupiah(h.omzet)} dari ${h.sukses} trx sukses (conv ${h.conversion_pct ?? 0}%)` + (ch === null ? '' : ` • ${ch >= 0 ? '▲' : '▼'}${Math.abs(ch)}% vs kemarin jam sama`));
    const l = p.calon_pembeli_belum_bayar_hari_ini;
    if (l.jumlah_orang) lines.push(`• ${l.jumlah_orang} calon pembeli belum bayar (${l.masih_pending} pending), potensi ${rupiah(l.potensi_omzet)} — cek Daftar Follow-up di Dashsan`);
  }
  return lines.join('\n');
}

async function writeMessage(group, facts, instructions) {
  if (!process.env.ANTHROPIC_API_KEY) return { text: templateMessage(group, facts), writer: 'template' };
  const client = new Anthropic();
  const userContent = [
    `Grup tujuan: "${group.title}" (platform: ${facts.per_platform.map((p) => p.platform).join(', ')}).`,
    instructions ? `Instruksi tambahan dari admin:\n${instructions}` : '',
    'Data penjualan (JSON):',
    JSON.stringify(facts),
    'Tulis pesan Telegram-nya sekarang. Keluarkan hanya isi pesan.',
  ].filter(Boolean).join('\n\n');

  const response = await client.beta.messages.create({
    model: CLAUDE_MODEL(),
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });
  if (response.stop_reason === 'refusal') throw Object.assign(new Error(`Claude menolak menulis pesan (${response.stop_details?.category || 'tanpa kategori'})`), { code: 502 });
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) throw Object.assign(new Error('Claude tidak mengembalikan teks'), { code: 502 });
  return { text, writer: response.model };
}

// ---------- menjalankan ----------
function pushHistory(state, entry) {
  state.history.unshift({ at: new Date().toISOString(), ...entry });
  state.history = state.history.slice(0, HISTORY_MAX);
}

async function runGroups(deps, state, groups, trigger) {
  const results = [];
  // maksimal 3 grup paralel
  for (let i = 0; i < groups.length; i += 3) {
    const batch = await Promise.allSettled(groups.slice(i, i + 3).map(async (g) => {
      const facts = await buildFacts(deps, g.platforms);
      const { text, writer } = await writeMessage(g, facts, state.instructions);
      await sendTelegram(g.chatId, text);
      return { g, text, writer };
    }));
    batch.forEach((r, j) => {
      const g = groups[i + j];
      const entry = r.status === 'fulfilled'
        ? { chatId: g.chatId, title: g.title, trigger, ok: true, writer: r.value.writer, preview: r.value.text.slice(0, 600) }
        : { chatId: g.chatId, title: g.title, trigger, ok: false, error: r.reason?.message || String(r.reason) };
      pushHistory(state, entry);
      results.push(entry);
    });
  }
  return results;
}

const activeGroups = (state) => state.groups.filter((g) => g.enabled && !g.removed && g.platforms?.length);

// ---------- HTTP ----------
async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 200000) throw Object.assign(new Error('Body terlalu besar'), { code: 413 });
    chunks.push(c);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw Object.assign(new Error('Body bukan JSON'), { code: 400 });
  }
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// Vercel Cron mengirim "Authorization: Bearer <CRON_SECRET>"
export function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return !process.env.VERCEL; // lokal boleh tanpa secret
  return safeEqual(req.headers.authorization || '', `Bearer ${secret}`);
}

export function createAgentApi(deps) {
  const { root, sendJson } = deps;

  async function status() {
    let bot = null;
    let botError = null;
    if (TELEGRAM_TOKEN()) {
      try { bot = await tg('getMe'); } catch (err) { botError = err.message; }
    }
    return {
      telegram: { configured: Boolean(TELEGRAM_TOKEN()), username: bot?.username || null, error: botError },
      ai: { configured: Boolean(process.env.ANTHROPIC_API_KEY), model: CLAUDE_MODEL() },
      storage: useBlob() ? 'vercel-blob' : 'file-lokal',
      cron: { configured: Boolean(process.env.CRON_SECRET), slots: SLOTS },
    };
  }

  function findGroup(state, chatId) {
    const g = state.groups.find((x) => x.chatId === String(chatId));
    if (!g) throw Object.assign(new Error('Grup tidak ditemukan'), { code: 404 });
    if (!g.platforms?.length) throw Object.assign(new Error('Pilih platform untuk grup ini dulu'), { code: 400 });
    return g;
  }

  return async function handleAgent(req, res, url) {
    const route = url.pathname.replace(/^\/api\/agent\/?/, '');
    try {
      // dipanggil Vercel Cron (GET, tanpa password dashboard tapi wajib CRON_SECRET)
      if (route === 'cron') {
        if (!cronAuthorized(req)) return sendJson(res, 401, { status: false, message: 'unauthorized' });
        const now = wibNow();
        const slot = Math.floor(now.getUTCHours() / 3) * 3;
        const key = `${ymd(now)}-${slot}`;
        const state = await loadState(root);
        if (!state.schedule.enabled) return sendJson(res, 200, { status: true, skipped: 'jadwal nonaktif' });
        if (!state.schedule.slots.includes(slot)) return sendJson(res, 200, { status: true, skipped: `slot ${slot}.00 tidak aktif` });
        if (state.lastSlot === key && url.searchParams.get('force') !== '1') return sendJson(res, 200, { status: true, skipped: 'slot ini sudah terkirim' });
        state.lastSlot = key;
        await saveState(root, state); // kunci dulu supaya tidak terkirim dobel
        const results = await runGroups(deps, state, activeGroups(state), `jadwal ${String(slot).padStart(2, '0')}.00`);
        await saveState(root, state);
        return sendJson(res, 200, { status: true, slot, results });
      }

      if (req.method === 'GET' && route === 'state') {
        const [state, st] = await Promise.all([loadState(root), status()]);
        return sendJson(res, 200, { status: true, state, info: st, platforms: deps.PLATFORMS });
      }

      if (req.method !== 'POST') return sendJson(res, 405, { status: false, message: 'Method tidak diizinkan' });
      // header khusus: mencegah form lintas situs memakai password yang tersimpan di browser (CSRF)
      if (req.headers['x-dashsan'] !== '1') return sendJson(res, 403, { status: false, message: 'Header X-Dashsan wajib' });
      const body = await readJson(req);
      const state = await loadState(root);

      if (route === 'settings') {
        const valid = new Set(['all', ...deps.PLATFORMS.map((p) => p.slug)]);
        for (const upd of Array.isArray(body.groups) ? body.groups : []) {
          const g = state.groups.find((x) => x.chatId === String(upd.chatId));
          if (!g) continue;
          if (Array.isArray(upd.platforms)) g.platforms = upd.platforms.filter((p) => valid.has(p));
          if (typeof upd.enabled === 'boolean') g.enabled = upd.enabled;
          if (upd.delete === true) state.groups = state.groups.filter((x) => x !== g);
        }
        if (body.schedule) {
          if (typeof body.schedule.enabled === 'boolean') state.schedule.enabled = body.schedule.enabled;
          if (Array.isArray(body.schedule.slots)) state.schedule.slots = body.schedule.slots.map(Number).filter((s) => SLOTS.includes(s));
        }
        if (typeof body.instructions === 'string') state.instructions = body.instructions.slice(0, 2000);
        await saveState(root, state);
        return sendJson(res, 200, { status: true, state });
      }

      if (route === 'detect') {
        const r = await detectGroups(state);
        await saveState(root, state);
        return sendJson(res, 200, { status: true, ...r, state });
      }

      if (route === 'preview') {
        const g = findGroup(state, body.chatId);
        const facts = await buildFacts(deps, g.platforms);
        const { text, writer } = await writeMessage(g, facts, state.instructions);
        return sendJson(res, 200, { status: true, text, writer, facts });
      }

      if (route === 'send') {
        const g = findGroup(state, body.chatId);
        const text = String(body.text || '').trim();
        if (!text) throw Object.assign(new Error('Pesan kosong'), { code: 400 });
        try {
          await sendTelegram(g.chatId, text);
          pushHistory(state, { chatId: g.chatId, title: g.title, trigger: 'manual', ok: true, preview: text.slice(0, 600) });
        } catch (err) {
          pushHistory(state, { chatId: g.chatId, title: g.title, trigger: 'manual', ok: false, error: err.message });
          await saveState(root, state);
          throw err;
        }
        await saveState(root, state);
        return sendJson(res, 200, { status: true, state });
      }

      if (route === 'run-now') {
        const groups = activeGroups(state);
        if (!groups.length) throw Object.assign(new Error('Belum ada grup aktif yang punya platform'), { code: 400 });
        const results = await runGroups(deps, state, groups, 'manual (semua grup)');
        await saveState(root, state);
        return sendJson(res, 200, { status: true, results, state });
      }

      return sendJson(res, 404, { status: false, message: 'Not found' });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) err = Object.assign(new Error('ANTHROPIC_API_KEY tidak valid'), { code: 502 });
      else if (err instanceof Anthropic.RateLimitError) err = Object.assign(new Error('Claude sedang membatasi permintaan (rate limit), coba lagi sebentar'), { code: 503 });
      else if (err instanceof Anthropic.APIError) err = Object.assign(new Error(`Claude API error ${err.status}: ${err.message}`), { code: 502 });
      console.error('[agent]', err.message);
      return sendJson(res, err.code && err.code >= 400 && err.code < 600 ? err.code : 500, { status: false, message: err.message });
    }
  };
}
