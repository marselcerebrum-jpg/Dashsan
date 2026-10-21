// Dashboard Sales — logika front-end (tanpa build step)

const STATUS = ['Pending', 'Success', 'Expired', 'Canceled', 'Failed'];
const DAYS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const DAYS_FULL = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const PAGE_SIZE = 25;
// warna mengikuti tipe produk (bukan urutan), supaya konsisten di semua periode
const TYPE_COLOR = { Perdana: '--s1', Perpanjangan: '--s2', Upgrade: '--s3' };

const $ = (id) => document.getElementById(id);
// URL absolut tanpa user:password — fetch() menolak URL relatif bila halaman dibuka lewat https://user:pass@host
const apiUrl = (p) => new URL(p, location.origin);
const state = { config: null, trx: [], prev: [], page: 0, leads: [], charts: {}, cmp: null, allPlatforms: false };

// ---------- format ----------
const rupiah = (n) => 'Rp' + Math.round(n || 0).toLocaleString('id-ID');
const rupiahShort = (n) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `Rp${(n / 1e9).toLocaleString('id-ID', { maximumFractionDigits: 2 })} M`;
  if (a >= 1e6) return `Rp${(n / 1e6).toLocaleString('id-ID', { maximumFractionDigits: 1 })} jt`;
  if (a >= 1e3) return `Rp${(n / 1e3).toLocaleString('id-ID', { maximumFractionDigits: 0 })} rb`;
  return rupiah(n);
};
const num = (n) => Math.round(n || 0).toLocaleString('id-ID');
const pct = (n) => (Number.isFinite(n) ? (n * 100).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + '%' : '–');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- tanggal ----------
const toDate = (s) => new Date(`${s}T00:00:00Z`);
const fmtDate = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => fmtDate(new Date(toDate(s).getTime() + n * 86400000));
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000) + 1;
const dateLabel = (s) => toDate(s).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' });

// Periode pembanding: periode sama tahun lalu (default) atau N hari tepat sebelumnya
function shiftYear(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const last = new Date(Date.UTC(y + n, m, 0)).getUTCDate(); // 29 Feb → 28 Feb
  return fmtDate(new Date(Date.UTC(y + n, m - 1, Math.min(d, last))));
}
function compareRange(mode, start, end) {
  const days = daysBetween(start, end);
  if (mode === 'prev') {
    const e = addDays(start, -1);
    return { mode, start: addDays(e, -(days - 1)), end: e, short: `${days} hari sebelumnya`, series: 'Omzet periode sebelumnya' };
  }
  return { mode, start: shiftYear(start, -1), end: shiftYear(end, -1), short: 'tahun lalu', series: 'Omzet tahun lalu' };
}
const rangeLabel = (a, b) => (a === b ? `${dateLabel(a)} ${a.slice(0, 4)}` : `${dateLabel(a)} – ${dateLabel(b)} ${b.slice(0, 4)}`);
const platformName = (slug) => (slug === 'all' ? 'Semua platform' : state.config?.platforms?.find((p) => p.slug === slug)?.name || slug);

function presetRange(preset, today) {
  const [y, m] = today.split('-').map(Number);
  switch (preset) {
    case 'today': return [today, today];
    case 'yesterday': return [addDays(today, -1), addDays(today, -1)];
    case 'this_month': return [`${today.slice(0, 7)}-01`, today];
    case 'last_month': {
      const first = fmtDate(new Date(Date.UTC(m === 1 ? y - 1 : y, m === 1 ? 11 : m - 2, 1)));
      return [first, addDays(`${today.slice(0, 7)}-01`, -1)];
    }
    case 'custom': return [$('startDate').value, $('endDate').value];
    default: return [addDays(today, -(Number(preset) - 1)), today];
  }
}

// ---------- normalisasi data ----------
// API mengirim promo_code sebagai string JSON array ("[\"LOLOSASN \"]", "[]", "null"),
// dengan huruf besar/kecil & spasi yang tidak konsisten → satukan jadi "LOLOSASN" atau null.
function normalizePromo(v) {
  let codes = v;
  if (typeof v === 'string') {
    try { codes = JSON.parse(v); } catch { codes = v; }
  }
  if (!Array.isArray(codes)) codes = codes == null ? [] : [codes];
  const out = [...new Set(codes.map((c) => String(c ?? '').trim().toUpperCase()).filter((c) => c && c !== 'NULL'))];
  return out.length ? out.join(', ') : null;
}

function normalize(t) {
  const paid = t.paid_date && t.paid_date !== '-' ? t.paid_date : null;
  // Waktu closing: transaksi sukses dihitung di tanggal bayar, sisanya di tanggal dibuat
  const closingAt = Number(t.status) === 1 && paid ? paid : String(t.date || '');
  const [d, time = '00:00:00'] = closingAt.split(' ');
  const hour = Number(time.slice(0, 2)) || 0;
  const phone = String(t.customer_phone || '').replace(/\D/g, '').replace(/^0/, '').replace(/^62/, '');
  return {
    ...t,
    promo_code: normalizePromo(t.promo_code),
    paid_date: paid,
    closingAt,
    nominal: Number(t.nominal) || 0,
    status: Number(t.status),
    day: d,
    hour,
    dow: d ? toDate(d).getUTCDay() : 0,
    phone62: phone ? '62' + phone : '',
    custKey: phone || String(t.customer_email || '').toLowerCase() || t.customer_name,
  };
}

// ---------- agregasi ----------
function summarize(rows) {
  const success = rows.filter((t) => t.status === 1);
  const revenue = success.reduce((a, t) => a + t.nominal, 0);
  const lost = rows.filter((t) => t.status >= 2).reduce((a, t) => a + t.nominal, 0);
  const customers = new Map();
  for (const t of success) customers.set(t.custKey, (customers.get(t.custKey) || 0) + 1);
  const repeat = [...customers.values()].filter((c) => c > 1).length;
  return {
    total: rows.length,
    success: success.length,
    revenue,
    lost,
    pending: rows.filter((t) => t.status === 0).length,
    conversion: rows.length ? success.length / rows.length : NaN,
    aov: success.length ? revenue / success.length : NaN,
    customers: customers.size,
    repeatRate: customers.size ? repeat / customers.size : NaN,
  };
}

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const t of rows) {
    const k = keyFn(t) ?? '(kosong)';
    if (!m.has(k)) m.set(k, { key: k, total: 0, success: 0, revenue: 0, rows: [] });
    const g = m.get(k);
    g.total++;
    g.rows.push(t);
    if (t.status === 1) { g.success++; g.revenue += t.nominal; }
  }
  return [...m.values()].map((g) => ({ ...g, conversion: g.total ? g.success / g.total : NaN }));
}

// Satu baris per orang (per platform). Orang dikenali dari nomor HP ATAU email, jadi checkout ulang
// dengan email/HP berbeda tetap terdeteksi. Orang dikeluarkan dari daftar bila punya transaksi sukses
// di periode ini atau sesudahnya sampai hari ini (`later`) — artinya sudah jadi beli/premium.
function personIds(t) {
  const email = String(t.customer_email || '').trim().toLowerCase();
  return [t.phone62 && `${t.platform}|p:${t.phone62}`, email && `${t.platform}|e:${email}`].filter(Boolean);
}
function buildLeads(rows, later) {
  const bought = new Set();
  for (const t of [...rows, ...later]) if (t.status === 1) personIds(t).forEach((id) => bought.add(id));

  // gabungkan semua percobaan gagal milik orang yang sama (cocok lewat HP atau email)
  const owner = new Map(); // id → objek orang
  const people = [];
  for (const t of rows) {
    if (t.status === 1) continue;
    const ids = personIds(t);
    let p = ids.map((id) => owner.get(id)).find(Boolean);
    if (!p) {
      p = { attempts: [], ids: new Set() };
      people.push(p);
    }
    p.attempts.push(t);
    ids.forEach((id) => { p.ids.add(id); owner.set(id, p); });
  }

  let converted = 0;
  const leads = [];
  for (const p of people) {
    if ([...p.ids].some((id) => bought.has(id))) { converted++; continue; }
    const last = p.attempts.reduce((a, b) => (b.date > a.date ? b : a));
    const products = [...new Set(p.attempts.map((t) => t.product))];
    leads.push({ ...last, attempts: p.attempts.length, products, firstDate: p.attempts.reduce((a, b) => (b.date < a.date ? b : a)).date });
  }
  const priority = { 0: 0, 2: 1, 3: 2, 4: 1 };
  leads.sort((a, b) => priority[a.status] - priority[b.status] || b.date.localeCompare(a.date));
  return { leads, converted };
}

// ---------- render: KPI ----------
function kpiCard(label, value, cur, prev, { invert = false, fmt } = {}) {
  let delta = '';
  if (Number.isFinite(cur) && Number.isFinite(prev) && prev !== 0) {
    const ch = (cur - prev) / Math.abs(prev);
    const good = invert ? ch < 0 : ch > 0;
    const arrow = ch > 0 ? '▲' : ch < 0 ? '▼' : '•';
    delta = `<div class="delta ${ch === 0 ? '' : good ? 'up' : 'down'}">${arrow} ${pct(Math.abs(ch))} <span class="muted">vs ${state.cmp.short} (${fmt ? fmt(prev) : num(prev)})</span></div>`;
  } else {
    delta = '<div class="delta muted">belum ada pembanding</div>';
  }
  return `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div>${delta}</div>`;
}

function renderKpis(s, p) {
  $('kpis').innerHTML = [
    kpiCard('Omzet (sukses)', rupiahShort(s.revenue), s.revenue, p.revenue, { fmt: rupiahShort }),
    kpiCard('Transaksi sukses', num(s.success), s.success, p.success),
    kpiCard('Conversion rate', pct(s.conversion), s.conversion, p.conversion, { fmt: pct }),
    kpiCard('Rata-rata nilai order', rupiahShort(s.aov), s.aov, p.aov, { fmt: rupiahShort }),
    kpiCard('Customer unik (beli)', num(s.customers), s.customers, p.customers),
    kpiCard('Potensi omzet hilang', rupiahShort(s.lost), s.lost, p.lost, { invert: true, fmt: rupiahShort }),
  ].join('');
}

// ---------- render: insight ----------
function renderInsights(rows, s, p, range) {
  const out = [];
  if (!rows.length) {
    $('insights').innerHTML = '<li>Tidak ada transaksi di periode ini.</li>';
    return;
  }
  if (p.revenue > 0) {
    const ch = (s.revenue - p.revenue) / p.revenue;
    out.push(`Omzet <b>${ch >= 0 ? 'naik' : 'turun'} ${pct(Math.abs(ch))}</b> dibanding ${state.cmp.mode === 'yoy' ? 'periode sama tahun lalu' : `${range.days} hari sebelumnya`} (${rangeLabel(state.cmp.start, state.cmp.end)}: ${rupiahShort(p.revenue)} → ${rupiahShort(s.revenue)}).${ch < 0 ? ' Cek apakah traffic (jumlah checkout) yang turun atau conversion-nya.' : ''}`);
    if (p.total > 0) {
      const trafficCh = (s.total - p.total) / p.total;
      const convCh = s.conversion - p.conversion;
      out.push(`Jumlah checkout ${trafficCh >= 0 ? 'naik' : 'turun'} ${pct(Math.abs(trafficCh))}, conversion ${convCh >= 0 ? 'naik' : 'turun'} ${(Math.abs(convCh) * 100).toFixed(1)} poin. ${Math.abs(trafficCh) > Math.abs(convCh) * 3 ? 'Perubahan utama dari <b>traffic</b> → fokus ke iklan/konten/broadcast.' : 'Perubahan utama dari <b>conversion</b> → fokus ke follow-up & kemudahan pembayaran.'}`);
    }
  }

  const success = rows.filter((t) => t.status === 1);
  if (success.length >= 10) {
    const byDow = groupBy(success, (t) => t.dow).sort((a, b) => b.success - a.success);
    const byHour = groupBy(success, (t) => t.hour).sort((a, b) => b.success - a.success);
    const topHours = byHour.slice(0, 3).map((h) => `${String(h.key).padStart(2, '0')}.00`).join(', ');
    out.push(`Hari paling ramai: <b>${DAYS_FULL[byDow[0].key]}</b>, jam paling ramai: <b>${topHours}</b> WIB. Jadwalkan broadcast/iklan ±1 jam sebelum jam puncak dan siagakan admin CS di jam tersebut.`);
  }

  const products = groupBy(rows, (t) => t.product).sort((a, b) => b.revenue - a.revenue);
  if (products[0]?.revenue > 0) {
    out.push(`Produk andalan: <b>${esc(products[0].key)}</b> menyumbang ${pct(products[0].revenue / s.revenue)} omzet. ${products[0].revenue / s.revenue > 0.6 ? 'Ketergantungan tinggi pada 1 produk — siapkan produk pendamping/upsell.' : ''}`);
  }
  const weak = products.filter((g) => g.total >= 15 && g.conversion < s.conversion * 0.8).sort((a, b) => b.total - a.total)[0];
  if (weak) {
    out.push(`<b>${esc(weak.key)}</b> banyak diminati (${num(weak.total)} checkout) tapi conversion hanya ${pct(weak.conversion)} (rata-rata ${pct(s.conversion)}). Cek harga, halaman produk, atau beri promo khusus.`);
  }

  const pays = groupBy(rows, (t) => t.payment_method).filter((g) => g.total >= 20).sort((a, b) => a.conversion - b.conversion);
  if (pays.length >= 2 && pays[0].conversion < s.conversion * 0.85) {
    const best = pays[pays.length - 1];
    out.push(`Metode bayar <b>${esc(pays[0].key)}</b> paling sering gagal/expired (sukses ${pct(pays[0].conversion)}), bandingkan <b>${esc(best.key)}</b> ${pct(best.conversion)}. Arahkan customer ke metode yang lebih lancar atau kirim panduan bayar.`);
  }

  if (state.leads.length) {
    const pending = state.leads.filter((l) => l.status === 0).length;
    const potential = state.leads.reduce((a, l) => a + l.nominal, 0);
    out.push(`Ada <b>${num(state.leads.length)} calon pembeli</b> yang belum jadi beli (${num(pending)} masih pending) dengan potensi ${rupiahShort(potential)}. Follow-up lewat daftar di bawah — prioritaskan yang pending & paling baru.`);
  }

  const promo = success.filter((t) => t.promo_code);
  if (success.length) {
    const share = promo.length / success.length;
    const aovPromo = promo.length ? promo.reduce((a, t) => a + t.nominal, 0) / promo.length : 0;
    if (promo.length) {
      const topPromo = groupBy(promo, (t) => t.promo_code).sort((a, b) => b.success - a.success)[0];
      out.push(`${pct(share)} transaksi sukses memakai promo (rata-rata ${rupiahShort(aovPromo)} vs ${rupiahShort(s.aov)} keseluruhan). Kode terlaris: <b>${esc(topPromo.key)}</b>.`);
    } else {
      out.push('Belum ada transaksi sukses yang memakai kode promo di periode ini — pertimbangkan uji coba promo terbatas waktu untuk mendorong keputusan beli.');
    }
  }

  if (Number.isFinite(s.repeatRate)) {
    const renew = success.filter((t) => /perpanjang|upgrade/i.test(t.product_type || '')).length;
    const renewShare = success.length ? renew / success.length : 0;
    const repeatText = s.repeatRate > 0 ? `${pct(s.repeatRate)} customer membeli lebih dari sekali di periode ini; ` : '';
    out.push(`${repeatText}<b>${pct(renewShare)}</b> transaksi sukses adalah perpanjangan/upgrade dari customer lama. ${renewShare < 0.3 ? 'Peluang besar di program retensi: ingatkan customer yang masa aktifnya hampir habis untuk perpanjang.' : ''}`);
  }

  $('insights').innerHTML = out.map((x) => `<li>${x}</li>`).join('');
}

// ---------- render: charts ----------
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function chart(id, config) {
  state.charts[id]?.destroy();
  Chart.defaults.color = css('--muted');
  Chart.defaults.borderColor = css('--grid');
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  state.charts[id] = new Chart($(id), config);
}

function renderTrend(rows, range) {
  const labels = [];
  for (let d = range.start; d <= range.end; d = addDays(d, 1)) labels.push(d);
  // omzet pembanding disejajarkan per urutan hari (hari ke-1 vs hari ke-1, dst.)
  const cmpRev = new Map();
  for (const t of state.prev) if (t.status === 1) cmpRev.set(t.day, (cmpRev.get(t.day) || 0) + t.nominal);
  const cmpDays = [];
  for (let d = state.cmp.start; d <= state.cmp.end && cmpDays.length < labels.length; d = addDays(d, 1)) cmpDays.push(d);
  const by = new Map(labels.map((d) => [d, { rev: 0, ok: 0, all: 0 }]));
  for (const t of rows) {
    const g = by.get(t.day);
    if (!g) continue;
    g.all++;
    if (t.status === 1) { g.ok++; g.rev += t.nominal; }
  }
  chart('trendChart', {
    data: {
      labels: labels.map(dateLabel),
      datasets: [
        { type: 'bar', label: 'Omzet', data: labels.map((d) => by.get(d).rev), backgroundColor: css('--s1'), borderRadius: 4, yAxisID: 'y', order: 2 },
        { type: 'line', label: state.cmp.series, data: labels.map((_, i) => (cmpDays[i] ? cmpRev.get(cmpDays[i]) || 0 : null)), borderColor: css('--s7'), backgroundColor: css('--s7'), borderWidth: 2, pointRadius: labels.length > 45 ? 0 : 2, tension: 0.3, yAxisID: 'y', order: 0, cmpDays },
        { type: 'line', label: 'Transaksi sukses', data: labels.map((d) => by.get(d).ok), borderColor: css('--s3'), backgroundColor: css('--s3'), borderWidth: 2, tension: 0.3, pointRadius: labels.length > 45 ? 0 : 2, yAxisID: 'y1' },
        { type: 'line', label: 'Total checkout', data: labels.map((d) => by.get(d).all), borderColor: css('--s2'), backgroundColor: css('--s2'), borderWidth: 2, borderDash: [5, 4], pointRadius: 0, tension: 0.3, yAxisID: 'y1' },
      ],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { sort: (a, b) => a.datasetIndex - b.datasetIndex } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}${c.dataset.cmpDays ? ` (${rangeLabel(c.dataset.cmpDays[c.dataIndex], c.dataset.cmpDays[c.dataIndex])})` : ''}: ${c.dataset.yAxisID === 'y' ? rupiah(c.raw) : num(c.raw)}` } } },
      scales: {
        y: { position: 'left', ticks: { callback: (v) => rupiahShort(v) }, grid: { drawOnChartArea: true } },
        y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { precision: 0 } },
        x: { grid: { display: false } },
      },
    },
  });
}

function renderStatus(rows) {
  const counts = STATUS.map((_, i) => rows.filter((t) => t.status === i).length);
  const nominal = STATUS.map((_, i) => rows.filter((t) => t.status === i).reduce((a, t) => a + t.nominal, 0));
  const colors = [css('--warn'), css('--good'), css('--neutral'), css('--neutral'), css('--bad')];
  chart('statusChart', {
    type: 'bar',
    data: { labels: STATUS, datasets: [{ label: 'Transaksi', data: counts, backgroundColor: colors, borderRadius: 4 }] },
    options: {
      indexAxis: 'y',
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${num(c.raw)} trx (${pct(c.raw / (rows.length || 1))}) • ${rupiah(nominal[c.dataIndex])}` } },
      },
      scales: { x: { ticks: { precision: 0 } }, y: { grid: { display: false } } },
    },
  });
}

function renderPayment(rows) {
  const g = groupBy(rows, (t) => t.payment_method).sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  chart('paymentChart', {
    data: {
      labels: g.map((x) => x.key),
      datasets: [
        { type: 'bar', label: 'Omzet', data: g.map((x) => x.revenue), backgroundColor: css('--s1'), borderRadius: 4, yAxisID: 'y' },
        { type: 'line', label: 'Tingkat sukses', data: g.map((x) => x.conversion * 100), borderColor: css('--surface'), backgroundColor: css('--s2'), borderWidth: 2, showLine: false, pointRadius: 6, pointHoverRadius: 8, yAxisID: 'y1' },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { tooltip: { callbacks: { label: (c) => (c.dataset.yAxisID === 'y' ? `Omzet: ${rupiah(c.raw)}` : `Sukses: ${c.raw.toFixed(1)}% dari ${num(g[c.dataIndex].total)} trx`) } } },
      scales: {
        y: { ticks: { callback: (v) => rupiahShort(v) } },
        y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, ticks: { callback: (v) => v + '%' } },
        x: { grid: { display: false } },
      },
    },
  });
}

function renderType(rows) {
  const g = groupBy(rows, (t) => t.product_type).sort((a, b) => b.revenue - a.revenue);
  chart('typeChart', {
    type: 'bar',
    data: {
      labels: g.map((x) => x.key),
      datasets: [
        { label: 'Omzet', data: g.map((x) => x.revenue), backgroundColor: g.map((x) => css(TYPE_COLOR[x.key] || '--s7')), borderRadius: 4 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${rupiah(c.raw)} • ${num(g[c.dataIndex].success)} trx sukses • conversion ${pct(g[c.dataIndex].conversion)}` } } },
      scales: { y: { ticks: { callback: (v) => rupiahShort(v) } }, x: { grid: { display: false } } },
    },
  });
}

function renderHeatmap(rows) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const t of rows) if (t.status === 1) grid[t.dow][t.hour]++;
  const max = Math.max(1, ...grid.flat());
  const order = [1, 2, 3, 4, 5, 6, 0]; // Senin dulu
  const head = `<tr><th></th>${[...Array(24).keys()].map((h) => `<th>${h % 3 === 0 ? h : ''}</th>`).join('')}</tr>`;
  const body = order
    .map((d) => `<tr><th class="row">${DAYS[d]}</th>${grid[d]
      .map((v, h) => `<td class="cell" title="${DAYS_FULL[d]} ${String(h).padStart(2, '0')}.00 — ${v} trx sukses" style="background:color-mix(in srgb, var(--seq) ${v ? 12 + Math.round((v / max) * 88) : 5}%, var(--surface))"></td>`)
      .join('')}</tr>`)
    .join('');
  $('heatmap').innerHTML = `<table>${head}${body}</table><div class="muted" style="margin-top:6px">Makin gelap = makin banyak transaksi sukses. Arahkan kursor untuk detail.</div>`;
}

// ---------- render: tabel ----------
function table(id, cols, rows, empty = 'Tidak ada data') {
  const head = `<thead><tr>${cols.map((c) => `<th class="${c.num ? 'num' : ''}">${c.label}</th>`).join('')}</tr></thead>`;
  const body = rows.length
    ? rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''} ${c.wrap ? 'wrap' : ''} ${c.cls || ''}">${c.render(r)}</td>`).join('')}</tr>`).join('')
    : `<tr><td class="empty" colspan="${cols.length}">${empty}</td></tr>`;
  $(id).innerHTML = head + `<tbody>${body}</tbody>`;
}

function renderPlatforms(rows, prevRows, s) {
  $('platformCard').hidden = !state.allPlatforms;
  if (!state.allPlatforms) return;
  const prev = new Map(groupBy(prevRows, (t) => t.platform).map((g) => [g.key, g]));
  const g = groupBy(rows, (t) => t.platform).sort((a, b) => b.revenue - a.revenue);
  const max = Math.max(1, ...g.map((x) => x.revenue));
  $('platformCmpNote').textContent = `Pertumbuhan vs ${state.cmp.short} (${rangeLabel(state.cmp.start, state.cmp.end)})`;
  const growth = (cur, old) => {
    if (!old) return '<span class="muted">baru</span>';
    const ch = (cur - old) / old;
    return `<span class="${ch >= 0 ? 'up' : 'down'}">${ch >= 0 ? '▲' : '▼'} ${pct(Math.abs(ch))}</span>`;
  };
  table('platformTable', [
    { label: 'Platform', render: (r) => `<b>${esc(platformName(r.key))}</b>` },
    { label: 'Checkout', num: true, render: (r) => num(r.total) },
    { label: 'Sukses', num: true, render: (r) => num(r.success) },
    { label: 'Conversion', num: true, render: (r) => pct(r.conversion) },
    { label: 'Omzet', num: true, render: (r) => rupiah(r.revenue) },
    { label: `Omzet ${state.cmp.short}`, num: true, render: (r) => rupiah(prev.get(r.key)?.revenue || 0) },
    { label: 'Pertumbuhan', num: true, render: (r) => growth(r.revenue, prev.get(r.key)?.revenue) },
    { label: 'Kontribusi', render: (r) => `<div style="display:flex;gap:6px;align-items:center"><div class="bar" style="width:${Math.round((r.revenue / max) * 100)}px"></div><span class="muted">${pct(s.revenue ? r.revenue / s.revenue : 0)}</span></div>` },
  ], g);
}

function renderProducts(rows, s) {
  const g = groupBy(rows, (t) => t.product).sort((a, b) => b.revenue - a.revenue);
  const max = Math.max(1, ...g.map((x) => x.revenue));
  table('productTable', [
    { label: 'Produk', wrap: true, render: (r) => esc(r.key) },
    { label: 'Checkout', num: true, render: (r) => num(r.total) },
    { label: 'Sukses', num: true, render: (r) => num(r.success) },
    { label: 'Conversion', num: true, render: (r) => `<span class="${r.conversion < s.conversion * 0.8 ? 'down' : ''}">${pct(r.conversion)}</span>` },
    { label: 'Omzet', num: true, render: (r) => rupiah(r.revenue) },
    { label: 'Kontribusi', render: (r) => `<div style="display:flex;gap:6px;align-items:center"><div class="bar" style="width:${Math.round((r.revenue / max) * 100)}px"></div><span class="muted">${pct(s.revenue ? r.revenue / s.revenue : 0)}</span></div>` },
  ], g);
}

function renderPromos(rows) {
  const g = groupBy(rows.filter((t) => t.promo_code), (t) => t.promo_code).sort((a, b) => b.revenue - a.revenue);
  table('promoTable', [
    { label: 'Kode', render: (r) => `<b>${esc(r.key)}</b>` },
    { label: 'Dipakai', num: true, render: (r) => num(r.total) },
    { label: 'Sukses', num: true, render: (r) => `${num(r.success)} <span class="muted">(${pct(r.conversion)})</span>` },
    { label: 'Omzet', num: true, render: (r) => rupiah(r.revenue) },
    { label: 'Diskon diberikan', num: true, render: (r) => rupiah(r.rows.filter((t) => t.status === 1).reduce((a, t) => a + Math.max(0, (Number(t.product_price) || 0) - t.nominal), 0)) },
  ], g, 'Belum ada transaksi dengan kode promo');
}

function renderCustomers(rows) {
  const g = groupBy(rows.filter((t) => t.status === 1), (t) => t.custKey).sort((a, b) => b.revenue - a.revenue).slice(0, 15);
  table('customerTable', [
    { label: 'Nama', render: (r) => esc(r.rows[0].customer_name) },
    { label: 'Kontak', render: (r) => `<span class="muted">${esc(r.rows[0].customer_email || '')}</span>` },
    { label: 'Order', num: true, render: (r) => num(r.success) },
    { label: 'Total belanja', num: true, render: (r) => rupiah(r.revenue) },
  ], g);
}

// ---------- pesan WhatsApp custom ----------
// Variabel ditulis dalam kurung siku, mis. "Halo [Nama], ...". Tidak peka huruf besar/kecil.
const DEFAULT_TEMPLATE = 'Halo Kak [Nama], sebelumnya Kakak sempat memesan "[Produk]" di [Platform] namun belum selesai. Masih berminat? Kami bisa bantu proses pembayarannya 🙏';
const titleCase = (x) => String(x || '').toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (m) => m.toUpperCase()).trim();
const MSG_VARS = {
  'Nama': (t) => titleCase(String(t.customer_name || '').trim().split(/\s+/)[0]),
  'Nama Lengkap': (t) => titleCase(t.customer_name),
  'Produk': (t) => t.product || '',
  'Platform': (t) => platformName(t.platform),
  'Nominal': (t) => rupiah(t.nominal),
  'Harga': (t) => rupiah(t.product_price),
  'Status': (t) => STATUS[t.status] || '',
  'Tanggal': (t) => (t.day ? rangeLabel(t.day, t.day) : ''),
  'Metode Bayar': (t) => t.payment_method || '',
  'Promo': (t) => t.promo_code || '-',
  'Email': (t) => t.customer_email || '',
  'HP': (t) => (t.phone62 ? '+' + t.phone62 : ''),
  'Jumlah Percobaan': (t) => String(t.attempts || 1),
};
const varLookup = new Map(Object.entries(MSG_VARS).map(([k, f]) => [k.toLowerCase(), f]));
// variabel yang tidak dikenal dibiarkan apa adanya supaya salah ketik terlihat
const fillTemplate = (tpl, t) => tpl.replace(/\[([^\]]+)\]/g, (m, name) => {
  const f = varLookup.get(name.trim().toLowerCase());
  return f ? f(t) : m;
});
function loadTemplate() {
  try { return localStorage.getItem('dashsan.msgTemplate') || DEFAULT_TEMPLATE; } catch { return DEFAULT_TEMPLATE; }
}
function saveTemplate(tpl) {
  try { localStorage.setItem('dashsan.msgTemplate', tpl); } catch { /* storage tidak tersedia */ }
}
const leadMessage = (t) => fillTemplate(state.msgTemplate || DEFAULT_TEMPLATE, t);

function waLink(t) {
  if (!t.phone62) return '';
  return `https://wa.me/${t.phone62}?text=${encodeURIComponent(leadMessage(t))}`;
}

function renderMsgPreview() {
  const sample = state.leads[0];
  const tpl = $('msgTemplate').value;
  $('msgPreview').textContent = sample ? fillTemplate(tpl, sample) : '(belum ada customer di daftar)';
  const unknown = [...tpl.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]).filter((n) => !varLookup.has(n.trim().toLowerCase()));
  const dirty = tpl !== state.msgTemplate;
  $('msgStatus').textContent = unknown.length
    ? `Variabel tidak dikenal: ${[...new Set(unknown)].map((n) => `[${n}]`).join(', ')}`
    : dirty ? 'Ada perubahan — klik "Buat pesan untuk semua" untuk menerapkan.' : `Pesan sudah dibuat untuk ${num(state.leads.length)} customer.`;
  $('msgStatus').className = unknown.length ? 'down' : 'muted';
}

function setupMsgEditor() {
  state.msgTemplate = loadTemplate();
  const box = $('msgTemplate');
  box.value = state.msgTemplate;
  $('msgVars').innerHTML = '<span class="muted">Variabel:</span>' + Object.keys(MSG_VARS).map((k) => `<button type="button" class="chip" data-var="[${k}]">[${k}]</button>`).join('');
  $('msgVars').addEventListener('click', (e) => {
    const v = e.target.closest('.chip')?.dataset.var;
    if (!v) return;
    const { selectionStart: a, selectionEnd: b, value } = box;
    box.value = value.slice(0, a) + v + value.slice(b);
    box.focus();
    box.selectionStart = box.selectionEnd = a + v.length;
    renderMsgPreview();
  });
  box.addEventListener('input', renderMsgPreview);
  $('applyMsg').addEventListener('click', () => {
    state.msgTemplate = box.value.trim() || DEFAULT_TEMPLATE;
    box.value = state.msgTemplate;
    saveTemplate(state.msgTemplate);
    renderLeads();
  });
  $('resetMsg').addEventListener('click', () => {
    box.value = DEFAULT_TEMPLATE;
    renderMsgPreview();
  });
}

const platformCol = () => (state.allPlatforms ? [{ label: 'Platform', render: (r) => esc(platformName(r.platform)) }] : []);

function renderLeads() {
  renderMsgPreview();
  const checkedUntil = state.config.today;
  $('leadNote').textContent = `${num(state.leads.length)} orang unik belum beli • dicek sampai ${rangeLabel(checkedUntil, checkedUntil)}` +
    (state.leadsConverted ? ` • ${num(state.leadsConverted)} orang dikeluarkan karena sudah beli` : '');
  table('leadTable', [
    { label: 'Status', render: (r) => `<span class="pill s${r.status}">${STATUS[r.status]}</span>` },
    { label: 'Terakhir', render: (r) => esc(r.date) },
    ...platformCol(),
    { label: 'Nama', render: (r) => esc(r.customer_name) },
    { label: 'Produk', wrap: true, render: (r) => esc(r.product) + (r.products.length > 1 ? ` <span class="muted">(+${r.products.length - 1} produk lain)</span>` : '') },
    { label: 'Nominal', num: true, render: (r) => rupiah(r.nominal) },
    { label: 'Percobaan', num: true, render: (r) => num(r.attempts) },
    { label: 'Bayar via', render: (r) => esc(r.payment_method) },
    { label: 'Kontak', render: (r) => (r.phone62 ? `<a class="wa" href="${esc(waLink(r))}" target="_blank" rel="noopener">WhatsApp</a> <span class="muted">${esc(r.customer_email || '')}</span>` : esc(r.customer_email || '')) },
    { label: 'Pesan', render: (r) => `<span title="${esc(leadMessage(r))}">${esc(leadMessage(r).slice(0, 90))}${leadMessage(r).length > 90 ? '…' : ''}</span>`, cls: 'msg' },
  ], state.leads.slice(0, 100), 'Semua checkout sudah jadi transaksi sukses 🎉');
  if (state.leads.length > 100) {
    $('leadTable').insertAdjacentHTML('beforeend', `<tfoot><tr><td colspan="12" class="muted">Menampilkan 100 dari ${num(state.leads.length)} — export CSV untuk daftar lengkap.</td></tr></tfoot>`);
  }
}

function filteredTrx() {
  const q = $('search').value.trim().toLowerCase();
  const st = $('statusFilter').value;
  return state.trx.filter((t) =>
    (st === '' || String(t.status) === st) &&
    (!q || [t.trx_id, t.customer_name, t.customer_email, t.customer_phone, t.product, t.promo_code, t.payment_method].some((v) => String(v ?? '').toLowerCase().includes(q))));
}

function renderTrxTable() {
  const rows = filteredTrx().sort((a, b) => b.closingAt.localeCompare(a.closingAt));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages - 1);
  table('trxTable', [
    { label: 'Trx ID', render: (r) => esc(r.trx_id) },
    { label: 'Dibuat', render: (r) => esc(r.date) },
    { label: 'Dibayar', render: (r) => esc(r.paid_date || '–') },
    ...platformCol(),
    { label: 'Customer', render: (r) => esc(r.customer_name) },
    { label: 'Produk', wrap: true, render: (r) => esc(r.product) },
    { label: 'Tipe', render: (r) => esc(r.product_type) },
    { label: 'Bayar', render: (r) => esc(r.payment_method) },
    { label: 'Promo', render: (r) => esc(r.promo_code || '–') },
    { label: 'Nominal', num: true, render: (r) => rupiah(r.nominal) },
    { label: 'Status', render: (r) => `<span class="pill s${r.status}">${esc(r.status_message || STATUS[r.status])}</span>` },
  ], rows.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE));
  $('pageInfo').textContent = `Hal ${state.page + 1} / ${pages} • ${num(rows.length)} transaksi`;
  $('prevPage').disabled = state.page === 0;
  $('nextPage').disabled = state.page >= pages - 1;
}

// ---------- export ----------
function downloadCsv(name, rows, cols) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = '﻿' + [cols.map((c) => c[0]).join(','), ...rows.map((r) => cols.map((c) => cell(c[1](r))).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
const TRX_COLS = [
  ['platform', (r) => r.platform], ['trx_id', (r) => r.trx_id], ['tanggal', (r) => r.date], ['tanggal_bayar', (r) => r.paid_date], ['customer', (r) => r.customer_name],
  ['hp', (r) => r.phone62], ['email', (r) => r.customer_email], ['produk', (r) => r.product], ['tipe', (r) => r.product_type],
  ['metode_bayar', (r) => r.payment_method], ['promo', (r) => r.promo_code], ['harga', (r) => r.product_price], ['nominal', (r) => r.nominal],
  ['status', (r) => STATUS[r.status]],
];

// ---------- load ----------
async function fetchRange(platform, start, end, status = '') {
  const qs = new URLSearchParams({ platform, start_date: start, end_date: end });
  if (status !== '') qs.set('status', status);
  const res = await fetch(apiUrl(`/api/transactions?${qs}`));
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.status) throw new Error(body.message || `Gagal memuat data (HTTP ${res.status})`);
  return body;
}

async function load() {
  const platform = $('platform').value;
  const [start, end] = presetRange($('preset').value, state.config.today);
  if (!start || !end || end < start) {
    showError('Rentang tanggal tidak valid.');
    return;
  }
  const days = daysBetween(start, end);
  const range = { start, end, days };
  const cmp = compareRange($('compare').value, start, end);

  $('loading').hidden = false;
  $('errorBanner').hidden = true;
  try {
    // transaksi sukses sesudah periode s/d hari ini, untuk mengecek apakah calon pembeli akhirnya jadi beli
    const today = state.config.today;
    const laterReq = end < today ? fetchRange(platform, addDays(end, 1), today, '1') : Promise.resolve({ data: [] });
    const [cur, prev, later] = await Promise.all([fetchRange(platform, start, end), fetchRange(platform, cmp.start, cmp.end).catch(() => ({ data: [] })), laterReq]);
    state.later = later.data.map(normalize);
    state.cmp = cmp;
    state.allPlatforms = platform === 'all';
    state.trx = cur.data.map(normalize);
    state.prev = prev.data.map(normalize);
    state.page = 0;
    $('demoBanner').hidden = !cur.demo;
    $('lastUpdated').textContent = `${platformName(platform)} • ${rangeLabel(start, end)} vs ${rangeLabel(cmp.start, cmp.end)} • diperbarui ${new Date(cur.fetched_at).toLocaleTimeString('id-ID')}`;
    if (cur.warnings?.length) showError(`Perhatian, sebagian data tidak lengkap: ${cur.warnings.join("; ")}. Angka di bawah tidak termasuk data tersebut.`);
    saveFilters();
    render(range);
  } catch (err) {
    showError(err.message);
  } finally {
    $('loading').hidden = true;
  }
}

function render(range) {
  const s = summarize(state.trx);
  const p = summarize(state.prev);
  const { leads, converted } = buildLeads(state.trx, state.later);
  state.leads = leads;
  state.leadsConverted = converted;
  renderKpis(s, p);
  renderInsights(state.trx, s, p, range);
  renderPlatforms(state.trx, state.prev, s);
  renderTrend(state.trx, range);
  renderStatus(state.trx);
  renderPayment(state.trx);
  renderType(state.trx);
  renderHeatmap(state.trx);
  renderProducts(state.trx, s);
  renderPromos(state.trx);
  renderCustomers(state.trx);
  renderLeads();
  renderTrxTable();
}

function showError(msg) {
  $('errorBanner').textContent = msg;
  $('errorBanner').hidden = false;
}

function saveFilters() {
  try {
    localStorage.setItem('dashsan.filters', JSON.stringify({ platform: $('platform').value, compare: $('compare').value, preset: $('preset').value, start: $('startDate').value, end: $('endDate').value }));
  } catch { /* storage tidak tersedia */ }
}
function restoreFilters() {
  try {
    const f = JSON.parse(localStorage.getItem('dashsan.filters') || 'null');
    if (!f) return;
    if ([...$('platform').options].some((o) => o.value === f.platform)) $('platform').value = f.platform;
    if (['yoy', 'prev'].includes(f.compare)) $('compare').value = f.compare;
    $('preset').value = f.preset || '30';
    $('startDate').value = f.start || '';
    $('endDate').value = f.end || '';
  } catch { /* abaikan */ }
}

// ---------- init ----------
async function init() {
  state.config = await fetch(apiUrl('/api/config')).then((r) => r.json());
  for (const p of state.config.platforms || []) $('platform').add(new Option(p.name, p.slug));
  setupMsgEditor();
  $('platform').value = state.config.defaultPlatform;
  $('endDate').value = state.config.today;
  $('startDate').value = addDays(state.config.today, -29);
  restoreFilters();
  const syncCustom = () => $('filters').classList.toggle('custom', $('preset').value === 'custom');
  syncCustom();

  // label opsi "Periode sebelumnya" ikut panjang periode, mis. "7 hari sebelumnya"
  const syncCompareLabel = () => {
    const [a, b] = presetRange($('preset').value, state.config.today);
    if (a && b && b >= a) $('compare').options[1].text = `${daysBetween(a, b)} hari sebelumnya`;
  };
  syncCompareLabel();
  $('preset').addEventListener('change', () => { syncCustom(); syncCompareLabel(); if ($('preset').value !== 'custom') load(); });
  $('startDate').addEventListener('change', syncCompareLabel);
  $('endDate').addEventListener('change', syncCompareLabel);
  $('platform').addEventListener('change', load);
  $('compare').addEventListener('change', load);
  $('filters').addEventListener('submit', (e) => { e.preventDefault(); load(); });
  $('search').addEventListener('input', () => { state.page = 0; renderTrxTable(); });
  $('statusFilter').addEventListener('change', () => { state.page = 0; renderTrxTable(); });
  $('prevPage').addEventListener('click', () => { state.page--; renderTrxTable(); });
  $('nextPage').addEventListener('click', () => { state.page++; renderTrxTable(); });
  $('exportTrx').addEventListener('click', () => downloadCsv('transaksi.csv', filteredTrx(), TRX_COLS));
  $('exportLeads').addEventListener('click', () => downloadCsv('follow-up-sales.csv', state.leads, [...TRX_COLS, ['jumlah_percobaan', (r) => r.attempts], ['percobaan_pertama', (r) => r.firstDate], ['semua_produk_dicoba', (r) => r.products.join(' | ')], ['pesan', leadMessage], ['link_whatsapp', waLink]]));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.trx.length && load());

  load();
}

init().catch((e) => showError(e.message));
