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
import * as account from './tg-account.js';

const TELEGRAM_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || '';
const CLAUDE_MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const STATE_PATH = 'agent/state.json';
const SLOTS = [0, 3, 6, 9, 12, 15, 18, 21]; // jam WIB
const HISTORY_MAX = 150;

const DEFAULT_STATE = {
  // { chatId, title, type, platforms: [slug | 'all'], enabled, addedAt, removed,
  //   via: 'bot' | 'account', channelId, accessHash, inviteLink, communityPlatform }
  groups: [],
  tgAccount: null, // { apiId, apiHashEnc, sessionEnc, user, connectedAt } — rahasia terenkripsi
  community: null, // { title, filterId, inviteUrl, groupCount }
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

// Siapkan grup bot untuk satu platform: tandai platform, aktifkan, lalu (bila bot admin) beri deskripsi,
// link undangan, dan — untuk grup dari tombol platform — nama standar "<awalan> <Platform>".
async function prepareBotGroup(g, slug, { names, prefix = 'CS', rename = false, isAdmin } = {}) {
  g.platforms = [slug];
  g.communityPlatform = slug;
  g.via = 'bot';
  g.enabled = true;
  const notes = [];
  let admin = isAdmin;
  if (admin === undefined) {
    try { admin = (await tg('getChatMember', { chat_id: g.chatId, user_id: Number(TELEGRAM_TOKEN().split(':')[0]) })).status === 'administrator'; } catch { admin = false; }
  }
  if (admin) {
    const title = `${prefix} ${names[slug]}`.trim();
    if (rename && g.title !== title) {
      try { await tg('setChatTitle', { chat_id: g.chatId, title }); g.title = title; } catch (err) { notes.push(`nama: ${err.message}`); }
    }
    try { await tg('setChatDescription', { chat_id: g.chatId, description: `Grup CS ${names[slug]} — update & rekomendasi sales otomatis dari Dashsan.` }); } catch { /* deskripsi sama/tidak diizinkan */ }
    if (!g.inviteLink) {
      try { g.inviteLink = (await tg('createChatInviteLink', { chat_id: g.chatId, name: 'Dashsan' })).invite_link; } catch (err) { notes.push(`link: ${err.message}`); }
    }
  } else {
    notes.push('bot belum admin — nama grup & link undangan tidak bisa diatur otomatis');
  }
  g.setupNote = notes.join('; ') || null;
}

// Grup terdeteksi dari update Telegram (bot dimasukkan/dikeluarkan dari grup, pesan di grup).
// getUpdates hanya menyimpan update ±24 jam terakhir.
// Link "tambahkan ke grup" dari Dashsan (t.me/<bot>?startgroup=<slug>) membuat Telegram mengirim
// "/start@<bot> <slug>" ke grup → platform grup itu langsung diketahui dan grup disiapkan otomatis.
async function detectGroups(state, { names = {}, prefix = 'CS' } = {}) {
  const updates = await tg('getUpdates', { allowed_updates: ['my_chat_member', 'message'], limit: 100 });
  const found = new Map();
  const claims = new Map(); // chatId → slug
  const migrations = [];
  for (const u of updates) {
    const msg = u.message;
    if (msg?.migrate_to_chat_id) migrations.push([String(msg.chat.id), String(msg.migrate_to_chat_id)]);
    const chat = u.my_chat_member?.chat || msg?.chat;
    if (!chat || !['group', 'supergroup'].includes(chat.type)) continue;
    const id = String(chat.id);
    const status = u.my_chat_member?.new_chat_member?.status;
    const prev = found.get(id) || {};
    found.set(id, {
      chatId: id,
      title: chat.title || id,
      type: chat.type,
      removed: status ? ['left', 'kicked'].includes(status) : prev.removed,
      isAdmin: status ? status === 'administrator' : prev.isAdmin,
    });
    const m = String(msg?.text || '').match(/^\/start(?:@\w+)?\s+([a-z0-9_-]+)/i);
    if (m && names[m[1]]) claims.set(id, m[1]);
  }

  // grup biasa yang di-upgrade jadi supergroup berganti ID
  for (const [from, to] of migrations) {
    if (found.has(from)) {
      found.set(to, { ...found.get(from), ...(found.get(to) || {}), chatId: to, type: 'supergroup' });
      found.delete(from);
    }
    const g = state.groups.find((x) => x.chatId === from);
    if (g && !state.groups.some((x) => x.chatId === to)) { g.chatId = to; g.type = 'supergroup'; }
    if (claims.has(from)) { claims.set(to, claims.get(from)); claims.delete(from); }
  }

  let added = 0;
  for (const g of found.values()) {
    const cur = state.groups.find((x) => x.chatId === g.chatId);
    if (cur) {
      cur.title = g.title;
      if (g.removed !== undefined) cur.removed = g.removed;
    } else if (!g.removed) {
      state.groups.push({ chatId: g.chatId, title: g.title, type: g.type, via: 'bot', platforms: [], enabled: false, removed: false, addedAt: new Date().toISOString() });
      added++;
    }
  }

  // grup dari link platform: atur platform, aktifkan, rapikan nama & buat link undangan (kalau bot admin)
  const prepared = [];
  for (const [chatId, slug] of claims) {
    const g = state.groups.find((x) => x.chatId === chatId);
    if (!g || g.removed) continue;
    await prepareBotGroup(g, slug, { names, prefix, rename: true, isAdmin: found.get(chatId)?.isAdmin });
    prepared.push({ title: g.title, platform: names[slug], note: g.setupNote });
  }

  // tandai update sudah dibaca supaya tidak menumpuk
  if (updates.length) await tg('getUpdates', { offset: updates[updates.length - 1].update_id + 1, limit: 1 });
  return { added, seen: found.size, prepared };
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
      rata2_7_hari_jam_sama: (() => { const s = summarize(last7.filter(upToNow)); return { checkout: Math.round(s.checkout / 7), sukses: Math.round(s.sukses / 7), omzet: Math.round(s.omzet / 7) }; })(),
      jam_ramai_7_hari: (() => {
        const c = new Map();
        for (const t of last7) if (Number(t.status) === 1) { const h = Number(closingTime(t).slice(0, 2)); c.set(h, (c.get(h) || 0) + 1); }
        return [...c].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => h).sort((a, b) => a - b);
      })(),
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
- Bahasa Indonesia yang santai tapi profesional, langsung ke inti. Maksimal ±120 kata.
- Dibaca di HP (aplikasi Telegram): tiap baris pendek (±40 karakter), TIDAK ada paragraf panjang. Pecah detail ke baris berikutnya yang diawali 3 spasi. Beri satu baris kosong antar bagian. Singkat nama produk yang panjang (mis. "Program Super Intensif SKD CPNS 2026 - Masa Aktif 1 Tahun" → "Paket 1 Tahun").
- Pakai HANYA angka dari data JSON yang diberikan. Jangan mengarang angka, nama, atau penyebab yang tidak didukung data; bila menduga penyebab, sebut sebagai dugaan.
- Struktur (ikuti urutan ini, boleh lewati bagian yang datanya kosong):
  1. Judul: "📊 Update Sales <platform> — <hari, tanggal> • <jam> WIB".
  2. Sebelum jam 09.00: satu baris rekap kemarin penuh (omzet, trx sukses).
  3. "Hari ini s/d <jam>": omzet (▲/▼ % vs kemarin jam sama dan vs minggu lalu hari sama), trx sukses dari checkout + conversion, pace vs rata-rata 7 hari di jam yang sama, jumlah gagal/expired/pending.
  4. "Prioritas CS sekarang" (bernomor, 2-4 butir, paling penting dulu): follow-up calon pembeli belum bayar (sebut jumlah, berapa masih pending, potensi omzet, arahkan ke Daftar Follow-up Dashsan); metode bayar dengan banyak gagal hari ini → arahkan ke metode yang lancar; siaga di jam ramai berikutnya; dorong produk/promo yang sedang laku.
  5. "Yang laku hari ini": produk teratas & promo terpopuler.
  Untuk grup beberapa platform: ringkasan total, lalu satu baris per platform (urut omzet) dengan ▲/▼ vs kemarin, dan sorot platform yang turun paling dalam.
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

// Tanpa ANTHROPIC_API_KEY: pesan dari template. Struktur yang sama dipakai sebagai pedoman untuk Claude.
const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const fmtPct = (x) => `${Math.abs(x).toLocaleString('id-ID', { maximumFractionDigits: Math.abs(x) >= 10 ? 0 : 1 })}%`;
function change(cur, old) {
  if (!old) return cur ? 'baru' : null;
  const ch = ((cur - old) / old) * 100;
  return `${ch >= 0 ? '▲' : '▼'}${fmtPct(ch)}`;
}
const esc = (x) => String(x ?? ''); // escape HTML dilakukan sekali saat kirim (telegramHtml)
const jam = (h) => `${String(h).padStart(2, '0')}.00`;
// "Program Super Intensif SKD CPNS 2026 - Masa Aktif 1 Tahun (Khusus Perpanjang)" → "Paket 1 Tahun (Perpanjang)"
function shortProduct(name) {
  let n = String(name || '');
  if (n.includes(' - ')) n = n.slice(n.lastIndexOf(' - ') + 3);
  // HURUF BESAR SEMUA → Judul (singkatan seperti SKD, CPNS, TNI tetap kapital)
  if (n === n.toUpperCase()) n = n.toLowerCase().replace(/\p{L}+/gu, (w) => (/^(skd|skb|cpns|pppk|bumn|tni|tka|tpa|ojk|utbk|snbt|toefl|asn|polri)$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
  n = n.replace(/^(Program|Paket|Bimbel)\s+/i, '').replace(/^Masa Aktif\s*/i, 'Paket ').replace(/\(Khusus Perpanjang\)/i, '(Perpanjang)').trim();
  return n.length > 30 ? `${n.slice(0, 29).trim()}…` : n;
}

const SUB = '\n    ';
function priorities(p, nowHour) {
  const out = [];
  const l = p.calon_pembeli_belum_bayar_hari_ini;
  if (l.jumlah_orang) out.push(`Follow-up <b>${l.jumlah_orang} calon pembeli</b>${SUB}${[l.masih_pending && `${l.masih_pending} masih pending 🔥`, `potensi ${rupiah(l.potensi_omzet)}`].filter(Boolean).join(' • ')}${SUB}→ Dashsan › Daftar Follow-up`);
  const good = p.metode_bayar_hari_ini.filter((m) => m.checkout >= 3).sort((a, b) => b.conversion_pct - a.conversion_pct)[0];
  const bad = p.metode_bayar_hari_ini.filter((m) => m.checkout >= 3 && m.conversion_pct < 50).sort((a, b) => a.conversion_pct - b.conversion_pct)[0];
  if (bad && good && good.nama !== bad.nama) out.push(`<b>${esc(bad.nama)}</b> sering gagal (${bad.sukses}/${bad.checkout} sukses)${SUB}→ arahkan ke ${esc(good.nama)} (${fmtPct(good.conversion_pct)} sukses)`);
  const next = p.jam_ramai_7_hari.filter((h) => h > nowHour);
  if (next.length) out.push(`Siaga jam ramai: <b>${next.map(jam).join(', ')}</b>${SUB}balas chat customer secepatnya`);
  const top = p.produk_teratas_hari_ini[0];
  const promo = p.promo_teratas_hari_ini.find((x) => x.sukses);
  if (top?.sukses) out.push(`Dorong <b>${esc(shortProduct(top.nama))}</b>${promo ? `${SUB}+ promo ${esc(promo.nama)}` : ''}`);
  return out.slice(0, 4);
}

function platformBlock(p, nowHour, cutoff) {
  const h = p.hari_ini;
  const cmp = [change(h.omzet, p.kemarin_jam_sama.omzet) && `${change(h.omzet, p.kemarin_jam_sama.omzet)} vs kemarin`, change(h.omzet, p.minggu_lalu_hari_sama_jam_sama.omzet) && `${change(h.omzet, p.minggu_lalu_hari_sama_jam_sama.omzet)} vs mg lalu`].filter(Boolean);
  const pace = p.rata2_7_hari_jam_sama.omzet ? Math.round((h.omzet / p.rata2_7_hari_jam_sama.omzet) * 100) : null;
  const lines = [];
  if (nowHour < 9) lines.push('🗓 <b>Rekap kemarin</b>', `${rupiah(p.kemarin_full.omzet)} • ${p.kemarin_full.sukses} trx sukses`, '');
  lines.push(`<b>Hari ini s/d ${cutoff}</b>`);
  lines.push(`💰 <b>${rupiah(h.omzet)}</b>`);
  if (cmp.length) lines.push(`    ${cmp.join(' • ')}`);
  lines.push(`✅ ${h.sukses} sukses / ${h.checkout} checkout${h.conversion_pct != null ? ` (${fmtPct(h.conversion_pct)})` : ''}`);
  if (pace != null) lines.push(`🎯 Pace ${pace}% dari rata-rata${pace >= 100 ? ' 🔥' : ''}`);
  if (h.gagal || h.expired || h.pending) lines.push(`⚠️ ${h.gagal} gagal • ${h.expired} expired • ${h.pending} pending`);
  const pr = priorities(p, nowHour);
  if (pr.length) lines.push('', '<b>Prioritas CS sekarang</b>', ...pr.map((x, i) => `${i + 1}. ${x}`));
  const laku = p.produk_teratas_hari_ini.filter((x) => x.sukses).slice(0, 3).map((x) => `🏆 ${esc(shortProduct(x.nama))}${SUB}${x.sukses} trx • ${rupiah(x.omzet)}`);
  if (laku.length) lines.push('', '<b>Paling laku hari ini</b>', ...laku);
  return lines;
}

function templateMessage(group, facts) {
  const now = new Date(Date.parse(facts.waktu.replace(' ', 'T').replace(' WIB', ':00Z')));
  const cutoff = facts.waktu.slice(11, 16).replace(':', '.');
  const nowHour = Number(facts.waktu.slice(11, 13));
  const tanggal = `${HARI[now.getUTCDay()]}, ${now.getUTCDate()} ${BULAN[now.getUTCMonth()]}`;
  const ps = facts.per_platform;
  if (ps.length === 1) {
    return [`📊 <b>Update Sales ${esc(ps[0].platform)}</b>`, `${tanggal} • ${cutoff} WIB`, '', ...platformBlock(ps[0], nowHour, cutoff)].join('\n');
  }
  // banyak platform: ringkasan total + satu baris per platform
  const t = facts.total.hari_ini;
  const lines = ['📊 <b>Update Sales Semua Platform</b>', `${tanggal} • ${cutoff} WIB`, ''];
  lines.push(`<b>Total s/d ${cutoff}</b>`);
  lines.push(`💰 <b>${rupiah(t.omzet)}</b>${change(t.omzet, facts.total.kemarin_jam_sama.omzet) ? ` (${change(t.omzet, facts.total.kemarin_jam_sama.omzet)} vs kemarin)` : ''}`);
  lines.push(`✅ ${t.sukses} sukses • conv ${fmtPct(t.conversion_pct ?? 0)}`, '');
  lines.push('<b>Per platform</b>');
  const sorted = [...ps].sort((a, b) => b.hari_ini.omzet - a.hari_ini.omzet);
  const idle = sorted.filter((p) => !p.hari_ini.omzet);
  for (const p of sorted.filter((x) => x.hari_ini.omzet)) lines.push(`• <b>${esc(p.platform)}</b> ${rupiah(p.hari_ini.omzet)}${change(p.hari_ini.omzet, p.kemarin_jam_sama.omzet) ? ` ${change(p.hari_ini.omzet, p.kemarin_jam_sama.omzet)}` : ''}`);
  if (idle.length) {
    const names = idle.map((p) => esc(p.platform));
    const rows = [];
    for (let i = 0; i < names.length; i += 3) rows.push(names.slice(i, i + 3).join(', '));
    lines.push(`• Belum ada penjualan:${SUB}${rows.join(SUB)}`);
  }
  const drops = nowHour < 10 ? [] : ps.filter((p) => p.kemarin_jam_sama.omzet >= 500000).map((p) => ({ p, ch: (p.hari_ini.omzet - p.kemarin_jam_sama.omzet) / p.kemarin_jam_sama.omzet })).sort((a, b) => a.ch - b.ch);
  const leads = ps.reduce((a, p) => a + p.calon_pembeli_belum_bayar_hari_ini.jumlah_orang, 0);
  const pot = ps.reduce((a, p) => a + p.calon_pembeli_belum_bayar_hari_ini.potensi_omzet, 0);
  const pr = [];
  if (drops[0] && drops[0].ch < -0.2) pr.push(`Cek <b>${esc(drops[0].p.platform)}</b>${SUB}turun ${fmtPct(drops[0].ch * 100)} vs kemarin jam sama`);
  if (leads) pr.push(`Follow-up <b>${leads} calon pembeli</b>${SUB}potensi ${rupiah(pot)}${SUB}→ Dashsan › Daftar Follow-up`);
  if (pr.length) lines.push('', '<b>Prioritas</b>', ...pr.map((x, i) => `${i + 1}. ${x}`));
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

// ---------- pengiriman (akun Telegram atau bot) ----------
async function deliver(root, state, items) {
  // items: [{ group, text }] → [{ group, ok, error }]
  const viaAccount = items.filter((x) => x.group.via === 'account');
  const viaBot = items.filter((x) => x.group.via !== 'account');
  const out = [];
  if (viaAccount.length) {
    try {
      out.push(...(await account.sendViaAccount(root, state, viaAccount.map((x) => ({ group: x.group, html: telegramHtml(x.text) })))));
    } catch (err) {
      out.push(...viaAccount.map((x) => ({ group: x.group, ok: false, error: err.message })));
    }
  }
  for (const x of viaBot) {
    try {
      await sendTelegram(x.group.chatId, x.text);
      out.push({ group: x.group, ok: true });
    } catch (err) {
      out.push({ group: x.group, ok: false, error: err.message });
    }
  }
  return out;
}

// ---------- menjalankan ----------
function pushHistory(state, entry) {
  state.history.unshift({ at: new Date().toISOString(), ...entry });
  state.history = state.history.slice(0, HISTORY_MAX);
}

async function runGroups(deps, state, groups, trigger) {
  // 1) tulis pesan (maks 3 paralel), 2) kirim semuanya
  const written = [];
  const failed = [];
  for (let i = 0; i < groups.length; i += 3) {
    const batch = await Promise.allSettled(groups.slice(i, i + 3).map(async (g) => {
      const facts = await buildFacts(deps, g.platforms);
      return { group: g, ...(await writeMessage(g, facts, state.instructions)) };
    }));
    batch.forEach((r, j) => (r.status === 'fulfilled' ? written.push(r.value) : failed.push({ group: groups[i + j], ok: false, error: r.reason?.message || String(r.reason) })));
  }
  const sent = await deliver(deps.root, state, written);
  const results = [...sent, ...failed].map((r) => {
    const w = written.find((x) => x.group === r.group);
    const entry = r.ok
      ? { chatId: r.group.chatId, title: r.group.title, trigger, ok: true, writer: w?.writer, preview: w.text.slice(0, 600) }
      : { chatId: r.group.chatId, title: r.group.title, trigger, ok: false, error: r.error };
    pushHistory(state, entry);
    return entry;
  });
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

// Password khusus menu Agent Tele (env AGENT_PASSWORD). Setelah benar, browser memegang token 12 jam.
const TOKEN_TTL = 12 * 3600 * 1000;
const sign = (exp) => crypto.createHmac('sha256', `agent|${process.env.AGENT_PASSWORD}`).update(String(exp)).digest('hex');
function agentAuthorized(req) {
  if (!process.env.AGENT_PASSWORD) return !process.env.VERCEL; // lokal tanpa password boleh
  const [exp, sig] = String(req.headers['x-agent-token'] || '').split('.');
  return Number(exp) > Date.now() && sig && safeEqual(sig, sign(exp));
}
let failedUnlocks = 0;

// Bagian state yang dikirim ke browser — tanpa sesi & API hash
function publicState(state) {
  const acc = state.tgAccount;
  return {
    ...state,
    tgAccount: acc ? { apiId: acc.apiId || null, hasApiHash: Boolean(acc.apiHashEnc), connected: Boolean(acc.sessionEnc), user: acc.user || null, connectedAt: acc.connectedAt || null, revokedAt: acc.revokedAt || null } : null,
    groups: state.groups.map(({ accessHash, ...g }) => g),
  };
}

// Server-Sent Events untuk proses panjang (login QR, membuat komunitas)
function sseStream(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  return {
    send: (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`),
    end: () => res.end(),
  };
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
      account: { apiFromEnv: Boolean(process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH), keyConfigured: Boolean(process.env.TG_SESSION_KEY) || !process.env.VERCEL },
      locked: Boolean(process.env.AGENT_PASSWORD),
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

      if (req.method === 'GET' && route === 'lock') {
        return sendJson(res, 200, { status: true, required: Boolean(process.env.AGENT_PASSWORD) || Boolean(process.env.VERCEL), configured: Boolean(process.env.AGENT_PASSWORD), unlocked: agentAuthorized(req) });
      }
      // header khusus: mencegah form lintas situs memakai password yang tersimpan di browser (CSRF)
      if (req.method === 'POST' && req.headers['x-dashsan'] !== '1') return sendJson(res, 403, { status: false, message: 'Header X-Dashsan wajib' });

      if (req.method === 'POST' && route === 'unlock') {
        if (!process.env.AGENT_PASSWORD) throw Object.assign(new Error('AGENT_PASSWORD belum diatur di server'), { code: 503 });
        const body = await readJson(req);
        if (!safeEqual(String(body.password || ''), process.env.AGENT_PASSWORD)) {
          failedUnlocks++;
          await new Promise((r) => setTimeout(r, Math.min(5000, 800 * failedUnlocks))); // perlambat tebak-tebakan
          return sendJson(res, 401, { status: false, message: 'Password Agent Tele salah' });
        }
        failedUnlocks = 0;
        const exp = Date.now() + TOKEN_TTL;
        return sendJson(res, 200, { status: true, token: `${exp}.${sign(exp)}`, exp });
      }
      if (!agentAuthorized(req)) return sendJson(res, 401, { status: false, locked: true, message: 'Menu Agent Tele terkunci. Masukkan password Agent Tele.' });

      if (req.method === 'GET' && route === 'state') {
        const [state, st] = await Promise.all([loadState(root), status()]);
        return sendJson(res, 200, { status: true, state: publicState(state), info: st, platforms: deps.PLATFORMS });
      }

      if (req.method !== 'POST') return sendJson(res, 405, { status: false, message: 'Method tidak diizinkan' });
      const body = await readJson(req);
      const state = await loadState(root);

      if (route === 'tg/creds') {
        if (body.clear === true) {
          if (state.tgAccount?.sessionEnc) throw Object.assign(new Error('Putuskan akun Telegram dulu sebelum menghapus API'), { code: 400 });
          state.tgAccount = { ...(state.tgAccount || {}), apiId: null, apiHashEnc: null };
          await saveState(root, state);
          return sendJson(res, 200, { status: true, state: publicState(state) });
        }
        const apiId = Number(body.apiId);
        const apiHash = String(body.apiHash || '').trim();
        if (!Number.isInteger(apiId) || apiId <= 0 || !/^[a-f0-9]{32}$/i.test(apiHash)) throw Object.assign(new Error('API ID harus angka dan API Hash 32 karakter (dari my.telegram.org)'), { code: 400 });
        state.tgAccount = { ...(state.tgAccount || {}), apiId, apiHashEnc: account.encrypt(root, apiHash) };
        await saveState(root, state);
        return sendJson(res, 200, { status: true, state: publicState(state) });
      }

      if (route === 'tg/login') {
        const stream = sseStream(res);
        try {
          const user = await account.qrLogin(root, state, { password: String(body.password || ''), emit: stream.send });
          await saveState(root, state);
          stream.send({ type: 'done', user });
        } catch (err) {
          stream.send({ type: 'error', message: err.errorMessage || err.message });
        }
        return stream.end();
      }

      if (route === 'tg/logout') {
        await account.logout(root, state);
        await saveState(root, state);
        return sendJson(res, 200, { status: true, state: publicState(state) });
      }

      if (route === 'community') {
        const valid = new Set(deps.PLATFORMS.map((p) => p.slug));
        const platforms = (Array.isArray(body.platforms) ? body.platforms : []).filter((x) => valid.has(x));
        const title = String(body.title || '').trim().slice(0, 64) || 'Dashsan CS';
        const prefix = String(body.prefix ?? 'CS').trim().slice(0, 40);
        if (!platforms.length) throw Object.assign(new Error('Pilih minimal satu platform'), { code: 400 });
        const names = Object.fromEntries(deps.PLATFORMS.map((p) => [p.slug, p.name]));
        const stream = sseStream(res);
        try {
          const community = await account.createCommunity(root, state, {
            title, prefix, platforms, names,
            emit: async (ev) => {
              if (ev.save) await saveState(root, state); // simpan tiap grup jadi supaya bisa dilanjutkan
              stream.send(ev);
            },
          });
          await saveState(root, state);
          stream.send({ type: 'done', community, state: publicState(state) });
        } catch (err) {
          await saveState(root, state).catch(() => {});
          stream.send({ type: 'error', message: err.errorMessage || err.message, state: publicState(state) });
        }
        return stream.end();
      }

      if (route === 'settings') {
        const valid = new Set(['all', ...deps.PLATFORMS.map((p) => p.slug)]);
        const toPrepare = [];
        for (const upd of Array.isArray(body.groups) ? body.groups : []) {
          const g = state.groups.find((x) => x.chatId === String(upd.chatId));
          if (!g) continue;
          if (Array.isArray(upd.platforms)) {
            g.platforms = upd.platforms.filter((p) => valid.has(p));
            const one = g.platforms.length === 1 && g.platforms[0] !== 'all' ? g.platforms[0] : null;
            if (g.via !== 'account' && TELEGRAM_TOKEN() && one && g.communityPlatform !== one && !g.removed) toPrepare.push([g, one]);
            if (!one && g.via !== 'account') g.communityPlatform = null;
          }
          if (typeof upd.enabled === 'boolean') g.enabled = upd.enabled;
          if (upd.delete === true) state.groups = state.groups.filter((x) => x !== g);
        }
        if (body.schedule) {
          if (typeof body.schedule.enabled === 'boolean') state.schedule.enabled = body.schedule.enabled;
          if (Array.isArray(body.schedule.slots)) state.schedule.slots = body.schedule.slots.map(Number).filter((s) => SLOTS.includes(s));
        }
        if (typeof body.instructions === 'string') state.instructions = body.instructions.slice(0, 2000);
        const names = Object.fromEntries(deps.PLATFORMS.map((p) => [p.slug, p.name]));
        for (const [g, slug] of toPrepare) {
          const wasEnabled = g.enabled;
          await prepareBotGroup(g, slug, { names, rename: false });
          g.enabled = wasEnabled; // pilihan Aktif dari form tetap dihormati
        }
        await saveState(root, state);
        return sendJson(res, 200, { status: true, state: publicState(state) });
      }

      if (route === 'detect') {
        const names = Object.fromEntries(deps.PLATFORMS.map((p) => [p.slug, p.name]));
        const r = await detectGroups(state, { names, prefix: String(body.prefix ?? 'CS').trim().slice(0, 40) });
        await saveState(root, state);
        return sendJson(res, 200, { status: true, ...r, state: publicState(state) });
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
        const [r] = await deliver(root, state, [{ group: g, text }]);
        if (r.ok) pushHistory(state, { chatId: g.chatId, title: g.title, trigger: 'manual', ok: true, preview: text.slice(0, 600) });
        else {
          pushHistory(state, { chatId: g.chatId, title: g.title, trigger: 'manual', ok: false, error: r.error });
          await saveState(root, state);
          throw Object.assign(new Error(r.error), { code: 502 });
        }
        await saveState(root, state);
        return sendJson(res, 200, { status: true, state: publicState(state) });
      }

      if (route === 'run-now') {
        const groups = activeGroups(state);
        if (!groups.length) throw Object.assign(new Error('Belum ada grup aktif yang punya platform'), { code: 400 });
        const results = await runGroups(deps, state, groups, 'manual (semua grup)');
        await saveState(root, state);
        return sendJson(res, 200, { status: true, results, state: publicState(state) });
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
