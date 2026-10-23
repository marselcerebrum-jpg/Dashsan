// Menu Agent Tele — pengaturan grup Telegram, jadwal, pratinjau & riwayat

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SLOTS = [0, 3, 6, 9, 12, 15, 18, 21];
const ag = { state: null, info: null, platforms: [], loaded: false, dirty: false };

async function api(route, body) {
  const opts = body === undefined
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashsan': '1' }, body: JSON.stringify(body) };
  const res = await fetch(new URL(`/api/agent/${route}`, location.origin), opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.status) throw new Error(data.message || `Gagal (HTTP ${res.status})`);
  return data;
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
    item('Penulis pesan (AI)', ai.configured, ai.configured ? `Claude (${esc(ai.model)})` : 'ANTHROPIC_API_KEY belum diatur — memakai template'),
    item('Penyimpanan pengaturan', storage === 'vercel-blob' || !location.hostname.endsWith('vercel.app'), storage === 'vercel-blob' ? 'Vercel Blob' : 'File lokal (khusus komputer ini)'),
    item('Jadwal otomatis', cron.configured && ag.state.schedule.enabled, !cron.configured ? 'CRON_SECRET belum diatur' : ag.state.schedule.enabled ? `Aktif: ${ag.state.schedule.slots.map((s) => `${String(s).padStart(2, '0')}.00`).join(', ')} WIB` : 'Nonaktif'),
  ].join('');
  $('agGuide').open = !telegram.username;
}

function platformPicker(g) {
  const sel = new Set(g.platforms || []);
  const summary = sel.size ? [...sel].map(platformName).join(', ') : 'Pilih platform…';
  const opt = (slug) => `<label><input type="checkbox" data-plat="${esc(slug)}" ${sel.has(slug) ? 'checked' : ''}/> ${esc(platformName(slug))}</label>`;
  return `<details class="ag-plat"><summary>${esc(summary)}</summary><div class="ag-plat-list">${opt('all')}<hr style="width:100%;border:0;border-top:1px solid var(--border);margin:2px 0" />${ag.platforms.map((p) => opt(p.slug)).join('')}</div></details>`;
}

function renderGroups() {
  const groups = ag.state.groups;
  const head = '<thead><tr><th>Grup</th><th>Platform yang dikirim</th><th>Aktif</th><th></th></tr></thead>';
  const body = groups.length
    ? groups.map((g) => `<tr data-chat="${esc(g.chatId)}">
        <td><b>${esc(g.title)}</b><br /><span class="muted">${esc(g.chatId)}${g.removed ? ' • <span class="down">bot sudah dikeluarkan</span>' : ''}</span></td>
        <td>${platformPicker(g)}</td>
        <td><input type="checkbox" data-enabled ${g.enabled ? 'checked' : ''} ${g.removed ? 'disabled' : ''} /></td>
        <td><button type="button" class="btn" data-delete>Hapus</button></td>
      </tr>`).join('')
    : '<tr><td class="empty" colspan="4">Belum ada grup. Masukkan bot ke grup Telegram, kirim satu pesan di grup itu, lalu klik "Deteksi grup baru".</td></tr>';
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

function renderAll() {
  renderStatus();
  renderGroups();
  renderSchedule();
  renderHistory();
  ag.dirty = false;
}

// ---------- kumpulkan pengaturan dari form ----------
function collectSettings() {
  const groups = [...$('agGroups').querySelectorAll('tr[data-chat]')].map((tr) => ({
    chatId: tr.dataset.chat,
    platforms: [...tr.querySelectorAll('[data-plat]:checked')].map((c) => c.dataset.plat),
    enabled: tr.querySelector('[data-enabled]').checked,
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
  notice('Pengaturan tersimpan.');
}

async function refresh() {
  const r = await api('state');
  ag.state = r.state;
  ag.info = r.info;
  ag.platforms = r.platforms;
  renderAll();
}

// ---------- event ----------
function setup() {
  $('agRefresh').addEventListener('click', (e) => busy(e.target, 'Memuat…', async () => { await refresh(); notice(''); }));
  $('agSave').addEventListener('click', (e) => busy(e.target, 'Menyimpan…', save));
  $('agDetect').addEventListener('click', (e) => busy(e.target, 'Mencari…', async () => {
    if (ag.dirty) await save();
    const r = await api('detect', {});
    ag.state = r.state;
    renderAll();
    notice(r.added ? `${r.added} grup baru ditemukan. Pilih platform & centang Aktif, lalu Simpan.` : r.seen ? 'Tidak ada grup baru (grup yang terdeteksi sudah ada di daftar).' : 'Belum ada grup terdeteksi. Pastikan bot sudah masuk grup dan ada pesan baru di grup itu dalam 24 jam terakhir.');
  }));

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
    await refresh();
  } catch (err) {
    ag.loaded = false;
    notice(err.message, true);
  }
}

setup();
window.addEventListener('dashsan:agent', show);
if (document.body.dataset.view === 'agent') show();
