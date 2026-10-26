// Menu Agent Tele — pengaturan grup Telegram, jadwal, pratinjau & riwayat

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SLOTS = [0, 3, 6, 9, 12, 15, 18, 21];
const ag = {
  state: null, info: null, platforms: [], loaded: false, dirty: false,
  // template terpisah: 'platform' (grup per platform) dan 'all' (grup gabungan)
  tplKind: 'platform', drafts: {}, vars: { platform: [], all: [] }, defaults: { platform: '', all: '' },
  targets: {}, monthData: null,
};
const isAll = (g) => (g.platforms || []).includes('all');
const TPL_KEY = { platform: 'messageTemplate', all: 'messageTemplateAll' };

// token buka-kunci menu disimpan per tab (hilang saat tab ditutup)
const getToken = () => { try { return sessionStorage.getItem('dashsan.agentToken') || ''; } catch { return ''; } };
const setToken = (t) => { try { t ? sessionStorage.setItem('dashsan.agentToken', t) : sessionStorage.removeItem('dashsan.agentToken'); } catch { /* abaikan */ } };

function request(route, body) {
  const headers = { 'X-Agent-Token': getToken() };
  const opts = { headers };
  if (body !== undefined) {
    Object.assign(headers, { 'Content-Type': 'application/json', 'X-Dashsan': '1' });
    Object.assign(opts, { method: 'POST', body: JSON.stringify(body) });
  }
  return fetch(new URL(`/api/agent/${route}`, location.origin), opts);
}

async function api(route, body) {
  const res = await request(route, body);
  const data = await res.json().catch(() => ({}));
  if (data.locked) { showLock(); throw new Error(data.message); }
  if (!res.ok || !data.status) throw new Error(data.message || `Gagal (HTTP ${res.status})`);
  return data;
}

// proses panjang (scan QR, buat komunitas) dikirim server bertahap sebagai event
async function stream(route, body, onEvent) {
  const res = await request(route, body);
  if (!res.ok || !res.headers.get('content-type')?.includes('event-stream')) {
    const data = await res.json().catch(() => ({}));
    if (data.locked) showLock();
    throw new Error(data.message || `Gagal (HTTP ${res.status})`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let last = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).replace(/^data: /, '');
      buf = buf.slice(i + 2);
      if (!line.trim()) continue;
      last = JSON.parse(line);
      onEvent(last);
    }
  }
  if (last?.type === 'error') throw new Error(last.message);
  return last;
}

function showLock(msg = '') {
  $('agentView').classList.add('is-locked');
  $('agLock').hidden = false;
  $('agUnlockMsg').textContent = msg;
  ag.loaded = false;
  setTimeout(() => $('agUnlockPw').focus(), 0);
}
function hideLock() {
  $('agentView').classList.remove('is-locked');
  $('agLock').hidden = true;
}

function notice(msg, isError = false) {
  $('agError').hidden = true;
  $('agNotice').hidden = true;
  const el = isError ? $('agError') : $('agNotice');
  el.textContent = msg;
  el.hidden = !msg;
}

async function busy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await fn();
  } catch (err) {
    notice(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

const platformName = (slug) => (slug === 'all' ? 'Semua platform' : ag.platforms.find((p) => p.slug === slug)?.name || slug);
const fmtTime = (iso) => new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// ---------- render ----------
function renderStatus() {
  const { telegram, ai, storage, cron } = ag.info;
  const item = (label, ok, value) => `<div class="ag-item"><div class="label">${label}</div><div class="value ${ok ? 'up' : 'down'}">${ok ? '✓' : '✗'} ${value}</div></div>`;
  $('agStatus').innerHTML = [
    item('Bot Telegram', telegram.configured && !telegram.error, telegram.username ? `@${esc(telegram.username)}` : telegram.error ? esc(telegram.error) : 'TELEGRAM_BOT_TOKEN belum diatur'),
    item('Akun Telegram (opsional)', Boolean(ag.state.tgAccount?.connected), ag.state.tgAccount?.connected ? esc(ag.state.tgAccount.user?.name || 'terhubung') : 'Belum terhubung — scan QR di bawah'),
    item('Penulis pesan', true, ai.configured ? `Claude (${esc(ai.model)})` : 'Template otomatis (gratis)'),
    item('Penyimpanan pengaturan', storage === 'vercel-blob' || !location.hostname.endsWith('vercel.app'), storage === 'vercel-blob' ? 'Vercel Blob' : 'File lokal (khusus komputer ini)'),
    item('Jadwal otomatis', cron.configured && ag.state.schedule.enabled, !cron.configured ? 'CRON_SECRET belum diatur' : ag.state.schedule.enabled ? `Aktif: ${ag.state.schedule.slots.map((s) => `${String(s).padStart(2, '0')}.00`).join(', ')} WIB` : 'Nonaktif'),
  ].join('');
  $('agInstrCard').hidden = !ai.configured;
  // panduan bot dibuka selama bot sudah ada tapi belum punya grup
  $('agGuide').open = Boolean(telegram.username) && !ag.state.groups.some((g) => g.via !== 'account');
}

function platformPicker(g) {
  const sel = new Set(g.platforms || []);
  const summary = sel.size ? [...sel].map(platformName).join(', ') : 'Pilih platform…';
  const opt = (slug) => `<label><input type="checkbox" data-plat="${esc(slug)}" ${sel.has(slug) ? 'checked' : ''}/> ${esc(platformName(slug))}</label>`;
  return `<details class="ag-plat"><summary>${esc(summary)}</summary><div class="ag-plat-list">${opt('all')}<hr style="width:100%;border:0;border-top:1px solid var(--border);margin:2px 0" />${ag.platforms.map((p) => opt(p.slug)).join('')}</div></details>`;
}

function renderGroups() {
  const groups = ag.state.groups;
  const head = '<thead><tr><th>Grup</th><th>Dikirim lewat</th><th>Platform yang dikirim</th><th>Aktif</th><th></th></tr></thead>';
  const body = groups.length
    ? groups.map((g) => `<tr data-chat="${esc(g.chatId)}">
        <td><input class="ag-title" data-title value="${esc(g.title)}" maxlength="128" ${g.removed ? 'disabled' : ''} />${isAll(g) ? '<span class="ag-badge">ALL</span>' : ''}<br /><span class="muted">${esc(g.chatId)}${g.removed ? ' • <span class="down">bot sudah dikeluarkan</span>' : ''}</span></td>
        <td>${g.via === 'account' ? 'Akun Telegram' : 'Bot'}${g.inviteLink ? `<br /><a class="ag-link" href="${esc(g.inviteLink)}" target="_blank" rel="noopener">Link undangan</a>` : ''}</td>
        <td>${platformPicker(g)}</td>
        <td><input type="checkbox" data-enabled ${g.enabled ? 'checked' : ''} ${g.removed ? 'disabled' : ''} /></td>
        <td><button type="button" class="btn" data-delete>Hapus</button></td>
      </tr>`).join('')
    : '<tr><td class="empty" colspan="5">Belum ada grup. Masukkan bot ke grup CS, kirim satu pesan di grup itu, lalu klik "Deteksi grup baru" — atau hubungkan akun Telegram dan klik "Buat komunitas &amp; grup".</td></tr>';
  $('agGroups').innerHTML = head + `<tbody>${body}</tbody>`;

  const usable = groups.filter((g) => !g.removed && g.platforms?.length);
  const prev = $('agPreviewGroup').value;
  $('agPreviewGroup').innerHTML = usable.length
    ? usable.map((g) => `<option value="${esc(g.chatId)}">${esc(g.title)} — ${esc(g.platforms.map(platformName).join(', '))}</option>`).join('')
    : '<option value="">(belum ada grup dengan platform)</option>';
  if (usable.some((g) => g.chatId === prev)) $('agPreviewGroup').value = prev;
}

function renderSchedule() {
  $('agSchedOn').checked = ag.state.schedule.enabled;
  const on = new Set(ag.state.schedule.slots);
  $('agSlots').innerHTML = SLOTS.map((s) => `<label><input type="checkbox" data-slot="${s}" ${on.has(s) ? 'checked' : ''}/> ${String(s).padStart(2, '0')}.00</label>`).join('');
  $('agInstr').value = ag.state.instructions || '';
}

function renderHistory() {
  const rows = ag.state.history || [];
  $('agHistory').innerHTML = '<thead><tr><th>Waktu</th><th>Grup</th><th>Pemicu</th><th>Status</th><th>Isi / error</th></tr></thead><tbody>' +
    (rows.length
      ? rows.map((h) => `<tr><td>${esc(fmtTime(h.at))}</td><td>${esc(h.title)}</td><td>${esc(h.trigger)}</td>
          <td>${h.ok ? '<span class="pill s1">Terkirim</span>' : '<span class="pill s4">Gagal</span>'}</td>
          <td class="ag-preview">${esc(h.ok ? h.preview : h.error)}</td></tr>`).join('')
      : '<tr><td class="empty" colspan="5">Belum ada pesan terkirim.</td></tr>') + '</tbody>';
}

function renderAccount() {
  const acc = ag.state.tgAccount || {};
  const fromEnv = ag.info.account?.apiFromEnv;
  $('agAccConnected').hidden = !acc.connected;
  $('agAccSetup').hidden = Boolean(acc.connected);
  $('agAccState').innerHTML = acc.connected ? '<span class="up">✓ Terhubung</span>' : acc.revokedAt ? '<span class="down">Terputus</span>' : 'Belum terhubung';
  if (acc.user) {
    $('agAccName').textContent = acc.user.name || acc.user.id;
    $('agAccMeta').textContent = [acc.user.username && `@${acc.user.username}`, acc.user.phone, acc.connectedAt && `sejak ${fmtTime(acc.connectedAt)}`].filter(Boolean).join(' • ');
  }
  $('agCredsRow').hidden = fromEnv;
  if (!$('agApiId').value && acc.apiId) $('agApiId').value = acc.apiId;
  $('agCredsState').textContent = fromEnv ? '' : acc.hasApiHash ? '✓ API tersimpan (terenkripsi)' : '';
  $('agScan').disabled = !(fromEnv || acc.hasApiHash);
}

// link "tambahkan bot ke grup" per platform; admin diminta supaya bot bisa memberi nama & membuat link undangan
const startGroupUrl = (slug) => `https://t.me/${ag.info.telegram.username}?startgroup=${encodeURIComponent(slug)}&admin=change_info+invite_users+pin_messages`;

function renderBotCommunity() {
  const bot = ag.info.telegram.username;
  const accountOn = Boolean(ag.state.tgAccount?.connected);
  $('agCommBot').hidden = !bot;
  $('agCommAccount').hidden = Boolean(bot) && !accountOn;
  $('agFolderName').textContent = $('agCommTitle').value || 'Dashsan CS';
  if (!bot) return;
  const bySlug = new Map(ag.state.groups.filter((g) => g.communityPlatform && !g.removed).map((g) => [g.communityPlatform, g]));
  const allGroup = ag.state.groups.find((g) => isAll(g) && !g.removed);
  const allCard = allGroup
    ? `<div class="ag-plink all done"><span><b>🌐 All — insight gabungan</b><br /><span class="muted">${esc(allGroup.title)}</span></span>${allGroup.inviteLink ? `<a class="btn" href="${esc(allGroup.inviteLink)}" target="_blank" rel="noopener">Link undangan</a>` : '<span class="up">✓</span>'}</div>`
    : `<div class="ag-plink all"><span><b>🌐 All — insight gabungan</b><br /><span class="muted">Overview semua platform + target bulanan</span></span><a class="btn primary" data-startgroup="all" href="${esc(startGroupUrl('all'))}" target="_blank" rel="noopener">Buat / pilih grup All</a></div>`;
  $('agPlatLinks').innerHTML = allCard + ag.platforms.map((p) => {
    const g = bySlug.get(p.slug);
    return g
      ? `<div class="ag-plink done"><span><b>${esc(p.name)}</b><br /><span class="muted">${esc(g.title)}${g.setupNote ? ` • ⚠ ${esc(g.setupNote)}` : ''}</span></span>${g.inviteLink ? `<a class="btn" href="${esc(g.inviteLink)}" target="_blank" rel="noopener">Link undangan</a>` : '<span class="up">✓</span>'}</div>`
      : `<div class="ag-plink"><b>${esc(p.name)}</b><a class="btn primary" data-startgroup="${esc(p.slug)}" href="${esc(startGroupUrl(p.slug))}" target="_blank" rel="noopener">Buat / pilih grup</a></div>`;
  }).join('');
}

// setelah tombol platform diklik: cek otomatis tiap 5 detik selama 3 menit
let watchTimer = null;
function watchForGroups(slug) {
  clearInterval(watchTimer);
  const until = Date.now() + 180000;
  const name = slug === 'all' ? 'All' : ag.platforms.find((p) => p.slug === slug)?.name || slug;
  $('agWatchMsg').textContent = `Menunggu grup ${name} di Telegram… (cek otomatis tiap 5 detik)`;
  const tick = async () => {
    try {
      const r = await api('detect', { prefix: $('agCommPrefix').value });
      ag.state = r.state;
      renderGroups();
      renderBotCommunity();
      if (ag.state.groups.some((g) => g.communityPlatform === slug && !g.removed)) {
        clearInterval(watchTimer);
        $('agWatchMsg').textContent = `✓ Grup ${name} siap.`;
        return;
      }
    } catch (err) {
      $('agWatchMsg').textContent = err.message;
    }
    if (Date.now() > until) {
      clearInterval(watchTimer);
      $('agWatchMsg').textContent = `Grup ${name} belum terdeteksi. Pastikan bot sudah dimasukkan lewat tombol tadi, lalu klik "Deteksi grup baru".`;
    }
  };
  watchTimer = setInterval(tick, 5000);
}

function renderCommunity() {
  renderBotCommunity();
  const c = ag.state.community;
  const groups = ag.state.groups.filter((g) => g.via === 'account' && g.communityPlatform && !g.removed);
  const have = new Set(groups.map((g) => g.communityPlatform));
  $('agCommInfo').innerHTML = c?.inviteUrl || groups.length
    ? `<p><b>${esc(c?.title || 'Komunitas')}</b> — ${groups.length} grup.${c?.inviteUrl ? ` Link gabung ke semua grup sekaligus: <a class="ag-link" href="${esc(c.inviteUrl)}" target="_blank" rel="noopener">${esc(c.inviteUrl)}</a>` : ''}</p>`
    : '';
  if (c?.title) $('agCommTitle').value = c.title;
  const box = $('agCommPlatforms');
  if (!box.dataset.ready) {
    box.innerHTML = ag.platforms.map((p) => `<label><input type="checkbox" data-cp="${esc(p.slug)}" checked /> ${esc(p.name)}</label>`).join('');
    box.dataset.ready = '1';
  }
  box.querySelectorAll('[data-cp]').forEach((cb) => {
    const done = have.has(cb.dataset.cp);
    cb.closest('label').title = done ? 'Grup sudah ada' : '';
    cb.closest('label').style.opacity = done ? 0.55 : 1;
  });
  $('agCommCreate').disabled = !ag.state.tgAccount?.connected;
  $('agCommCreate').textContent = groups.length ? 'Lengkapi grup & perbarui link komunitas' : 'Buat komunitas & grup';
}

// pratinjau dengan tampilan mirip Telegram: hanya tag tebal/miring yang dipertahankan
const bubbleHtml = (t) => esc(t).replace(/&lt;(\/?)(b|i|u|s|code)&gt;/g, '<$1$2>');

function savedTemplate(kind) {
  return ag.state[TPL_KEY[kind]] || { mode: 'auto', text: '' };
}
// draf per tab disimpan di memori supaya pindah tab tidak menghapus ketikan
function draft(kind) {
  if (!ag.drafts[kind]) { const t = savedTemplate(kind); ag.drafts[kind] = { mode: t.mode, text: t.text || ag.defaults[kind], dirty: false }; }
  return ag.drafts[kind];
}

function renderTemplate() {
  const kind = ag.tplKind;
  const d = draft(kind);
  document.querySelectorAll('.ag-tab').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
  const groups = ag.state.groups.filter((g) => !g.removed && g.platforms?.length);
  const mine = groups.filter((g) => (kind === 'all' ? isAll(g) : !isAll(g)));
  $('agTabCountP').textContent = `(${groups.filter((g) => !isAll(g)).length} grup)`;
  $('agTabCountA').textContent = `(${groups.filter(isAll).length} grup)`;
  $('agTabHint').textContent = kind === 'all'
    ? 'Dipakai untuk grup yang platformnya "Semua platform" (mis. grup All): overview, sales per platform, pending/expired, dan target bulanan.'
    : 'Dipakai untuk grup yang berisi satu atau beberapa platform tertentu (mis. grup JadiASN).';
  $('agModeAutoDesc').textContent = kind === 'all'
    ? 'Format "Update All Platform": overview, sales hari ini per platform, pending & expired, target bulanan'
    : 'Template bawaan lengkap; sapaan & kalimat penyemangat berganti-ganti tiap jadwal';
  $('agModeCustomDesc').innerHTML = kind === 'all'
    ? 'Tulis sendiri, mis. <code>Hari ini [hari_ini] [hari_ini_vs]</code>'
    : 'Tulis sendiri memakai variabel, mis. <code>Halo [platform], omzet kamu hari ini [omzet]</code>';
  document.querySelectorAll('input[name="agTplMode"]').forEach((r) => { r.checked = r.value === d.mode; });
  if ($('agTplText').dataset.kind !== kind) { $('agTplText').value = d.text; $('agTplText').dataset.kind = kind; }
  $('agTplCustom').hidden = d.mode !== 'custom';
  if ($('agTplVars').dataset.kind !== kind) {
    $('agTplVars').innerHTML = ag.vars[kind].map(([k, desc]) => `<button type="button" class="chip" data-tvar="[${esc(k)}]" title="${esc(desc)}">[${esc(k)}]</button>`).join('');
    $('agTplVars').dataset.kind = kind;
  }
  const prev = $('agTplGroup').value;
  $('agTplGroup').innerHTML = mine.length
    ? mine.map((g) => `<option value="${esc(g.chatId)}">${esc(g.title)}</option>`).join('')
    : `<option value="">(belum ada grup ${kind === 'all' ? 'All' : 'per platform'})</option>`;
  if (mine.some((g) => g.chatId === prev)) $('agTplGroup').value = prev;
  const saved = savedTemplate(kind);
  $('agTplState').textContent = d.dirty ? 'Belum disimpan' : `Tersimpan: mode ${saved.mode === 'custom' ? 'Custom' : 'Otomatis'}`;
}
const currentMode = () => draft(ag.tplKind).mode;
const currentTemplate = () => ({ mode: draft(ag.tplKind).mode, text: $('agTplText').value });

function renderTargets() {
  const box = $('agTargets');
  if (!box.dataset.ready) {
    box.innerHTML = ag.platforms.map((p) => `<label>${esc(p.name)}<input data-target="${esc(p.slug)}" inputmode="numeric" /></label>`).join('');
    box.dataset.ready = '1';
  }
  box.querySelectorAll('[data-target]').forEach((inp) => { if (!inp.matches(':focus')) inp.value = Number(ag.targets[inp.dataset.target] || 0).toLocaleString('id-ID'); });
  updateTargetTotal();
  const m = ag.monthData;
  $('agMonthState').textContent = m ? (m.done >= m.total ? `✓ Data bulan lalu & tahunan siap (${m.total} bulan-platform)` : `Data bulan & tahun: ${m.done}/${m.total} siap — sisanya dihitung otomatis saat jadwal berjalan, atau klik tombol ini`) : '';
  $('agWarm').hidden = Boolean(m && m.done >= m.total);
}
const parseRp = (v) => Number(String(v).replace(/[^0-9]/g, '')) || 0;
function updateTargetTotal() {
  const total = [...$('agTargets').querySelectorAll('[data-target]')].reduce((a, i) => a + parseRp(i.value), 0);
  $('agTargetTotal').textContent = `Total target: Rp${total.toLocaleString('id-ID')}`;
}

// ---------- kartu buka/tutup + navigasi cepat ----------
const SECTIONS = [
  ['status', 'Status Agent', '📋'], ['akun', 'Akun Telegram', '👤'], ['komunitas', 'Komunitas', '🌐'],
  ['grup', 'Grup Telegram', '👥'], ['jadwal', 'Jadwal Otomatis', '⏰'], ['ai', 'Instruksi untuk AI', '🤖'],
  ['template', 'Template Pesan', '📝'], ['target', 'Target Bulanan', '🎯'], ['kirim', 'Pratinjau & Kirim Manual', '📤'],
  ['riwayat', 'Riwayat Pengiriman', '🕘'],
];
const OPEN_KEY = 'dashsan.agentOpen';
const loadOpen = () => { try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY)) || ['status']); } catch { return new Set(['status']); } };
const saveOpen = (set) => { try { localStorage.setItem(OPEN_KEY, JSON.stringify([...set])); } catch { /* abaikan */ } };
const openSet = loadOpen();
const cardOf = (key) => document.querySelector(`#agentView section.card[data-sec="${key}"]`);

function setOpen(key, open) {
  const card = cardOf(key);
  if (!card) return;
  card.classList.toggle('collapsed', !open);
  card.querySelector('.card-head h2')?.setAttribute('aria-expanded', String(open));
  open ? openSet.add(key) : openSet.delete(key);
  saveOpen(openSet);
  renderNav();
}

function setupAccordion() {
  const cards = [...$('agentView').querySelectorAll('section.card')].filter((c) => c.id !== 'agLock');
  for (const [key, title] of SECTIONS) {
    const card = cards.find((c) => c.querySelector('h2')?.textContent.includes(title));
    if (!card) continue;
    card.dataset.sec = key;
    card.classList.add('ag-collapsible');
    const head = card.querySelector('.card-head');
    const body = document.createElement('div');
    body.className = 'ag-body';
    [...card.children].filter((el) => el !== head).forEach((el) => body.appendChild(el));
    card.appendChild(body);
    const h2 = head.querySelector('h2');
    h2.insertAdjacentHTML('afterbegin', '<span class="ag-chev" aria-hidden="true">▶</span>');
    h2.setAttribute('role', 'button');
    h2.tabIndex = 0;
    h2.insertAdjacentHTML('afterend', `<span class="ag-sum" data-sum="${key}"></span>`);
    head.addEventListener('click', (e) => {
      if (e.target.closest('button, a, input, select, textarea, label')) return;
      setOpen(key, card.classList.contains('collapsed'));
    });
    h2.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(key, card.classList.contains('collapsed')); } });
    card.classList.toggle('collapsed', !openSet.has(key));
    h2.setAttribute('aria-expanded', String(openSet.has(key)));
  }
  $('agNav').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.go) {
      setOpen(b.dataset.go, true);
      cardOf(b.dataset.go).scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (b.dataset.all) {
      for (const [key] of SECTIONS) if (cardOf(key) && !cardOf(key).hidden) setOpen(key, b.dataset.all === 'open');
    }
  });
  // navigasi menempel tepat di bawah header
  const syncTop = () => {
    const bar = document.querySelector('.topbar');
    const sticky = getComputedStyle(bar).position === 'sticky';
    $('agentView').style.setProperty('--ag-top', `${sticky ? bar.offsetHeight : 0}px`);
  };
  syncTop();
  window.addEventListener('resize', syncTop);
  window.addEventListener('hashchange', () => setTimeout(syncTop, 0));
  window.addEventListener('dashsan:agent', () => setTimeout(syncTop, 0));
}

function renderNav() {
  const chips = SECTIONS.filter(([key]) => cardOf(key) && !cardOf(key).hidden)
    .map(([key, title, icon]) => `<button type="button" class="chip ${openSet.has(key) ? 'open' : ''}" data-go="${key}" title="${esc(title)}">${icon} ${esc(title.replace(' & Kirim Manual', ' & Kirim').replace(' Pengiriman', '').replace(' Telegram', ''))}</button>`);
  $('agNav').innerHTML = chips.join('') + '<span class="ag-nav-sep"></span><button type="button" class="chip" data-all="open">Buka semua</button><button type="button" class="chip" data-all="close">Tutup semua</button>';
}

// ringkasan singkat di judul tiap kartu (tetap terlihat saat kartu tertutup)
function renderSummaries() {
  const st = ag.state;
  const groups = st.groups.filter((g) => !g.removed);
  const active = groups.filter((g) => g.enabled && g.platforms?.length);
  const ready = groups.filter((g) => g.communityPlatform).length;
  const tplMode = (k) => ((st[k] || {}).mode === 'custom' ? 'Custom' : 'Otomatis');
  const last = st.history?.[0];
  const targetTotal = Object.values(ag.targets || {}).reduce((a, v) => a + Number(v || 0), 0);
  const sum = {
    status: `${ag.info.telegram.username ? '✓ Bot' : '✗ Bot'} • Jadwal ${st.schedule.enabled ? 'aktif' : 'nonaktif'}`,
    akun: st.tgAccount?.connected ? `✓ ${st.tgAccount.user?.name || 'Terhubung'}` : 'Opsional • belum terhubung',
    komunitas: `${ready}/${ag.platforms.length + 1} grup siap`,
    grup: `${active.length} aktif dari ${groups.length}`,
    jadwal: st.schedule.enabled ? `Aktif • ${st.schedule.slots.length}× sehari` : 'Nonaktif',
    ai: st.instructions ? 'Ada instruksi' : 'Kosong',
    template: `Platform: ${tplMode('messageTemplate')} • All: ${tplMode('messageTemplateAll')}`,
    target: targetTotal ? `Rp${targetTotal.toLocaleString('id-ID')} / bulan` : 'Belum diisi',
    kirim: '',
    riwayat: last ? `Terakhir ${fmtTime(last.at)} • ${last.ok ? 'terkirim' : 'gagal'}` : 'Belum ada',
  };
  document.querySelectorAll('[data-sum]').forEach((el) => { el.textContent = sum[el.dataset.sum] ?? ''; });
  renderNav();
}

function renderAll() {
  renderStatus();
  renderTemplate();
  renderTargets();
  renderAccount();
  renderCommunity();
  renderGroups();
  renderSchedule();
  renderHistory();
  renderSummaries();
  ag.dirty = false;
}

// ---------- kumpulkan pengaturan dari form ----------
function collectSettings() {
  const groups = [...$('agGroups').querySelectorAll('tr[data-chat]')].map((tr) => ({
    chatId: tr.dataset.chat,
    platforms: [...tr.querySelectorAll('[data-plat]:checked')].map((c) => c.dataset.plat),
    enabled: tr.querySelector('[data-enabled]').checked,
    title: tr.querySelector('[data-title]').value.trim(),
  }));
  return {
    groups,
    schedule: { enabled: $('agSchedOn').checked, slots: [...$('agSlots').querySelectorAll('[data-slot]:checked')].map((c) => Number(c.dataset.slot)) },
    instructions: $('agInstr').value,
  };
}

async function save() {
  const s = collectSettings();
  const missing = s.groups.filter((g) => g.enabled && !g.platforms.length);
  if (missing.length) throw new Error('Grup yang aktif wajib punya minimal satu platform.');
  if (s.schedule.enabled && !s.groups.some((g) => g.enabled)) throw new Error('Aktifkan minimal satu grup sebelum menyalakan jadwal otomatis.');
  const r = await api('settings', s);
  ag.state = r.state;
  renderAll();
  notice(r.renameErrors?.length ? `Tersimpan, tapi sebagian nama grup gagal diganti: ${r.renameErrors.join('; ')}` : 'Pengaturan tersimpan.', Boolean(r.renameErrors?.length));
}

async function refresh() {
  const r = await api('state');
  ag.vars = { platform: r.messageVars || [], all: r.allVars || [] };
  ag.defaults = { platform: r.defaultCustomTemplate || '', all: r.defaultAllTemplate || '' };
  ag.targets = r.targets || {};
  ag.monthData = r.monthData || null;
  ag.state = r.state;
  ag.info = r.info;
  ag.platforms = r.platforms;
  renderAll();
}

// ---------- event ----------
function setup() {
  $('agRefresh').addEventListener('click', (e) => busy(e.target, 'Memuat…', async () => { await refresh(); notice(''); }));
  $('agSave').addEventListener('click', (e) => busy(e.target, 'Menyimpan…', save));
  // ---- template pesan ----
  document.querySelectorAll('.ag-tab').forEach((b) => b.addEventListener('click', () => {
    draft(ag.tplKind).text = $('agTplText').value; // simpan ketikan tab sebelumnya
    ag.tplKind = b.dataset.kind;
    $('agTplPreviewBox').hidden = true;
    renderTemplate();
  }));
  document.querySelectorAll('input[name="agTplMode"]').forEach((r) => r.addEventListener('change', () => {
    Object.assign(draft(ag.tplKind), { mode: r.value, dirty: true });
    renderTemplate();
  }));
  const markText = () => { Object.assign(draft(ag.tplKind), { text: $('agTplText').value, dirty: true }); $('agTplState').textContent = 'Belum disimpan'; };
  $('agTplText').addEventListener('input', markText);
  $('agTplVars').addEventListener('click', (e) => {
    const v = e.target.closest('[data-tvar]')?.dataset.tvar;
    if (!v) return;
    const box = $('agTplText');
    const { selectionStart: a, selectionEnd: b, value } = box;
    box.value = value.slice(0, a) + v + value.slice(b);
    box.focus();
    box.selectionStart = box.selectionEnd = a + v.length;
    markText();
  });
  $('agTplSample').addEventListener('click', () => {
    if ($('agTplText').value.trim() && !confirm('Ganti isi template dengan contoh?')) return;
    $('agTplText').value = ag.defaults[ag.tplKind];
    markText();
  });
  $('agTplPreview').addEventListener('click', (e) => busy(e.target, 'Membuat…', async () => {
    const chatId = $('agTplGroup').value;
    if (!chatId) throw new Error('Belum ada grup untuk pratinjau.');
    const r = await api('preview', { chatId, template: currentTemplate() });
    $('agTplPreviewBox').hidden = false;
    $('agTplPreviewBox').innerHTML = bubbleHtml(r.text);
    const unknown = [...new Set((r.text.match(/\[[a-z_]+\]/gi) || []))];
    notice(unknown.length ? `Variabel tidak dikenal: ${unknown.join(', ')} — cek ejaannya.` : '', unknown.length > 0);
  }));
  $('agTplSave').addEventListener('click', (e) => busy(e.target, 'Menyimpan…', async () => {
    const t = currentTemplate();
    if (t.mode === 'custom' && !t.text.trim()) throw new Error('Template custom masih kosong.');
    const r = await api('settings', { [TPL_KEY[ag.tplKind]]: t });
    ag.state = r.state;
    ag.drafts[ag.tplKind] = { ...t, dirty: false };
    renderAll();
    notice(`Template ${ag.tplKind === 'all' ? 'grup All' : 'grup per platform'} disimpan (mode ${t.mode === 'custom' ? 'Custom' : 'Otomatis'}).`);
  }));

  // ---- target bulanan ----
  $('agTargets').addEventListener('input', (e) => { if (e.target.matches('[data-target]')) updateTargetTotal(); });
  $('agTargets').addEventListener('focusout', (e) => { if (e.target.matches('[data-target]')) e.target.value = parseRp(e.target.value).toLocaleString('id-ID'); });
  $('agTargetSave').addEventListener('click', (e) => busy(e.target, 'Menyimpan…', async () => {
    const targets = Object.fromEntries([...$('agTargets').querySelectorAll('[data-target]')].map((i) => [i.dataset.target, parseRp(i.value)]));
    await api('settings', { targets });
    await refresh();
    notice('Target bulanan tersimpan.');
  }));
  $('agWarm').addEventListener('click', (e) => busy(e.target, 'Menghitung…', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await api('warm', {});
      ag.monthData = r.progress;
      renderTargets();
      if (r.progress.done >= r.progress.total) break;
    }
  }));

  $('agUnlockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await request('unlock', { password: $('agUnlockPw').value });
    const data = await res.json().catch(() => ({}));
    if (!data.status) return showLock(data.message || 'Gagal membuka');
    setToken(data.token);
    $('agUnlockPw').value = '';
    hideLock();
    show();
  });
  $('agLockBtn').addEventListener('click', () => { setToken(''); showLock(); });

  $('agCredsSave').addEventListener('click', (e) => busy(e.target, 'Menyimpan…', async () => {
    const r = await api('tg/creds', { apiId: $('agApiId').value.trim(), apiHash: $('agApiHash').value.trim() });
    ag.state = r.state;
    $('agApiHash').value = '';
    renderAll();
    notice('API Telegram tersimpan (terenkripsi). Lanjut klik Scan QR.');
  }));
  $('agScan').addEventListener('click', (e) => busy(e.target, 'Menunggu scan…', async () => {
    $('agQr').hidden = false;
    $('agQrImg').innerHTML = '';
    $('agQrMsg').textContent = 'Menyiapkan QR…';
    try {
      const last = await stream('tg/login', { password: $('agTwoFa').value }, (ev) => {
        if (ev.type === 'qr') {
          $('agQrImg').innerHTML = ev.svg;
          $('agQrMsg').textContent = 'Scan dengan HP akun khusus: Telegram → Settings → Devices → Link Desktop Device. QR diperbarui otomatis.';
        }
      });
      $('agTwoFa').value = '';
      $('agQr').hidden = true;
      await refresh();
      notice(`Akun Telegram terhubung: ${last.user?.name || ''}. Lanjut buat komunitas di bawah.`);
    } catch (err) {
      $('agQrImg').innerHTML = '';
      $('agQrMsg').textContent = '';
      $('agQr').hidden = true;
      throw err;
    }
  }));
  $('agAccLogout').addEventListener('click', (e) => {
    if (!confirm('Putuskan akun Telegram dari Dashsan? Pengiriman lewat akun akan berhenti sampai di-scan ulang.')) return;
    busy(e.target, 'Memutus…', async () => {
      const r = await api('tg/logout', {});
      ag.state = r.state;
      renderAll();
      notice('Akun Telegram diputus.');
    });
  });
  $('agCommCreate').addEventListener('click', (e) => {
    const platforms = [...$('agCommPlatforms').querySelectorAll('[data-cp]:checked')].map((c) => c.dataset.cp);
    if (!platforms.length) return notice('Pilih minimal satu platform.', true);
    if (!confirm(`Buat komunitas "${$('agCommTitle').value}" dengan grup untuk ${platforms.length} platform di akun Telegram yang terhubung?`)) return;
    const log = $('agCommLog');
    log.hidden = false;
    log.innerHTML = '';
    const line = (txt) => log.insertAdjacentHTML('beforeend', `<li>${txt}</li>`);
    busy(e.target, 'Membuat grup…', async () => {
      try {
        const last = await stream('community', { title: $('agCommTitle').value, prefix: $('agCommPrefix').value, platforms }, (ev) => {
          if (ev.type === 'progress') line(`<b>${esc(ev.title)}</b> — ${esc(ev.status)}${ev.inviteLink ? ` • <a class="ag-link" href="${esc(ev.inviteLink)}" target="_blank" rel="noopener">link</a>` : ''}`);
        });
        ag.state = last.state;
        renderAll();
        notice('Komunitas siap. Bagikan link komunitas atau link per grup ke tim CS.');
      } catch (err) {
        await refresh().catch(() => {});
        throw err;
      }
    });
  });

  $('agPlatLinks').addEventListener('click', (e) => {
    const slug = e.target.closest('[data-startgroup]')?.dataset.startgroup;
    if (slug) watchForGroups(slug); // tautan tetap terbuka di tab/aplikasi Telegram
  });
  $('agCommTitle').addEventListener('input', () => { $('agFolderName').textContent = $('agCommTitle').value || 'Dashsan CS'; });

  $('agDetect').addEventListener('click', (e) => busy(e.target, 'Mencari…', async () => {
    if (ag.dirty) await save();
    const r = await api('detect', { prefix: $('agCommPrefix').value });
    ag.state = r.state;
    renderAll();
    notice(r.prepared?.length ? `Grup siap otomatis: ${r.prepared.map((x) => x.title).join(', ')}.` : r.added ? `${r.added} grup baru ditemukan. Pilih platform & centang Aktif, lalu Simpan.` : r.seen ? 'Tidak ada grup baru (grup yang terdeteksi sudah ada di daftar).' : 'Belum ada grup terdeteksi. Pastikan bot sudah masuk grup dan ada pesan baru di grup itu dalam 24 jam terakhir.');
  }));

  $('agGroups').addEventListener('input', (e) => { if (e.target.matches('[data-title]')) ag.dirty = true; });
  $('agGroups').addEventListener('change', (e) => {
    ag.dirty = true;
    const tr = e.target.closest('tr[data-chat]');
    if (!tr) return;
    // "Semua platform" eksklusif dengan pilihan per platform
    if (e.target.dataset.plat === 'all' && e.target.checked) tr.querySelectorAll('[data-plat]').forEach((c) => { if (c.dataset.plat !== 'all') c.checked = false; });
    else if (e.target.dataset.plat && e.target.checked) tr.querySelector('[data-plat="all"]').checked = false;
    const sel = [...tr.querySelectorAll('[data-plat]:checked')].map((c) => platformName(c.dataset.plat));
    tr.querySelector('.ag-plat summary').textContent = sel.length ? sel.join(', ') : 'Pilih platform…';
  });
  $('agGroups').addEventListener('click', (e) => {
    if (!e.target.matches('[data-delete]')) return;
    const tr = e.target.closest('tr[data-chat]');
    if (!confirm('Hapus grup ini dari daftar? (Bot tidak keluar dari grup Telegram.)')) return;
    busy(e.target, 'Menghapus…', async () => {
      const r = await api('settings', { groups: [{ chatId: tr.dataset.chat, delete: true }] });
      ag.state = r.state;
      renderAll();
    });
  });
  document.addEventListener('click', (e) => {
    // tutup dropdown platform saat klik di luar
    document.querySelectorAll('.ag-plat[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
  });
  ['agSchedOn', 'agSlots', 'agInstr'].forEach((id) => $(id).addEventListener('input', () => { ag.dirty = true; }));

  $('agPreviewBtn').addEventListener('click', (e) => busy(e.target, 'AI sedang menulis…', async () => {
    const chatId = $('agPreviewGroup').value;
    if (!chatId) throw new Error('Belum ada grup dengan platform. Atur di tabel Grup Telegram lalu Simpan.');
    if (ag.dirty) await save();
    $('agPreviewInfo').textContent = 'Mengambil data & menulis pesan, ±10–40 detik…';
    const r = await api('preview', { chatId });
    $('agPreviewText').value = r.text;
    $('agPreviewInfo').textContent = `Ditulis oleh ${r.writer === 'template' ? 'template (tanpa AI)' : r.writer} • data ${r.facts.waktu}${r.facts.peringatan_data?.length ? ' • ⚠ sebagian data tidak lengkap' : ''}`;
    $('agSendBtn').disabled = false;
    notice('');
  }));
  $('agSendBtn').addEventListener('click', (e) => {
    const g = ag.state.groups.find((x) => x.chatId === $('agPreviewGroup').value);
    if (!g || !confirm(`Kirim pesan ini ke grup "${g.title}"?`)) return;
    busy(e.target, 'Mengirim…', async () => {
      const r = await api('send', { chatId: g.chatId, text: $('agPreviewText').value });
      ag.state = r.state;
      renderHistory();
      notice(`Pesan terkirim ke "${g.title}".`);
    });
  });
  $('agRunAll').addEventListener('click', (e) => {
    const active = ag.state.groups.filter((g) => g.enabled && !g.removed && g.platforms?.length);
    if (!active.length) return notice('Belum ada grup aktif yang punya platform.', true);
    if (!confirm(`AI akan menulis & langsung mengirim pesan ke ${active.length} grup aktif tanpa pratinjau. Lanjut?`)) return;
    busy(e.target, 'Mengirim ke semua grup…', async () => {
      if (ag.dirty) await save();
      const r = await api('run-now', {});
      ag.state = r.state;
      renderHistory();
      const fail = r.results.filter((x) => !x.ok);
      notice(fail.length ? `${r.results.length - fail.length} terkirim, ${fail.length} gagal — lihat Riwayat.` : `Terkirim ke ${r.results.length} grup.`, fail.length > 0);
    });
  });
}

async function show() {
  if (ag.loaded) return;
  ag.loaded = true;
  try {
    const lock = await (await request('lock')).json();
    if (lock.required && !lock.configured) { ag.loaded = false; return showLock('Password Agent Tele belum diatur di server (AGENT_PASSWORD).'); }
    if (lock.required && !lock.unlocked) return showLock();
    hideLock();
    await refresh();
  } catch (err) {
    ag.loaded = false;
    if (!$('agentView').classList.contains('is-locked')) notice(err.message, true);
  }
}

setupAccordion();
setup();
window.addEventListener('dashsan:agent', show);
if (document.body.dataset.view === 'agent') show();
