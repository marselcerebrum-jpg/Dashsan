// Akun Telegram khusus (bukan bot) yang terhubung lewat scan QR.
// Dipakai untuk: membuat grup per platform + folder bersama ("komunitas"), dan mengirim pesan ke grup itu.
// Sesi login & API hash disimpan TERENKRIPSI (AES-256-GCM, kunci di env TG_SESSION_KEY).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bigInt from 'big-integer';
import QRCode from 'qrcode';
import { TelegramClient, Api } from 'telegram';
export { Api };
import { StringSession } from 'telegram/sessions/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpError = (msg, code = 400) => Object.assign(new Error(msg), { code });

// ---------- enkripsi ----------
function encryptionKey(root) {
  if (process.env.TG_SESSION_KEY) return Buffer.from(process.env.TG_SESSION_KEY, 'base64');
  if (process.env.VERCEL) throw httpError('TG_SESSION_KEY belum diatur di Vercel', 500);
  // lokal: kunci acak disimpan di .data/ (ikut .gitignore)
  const f = path.join(root, '.data', 'local-key');
  if (!fs.existsSync(f)) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, crypto.randomBytes(32).toString('base64'));
  }
  return Buffer.from(fs.readFileSync(f, 'utf8'), 'base64');
}
export function encrypt(root, text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encryptionKey(root), iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}
function decrypt(root, blob) {
  const [iv, tag, data] = String(blob).split('.').map((x) => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', encryptionKey(root), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

// ---------- kredensial & klien ----------
export function apiCredentials(root, acc = {}) {
  const apiId = Number(process.env.TELEGRAM_API_ID || acc.apiId || 0);
  const apiHash = process.env.TELEGRAM_API_HASH || (acc.apiHashEnc ? decrypt(root, acc.apiHashEnc) : '');
  return apiId && apiHash ? { apiId, apiHash } : null;
}

function newClient(creds, session = '') {
  const client = new TelegramClient(new StringSession(session), creds.apiId, creds.apiHash, {
    connectionRetries: 3,
    useWSS: false,
    deviceModel: 'Dashsan',
    appVersion: '1.0',
    systemVersion: 'Dashsan Agent Tele',
  });
  client.setLogLevel('error');
  return client;
}

async function closeClient(client) {
  try { await client.destroy(); } catch { /* sudah tertutup */ }
}

// Jalankan fn dengan klien yang sudah login; sesi yang berubah disimpan kembali
export async function withAccount(root, state, fn) {
  const acc = state.tgAccount;
  if (!acc?.sessionEnc) throw httpError('Akun Telegram belum terhubung. Scan QR dulu di menu Agent Tele.');
  const creds = apiCredentials(root, acc);
  if (!creds) throw httpError('API ID / API Hash Telegram belum diisi');
  const client = newClient(creds, decrypt(root, acc.sessionEnc));
  try {
    await client.connect();
    if (!(await client.checkAuthorization())) {
      acc.sessionEnc = null;
      acc.revokedAt = new Date().toISOString();
      throw httpError('Sesi Telegram sudah tidak berlaku (mungkin dicabut dari Devices). Scan QR lagi.', 401);
    }
    const out = await fn(client);
    const saved = client.session.save();
    if (saved) acc.sessionEnc = encrypt(root, saved);
    return out;
  } finally {
    await closeClient(client);
  }
}

// Telegram membatasi aksi beruntun (FLOOD_WAIT). Jeda pendek ditunggu, jeda panjang dihentikan.
async function retryFlood(fn, maxWaitSec = 45) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const s = err.seconds ?? Number(String(err.errorMessage || '').match(/FLOOD_WAIT_(\d+)/)?.[1]);
      if (!s || i >= 2) throw err;
      if (s > maxWaitSec) throw httpError(`Telegram meminta jeda ${Math.ceil(s / 60)} menit sebelum aksi berikutnya. Coba lanjutkan lagi nanti — grup yang sudah dibuat tidak akan dibuat ulang.`, 429);
      await sleep((s + 1) * 1000);
    }
  }
}

const userInfo = (u) => ({
  id: String(u.id),
  name: [u.firstName, u.lastName].filter(Boolean).join(' '),
  username: u.username || null,
  phone: u.phone ? `+${String(u.phone).slice(0, 4)}•••${String(u.phone).slice(-3)}` : null,
});

// ---------- login QR (dikirim bertahap ke browser sebagai Server-Sent Events) ----------
export async function qrLogin(root, state, { password = '', emit }) {
  const creds = apiCredentials(root, state.tgAccount);
  if (!creds) throw httpError('Isi API ID & API Hash dulu (dari my.telegram.org)');
  const client = newClient(creds);
  let stopped = false;
  const timeout = setTimeout(() => { stopped = true; closeClient(client); }, 150000);
  try {
    await client.connect();
    const user = await client.signInUserWithQrCode(creds, {
      qrCode: async ({ token, expires }) => {
        const url = `tg://login?token=${Buffer.from(token).toString('base64url')}`;
        const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 240, errorCorrectionLevel: 'M' });
        emit({ type: 'qr', svg, expires });
      },
      password: async (hint) => {
        if (password) return password;
        throw httpError(`Akun ini memakai verifikasi 2 langkah${hint ? ` (petunjuk: ${hint})` : ''}. Isi password Telegram-nya lalu scan ulang.`);
      },
      onError: async () => true, // hentikan pada error pertama
    });
    const session = client.session.save();
    state.tgAccount = {
      ...(state.tgAccount || {}),
      sessionEnc: encrypt(root, session),
      user: userInfo(user),
      connectedAt: new Date().toISOString(),
      revokedAt: null,
    };
    return state.tgAccount.user;
  } catch (err) {
    if (stopped) throw httpError('Waktu scan habis (±2 menit). Klik "Scan QR" lagi.', 408);
    if (/PASSWORD_HASH_INVALID/.test(err.errorMessage || err.message)) throw httpError('Password verifikasi 2 langkah salah.');
    if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/.test(err.errorMessage || err.message)) throw httpError('API ID / API Hash ditolak Telegram. Cek ulang di my.telegram.org → API development tools.');
    throw err;
  } finally {
    clearTimeout(timeout);
    await closeClient(client);
  }
}

export async function logout(root, state) {
  if (state.tgAccount?.sessionEnc) {
    try { await withAccount(root, state, (c) => c.invoke(new Api.auth.LogOut())); } catch { /* sesi mungkin sudah dicabut */ }
  }
  state.tgAccount = { ...(state.tgAccount || {}), sessionEnc: null, user: null, revokedAt: new Date().toISOString() };
}

// ---------- komunitas: grup per platform + folder bersama ----------
export const inputPeer = (g) => new Api.InputPeerChannel({ channelId: bigInt(g.channelId), accessHash: bigInt(g.accessHash) });

export async function createCommunity(root, state, { title, prefix, platforms, names, emit }) {
  return withAccount(root, state, async (client) => {
    state.community = { ...(state.community || {}), title };
    for (let i = 0; i < platforms.length; i++) {
      const slug = platforms[i];
      const exists = state.groups.find((g) => g.via === 'account' && g.communityPlatform === slug && !g.removed);
      if (exists) {
        emit({ type: 'progress', slug, status: 'sudah ada', title: exists.title });
        continue;
      }
      const groupTitle = `${prefix} ${names[slug] || slug}`.trim().slice(0, 128);
      emit({ type: 'progress', slug, status: 'membuat…', title: groupTitle });
      const res = await retryFlood(() => client.invoke(new Api.channels.CreateChannel({
        megagroup: true,
        title: groupTitle,
        about: `Grup CS ${names[slug] || slug} — update & rekomendasi sales otomatis dari Dashsan.`,
      })));
      const ch = res.chats.find((c) => c instanceof Api.Channel);
      if (!ch) throw httpError('Telegram tidak mengembalikan grup baru', 502);
      const g = {
        chatId: `-100${ch.id.toString()}`,
        channelId: ch.id.toString(),
        accessHash: ch.accessHash.toString(),
        title: groupTitle,
        type: 'supergroup',
        via: 'account',
        communityPlatform: slug,
        platforms: [slug],
        enabled: true,
        removed: false,
        addedAt: new Date().toISOString(),
      };
      try {
        const inv = await retryFlood(() => client.invoke(new Api.messages.ExportChatInvite({ peer: inputPeer(g), title: 'Undangan Dashsan' })));
        g.inviteLink = inv.link;
      } catch (err) {
        g.inviteLink = null;
        emit({ type: 'progress', slug, status: `dibuat, tapi link undangan gagal: ${err.errorMessage || err.message}`, title: groupTitle });
      }
      state.groups.push(g);
      await emit({ type: 'progress', slug, status: 'selesai', title: groupTitle, inviteLink: g.inviteLink, save: true });
      if (i < platforms.length - 1) await sleep(8000); // jeda antar pembuatan grup supaya tidak dianggap spam
    }

    // folder bersama: satu link untuk bergabung ke semua grup sekaligus
    const groups = state.groups.filter((g) => g.via === 'account' && g.communityPlatform && !g.removed);
    if (!groups.length) return state.community;
    emit({ type: 'progress', slug: 'folder', status: 'membuat folder bersama…', title });
    const existing = await client.invoke(new Api.messages.GetDialogFilters());
    const used = new Set((existing.filters || existing).map((f) => f.id).filter(Boolean));
    let filterId = state.community.filterId;
    if (!filterId || !used.has(filterId)) {
      filterId = 2;
      while (used.has(filterId) && filterId < 255) filterId++;
    }
    const peers = groups.map(inputPeer);
    await retryFlood(() => client.invoke(new Api.messages.UpdateDialogFilter({
      id: filterId,
      filter: new Api.DialogFilter({
        id: filterId,
        title: new Api.TextWithEntities({ text: title.slice(0, 12), entities: [] }),
        emoticon: '📊',
        pinnedPeers: [],
        includePeers: peers,
        excludePeers: [],
      }),
    })));
    let inviteUrl = state.community.inviteUrl || null;
    try {
      const inv = await retryFlood(() => client.invoke(new Api.chatlists.ExportChatlistInvite({
        chatlist: new Api.InputChatlistDialogFilter({ filterId }),
        title,
        peers,
      })));
      inviteUrl = inv.invite?.url || inviteUrl;
    } catch (err) {
      emit({ type: 'progress', slug: 'folder', status: `folder dibuat, tapi link folder gagal: ${err.errorMessage || err.message}`, title });
    }
    state.community = { title, filterId, inviteUrl, updatedAt: new Date().toISOString(), groupCount: groups.length };
    return state.community;
  });
}

// ---------- kirim pesan lewat akun ----------
export async function sendViaAccount(root, state, items) {
  // items: [{ group, html }] → dikirim berurutan dengan satu koneksi
  return withAccount(root, state, async (client) => {
    const results = [];
    for (const { group, html } of items) {
      try {
        await retryFlood(() => client.sendMessage(inputPeer(group), { message: html, parseMode: 'html', linkPreview: false }));
        results.push({ group, ok: true });
      } catch (err) {
        results.push({ group, ok: false, error: err.errorMessage || err.message });
      }
      await sleep(1500);
    }
    return results;
  });
}
