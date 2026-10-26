// Insight gabungan untuk grup "All": overview, sales per platform, pending/expired, target bulanan.
// Total per bulan (bulan lalu, tahun ini, tahun lalu) dihitung sekali lalu disimpan di state.monthAgg,
// jadi tiap pengiriman hanya mengambil data bulan berjalan.

const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

// Target bulanan awal (dari template tim); bisa diubah di menu Agent Tele → Target Bulanan
export const DEFAULT_TARGETS = {
  jadiasn: 310000000, jadiprajurit: 60000000, jadibumn: 150000000, jadipolisi: 45000000,
  toeflacademy: 30000000, jagotpa: 20000000, cerebrum: 65000000, jadisekdin: 20000000,
  psikoteskerja: 25000000, jadibeasiswa: 10000000, jadiojk: 10000000, jadipppk: 40000000,
  jadipcpm: 10500000, jadippg: 500000,
};

// ---------- util ----------
const wibNow = () => new Date(Date.now() + 7 * 3600000);
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => ymd(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000));
const monthKey = (s) => s.slice(0, 7);
const monthStart = (key) => `${key}-01`;
const monthEnd = (key) => { const [y, m] = key.split('-').map(Number); return ymd(new Date(Date.UTC(y, m, 0))); };
const prevMonth = (key) => { const [y, m] = key.split('-').map(Number); return ymd(new Date(Date.UTC(y, m - 2, 1))).slice(0, 7); };
const ok = (t) => Number(t.status) === 1;
const closingTime = (t) => String(ok(t) && /^\d{4}-/.test(String(t.paid_date)) ? t.paid_date : t.date).slice(11, 19);
const personKey = (t) => String(t.customer_phone || '').replace(/\D/g, '').replace(/^(62|0)/, '') || String(t.customer_email || '').toLowerCase();
const sumNom = (rows) => rows.reduce((a, t) => a + (Number(t.nominal) || 0), 0);

// format sesuai template tim: Rp.1,552,000 dan [3,007,800 ▼48%]
const num = (n) => Math.round(n || 0).toLocaleString('en-US');
const rp = (n) => `Rp.${num(n)}`;
function arrow(cur, prev) {
  if (!prev) return cur ? ' ▲' : '';
  const ch = ((cur - prev) / prev) * 100;
  const p = Math.abs(ch) >= 10 ? Math.round(Math.abs(ch)) : Math.round(Math.abs(ch) * 10) / 10;
  return ` ${ch >= 0 ? '▲' : '▼'}${p}%`;
}
const cmp = (cur, prev) => `[${num(prev)}${arrow(cur, prev)}]`;
const pctOf = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '–');

// ---------- total per bulan (disimpan) ----------
function neededMonths(today) {
  const y = Number(today.slice(0, 4));
  const cur = monthKey(today);
  const out = [];
  for (let m = 1; m <= 12; m++) out.push(`${y - 1}-${String(m).padStart(2, '0')}`);
  for (let k = `${y}-01`; k < cur; k = ymd(new Date(Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)), 1))).slice(0, 7)) out.push(k);
  return out;
}

export function monthProgress(state, platforms) {
  const today = ymd(wibNow());
  const months = neededMonths(today);
  const agg = state.monthAgg || {};
  const total = months.length * platforms.length;
  const done = months.reduce((a, m) => a + platforms.filter((p) => agg[`${p.slug}|${m}`]?.byDay).length, 0);
  return { done, total };
}

// Hitung bulan yang belum tersimpan, paling baru dulu (bulan lalu penting untuk target), sampai batas waktu
export async function warmMonths(deps, state, { budgetMs = 45000 } = {}) {
  const t0 = Date.now();
  state.monthAgg ||= {};
  const today = ymd(wibNow());
  const months = neededMonths(today).reverse();
  const queue = [];
  for (const m of months) for (const p of deps.PLATFORMS) if (!state.monthAgg[`${p.slug}|${m}`]?.byDay) queue.push([p.slug, m]);
  while (queue.length && Date.now() - t0 < budgetMs) {
    const batch = queue.splice(0, 3);
    await Promise.all(batch.map(async ([slug, m]) => {
      try {
        const { rows, warnings } = await deps.getTransactions(slug, monthStart(m), monthEnd(m), '1');
        const s = rows.filter(ok);
        // omzet per tanggal, untuk banding "bulan lalu s/d tanggal yang sama"
        const byDay = Array(31).fill(0);
        for (const t of s) byDay[Number(t.closing_date.slice(8, 10)) - 1] += Number(t.nominal) || 0;
        state.monthAgg[`${slug}|${m}`] = { omzet: sumNom(s), sukses: s.length, users: new Set(s.map(personKey).filter(Boolean)).size, byDay, partial: warnings.length > 0 };
      } catch (err) {
        console.error('[monthAgg]', slug, m, err.message);
      }
    }));
  }
  return monthProgress(state, deps.PLATFORMS);
}

// ---------- fakta untuk grup All ----------
export async function buildAllFacts(deps, state) {
  const now = wibNow();
  const today = ymd(now);
  const cutoff = now.toISOString().slice(11, 19);
  const yesterday = addDays(today, -1);
  const mk = monthKey(today);
  const start = monthStart(mk) < yesterday ? monthStart(mk) : yesterday;
  const lastMonth = prevMonth(mk);
  const year = today.slice(0, 4);
  const lastYear = String(Number(year) - 1);
  const agg = state.monthAgg || {};
  const d = Number(today.slice(8, 10));
  const targets = { ...DEFAULT_TARGETS, ...(state.targets || {}) };

  const rows = [];
  const warnings = [];
  const slugs = deps.PLATFORMS.map((p) => p.slug);
  // tanggal yang sama di bulan lalu (null bila bulan lalu lebih pendek → pakai total bulan lalu)
  const lmLastDay = Number(monthEnd(lastMonth).slice(8, 10));
  const lmSameDay = d <= lmLastDay ? `${lastMonth}-${String(d).padStart(2, '0')}` : null;
  const lmRows = [];
  for (let i = 0; i < slugs.length; i += 3) {
    const res = await Promise.allSettled(slugs.slice(i, i + 3).map((s) => deps.getTransactions(s, start, today, '')));
    res.forEach((r, j) => {
      if (r.status === 'fulfilled') { rows.push(...r.value.rows); warnings.push(...r.value.warnings); } else warnings.push(`${slugs[i + j]}: ${r.reason?.message}`);
    });
    if (lmSameDay) {
      const lm = await Promise.allSettled(slugs.slice(i, i + 3).map((s) => deps.getTransactions(s, lmSameDay, lmSameDay, '1')));
      lm.forEach((r) => { if (r.status === 'fulfilled') lmRows.push(...r.value.rows); });
    }
  }
  const upToNow = (t) => closingTime(t) <= cutoff;
  const users = (list) => new Set(list.filter(ok).map(personKey).filter(Boolean)).size;
  const monthSum = (slug, keys) => {
    const vals = keys.map((k) => agg[`${slug}|${k}`]);
    return vals.every(Boolean) ? vals.reduce((a, v) => a + v.omzet, 0) : null;
  };
  const yearMonths = neededMonths(today).filter((k) => k.startsWith(year));
  const lastYearMonths = neededMonths(today).filter((k) => k.startsWith(lastYear));

  const platforms = deps.PLATFORMS.map(({ slug, name }) => {
    const r = rows.filter((t) => t.platform === slug);
    const t0 = r.filter((t) => t.closing_date === today);
    const y0 = r.filter((t) => t.closing_date === yesterday);
    const yNow = y0.filter(upToNow);
    const mtd = sumNom(r.filter((t) => ok(t) && t.closing_date >= monthStart(mk)));
    const ytdPast = monthSum(slug, yearMonths);
    return {
      slug, name,
      hari_ini: sumNom(t0.filter(ok)),
      kemarin_jam_sama: sumNom(yNow.filter(ok)),
      kemarin_full: sumNom(y0.filter(ok)),
      pending: { hari_ini: t0.filter((t) => Number(t.status) === 0), kemarin: yNow.filter((t) => Number(t.status) === 0) },
      expired: { hari_ini: t0.filter((t) => Number(t.status) === 2), kemarin: yNow.filter((t) => Number(t.status) === 2) },
      gagal: { hari_ini: sumNom(t0.filter((t) => Number(t.status) === 4)), kemarin: sumNom(yNow.filter((t) => Number(t.status) === 4)) },
      bulan_ini: mtd,
      bulan_lalu: agg[`${slug}|${lastMonth}`]?.omzet ?? null,
      // bulan lalu: tgl 1 s/d kemarin-nya tanggal ini (penuh) + tanggal yang sama sampai jam sekarang
      bulan_lalu_sama_periode: !agg[`${slug}|${lastMonth}`]?.byDay ? null
        : !lmSameDay ? agg[`${slug}|${lastMonth}`].omzet
        : agg[`${slug}|${lastMonth}`].byDay.slice(0, d - 1).reduce((a, v) => a + v, 0) + sumNom(lmRows.filter((t) => t.platform === slug && ok(t) && closingTime(t) <= cutoff)),
      tahun_ini: ytdPast == null ? null : ytdPast + mtd,
      tahun_lalu: monthSum(slug, lastYearMonths),
      target: Number(targets[slug]) || 0,
    };
  });
  const all = rows;
  const tAll = all.filter((t) => t.closing_date === today);
  const yAll = all.filter((t) => t.closing_date === yesterday);
  const sum = (f) => platforms.reduce((a, p) => a + (f(p) ?? 0), 0);
  const nullIfAny = (f) => (platforms.some((p) => f(p) == null) ? null : sum(f));
  const [y, m] = today.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const nowDate = new Date(Date.UTC(y, m - 1, d));
  return {
    kind: 'all',
    waktu: `${today} ${cutoff.slice(0, 5)} WIB`,
    tanggal: `${HARI[nowDate.getUTCDay()]}, ${d} ${BULAN[m - 1]}`,
    jam: cutoff.slice(0, 5).replace(':', '.'),
    jamNum: Number(cutoff.slice(0, 2)),
    platforms,
    total: {
      hari_ini: sum((p) => p.hari_ini),
      kemarin_jam_sama: sum((p) => p.kemarin_jam_sama),
      kemarin_full: sum((p) => p.kemarin_full),
      pending: sum((p) => sumNom(p.pending.hari_ini)),
      pending_kemarin: sum((p) => sumNom(p.pending.kemarin)),
      gagal: sum((p) => p.gagal.hari_ini),
      gagal_kemarin: sum((p) => p.gagal.kemarin),
      bulan_ini: sum((p) => p.bulan_ini),
      bulan_lalu: nullIfAny((p) => p.bulan_lalu),
      bulan_lalu_sama_periode: nullIfAny((p) => p.bulan_lalu_sama_periode),
      tahun_ini: nullIfAny((p) => p.tahun_ini),
      tahun_lalu: nullIfAny((p) => p.tahun_lalu),
      user_hari_ini: users(tAll),
      user_kemarin_jam_sama: users(yAll.filter(upToNow)),
      user_bulan_ini: users(all.filter((t) => t.closing_date >= monthStart(mk))),
      target: sum((p) => p.target),
    },
    sisa_hari: daysInMonth - d + 1, // termasuk hari ini
    data_lengkap: monthProgress(state, deps.PLATFORMS),
    peringatan_data: warnings,
  };
}

// ---------- isi pesan ----------
function blocks(f) {
  const t = f.total;
  const byToday = [...f.platforms].sort((a, b) => b.hari_ini - a.hari_ini || b.kemarin_jam_sama - a.kemarin_jam_sama);
  const byMonth = [...f.platforms].filter((p) => p.target || p.bulan_ini).sort((a, b) => b.bulan_ini - a.bulan_ini);
  const statusList = (key) => {
    const list = f.platforms.filter((p) => p[key].hari_ini.length || p[key].kemarin.length).sort((a, b) => b[key].hari_ini.length - a[key].hari_ini.length);
    return list.length
      ? list.map((p) => `• ${p.name}: ${p[key].hari_ini.length} trx (${rp(sumNom(p[key].hari_ini))}) [${p[key].kemarin.length}]`).join('\n')
      : '• Tidak ada';
  };
  const kurang = Math.max(0, t.target - t.bulan_ini);
  const perHari = f.sisa_hari ? kurang / f.sisa_hari : 0;
  const bln = (v) => (v == null ? '…' : num(v));
  return {
    sales: byToday.map((p, i) => `${i + 1}. ${p.name}: ${rp(p.hari_ini)} ${cmp(p.hari_ini, p.kemarin_jam_sama)}`).join('\n'),
    pending: statusList('pending'),
    expired: statusList('expired'),
    target: byMonth.map((p, i) => `${i + 1}. ${p.name}:\n${rp(p.bulan_ini)} [${bln(p.bulan_lalu_sama_periode)}] / ${num(p.target)} (${pctOf(p.bulan_ini, p.target)})`).join('\n'),
    kurang,
    perHari,
    semangat: !t.target ? ''
      : kurang <= 0 ? 'Target bulan ini sudah tercapai 🎉 Mantap gaes, lanjut tambah bonusnya!'
      : `Semangat gaes kita punya waktu ${f.sisa_hari} hari, cukup ${num(perHari)} / hari supaya target tercapai 🤩`,
  };
}

export function allTemplateMessage(f) {
  const t = f.total;
  const b = blocks(f);
  const bln = (v) => (v == null ? '(data masih dihitung)' : `[${num(v)}]`);
  const lines = [
    '📊 <b>Update All Platform</b>',
    `${f.tanggal} • ${f.jam} WIB`,
    '',
    '<b>OVERVIEW</b>',
    `Hari ini: <b>${rp(t.hari_ini)}</b> ${cmp(t.hari_ini, t.kemarin_jam_sama)}`,
    `  - Total Kemarin: ${rp(t.kemarin_full)}`,
    `  - Pending hari ini: ${rp(t.pending)} ${cmp(t.pending, t.pending_kemarin)}`,
    `  - Gagal hari ini: ${rp(t.gagal)} ${cmp(t.gagal, t.gagal_kemarin)}`,
    `Bulan ini: <b>${rp(t.bulan_ini)}</b> ${bln(t.bulan_lalu)}`,
    `Tahun ini: <b>${t.tahun_ini == null ? '(data masih dihitung)' : rp(t.tahun_ini)}</b> ${t.tahun_ini == null ? '' : bln(t.tahun_lalu)}`.trimEnd(),
    `User hari/bulan: ${num(t.user_hari_ini)} / ${num(t.user_bulan_ini)} ${cmp(t.user_hari_ini, t.user_kemarin_jam_sama)}`,
    '',
    '<b>SALES HARI INI</b>',
    `Total: <b>${rp(t.hari_ini)}</b> ${cmp(t.hari_ini, t.kemarin_jam_sama)}`,
    `Total Kemarin: ${rp(t.kemarin_full)}`,
    b.sales,
    '',
    '<b>PENDING HARI INI</b> [kemarin jam sama]',
    b.pending,
    '',
    '<b>EXPIRED HARI INI</b> [kemarin jam sama]',
    b.expired,
  ];
  if (t.target) {
    lines.push('', '<b>TARGET BULANAN</b> [bulan lalu s/d tgl sama]', b.target, `Total: ${num(t.bulan_ini)} ${bln(t.bulan_lalu_sama_periode)}`, `Target: ${num(t.target)} (${pctOf(t.bulan_ini, t.target)})`, b.semangat);
  }
  lines.push('', '<i>[angka] = pembanding kemarin di jam yang sama. Bulan/Tahun ini = total bulan/tahun lalu.</i>');
  return lines.join('\n');
}

// ---------- variabel untuk template custom grup All ----------
export const ALL_VARS = [
  ['tanggal', 'Hari & tanggal'],
  ['jam', 'Jam data'],
  ['hari_ini', 'Omzet semua platform hari ini'],
  ['hari_ini_vs', 'Pembanding kemarin jam sama, mis. [3,007,800 ▼48%]'],
  ['total_kemarin', 'Omzet kemarin satu hari penuh'],
  ['pending_hari_ini', 'Nominal pending hari ini'],
  ['pending_vs', 'Pembanding pending kemarin jam sama'],
  ['gagal_hari_ini', 'Nominal gagal hari ini'],
  ['gagal_vs', 'Pembanding gagal kemarin jam sama'],
  ['bulan_ini', 'Omzet bulan ini (berjalan)'],
  ['bulan_lalu', 'Total omzet bulan lalu'],
  ['bulan_lalu_sama_periode', 'Omzet bulan lalu s/d tanggal yang sama'],
  ['tahun_ini', 'Omzet tahun ini (berjalan)'],
  ['tahun_lalu', 'Total omzet tahun lalu'],
  ['user_hari_ini', 'Pembeli unik hari ini'],
  ['user_bulan_ini', 'Pembeli unik bulan ini'],
  ['user_vs', 'Pembanding pembeli kemarin jam sama'],
  ['sales_per_platform', 'Daftar omzet hari ini per platform (beberapa baris)'],
  ['pending_per_platform', 'Daftar transaksi pending per platform'],
  ['expired_per_platform', 'Daftar transaksi expired per platform'],
  ['target_per_platform', 'Daftar progres target bulanan per platform'],
  ['total_target', 'Total target bulan ini'],
  ['target_persen', 'Persen tercapai dari target'],
  ['kurang_target', 'Sisa omzet untuk capai target'],
  ['sisa_hari', 'Sisa hari bulan ini (termasuk hari ini)'],
  ['kebutuhan_per_hari', 'Omzet per hari yang dibutuhkan'],
  ['semangat_target', 'Kalimat penyemangat target'],
  ['ringkasan_all', 'Isi template otomatis All lengkap'],
];

export const DEFAULT_ALL_CUSTOM = `📊 *Update All Platform*
[tanggal] • [jam] WIB

*OVERVIEW*
Hari ini: *[hari_ini]* [hari_ini_vs]
  - Total Kemarin: [total_kemarin]
  - Pending hari ini: [pending_hari_ini] [pending_vs]
  - Gagal hari ini: [gagal_hari_ini] [gagal_vs]
Bulan ini: *[bulan_ini]* [[bulan_lalu]]
Tahun ini: *[tahun_ini]* [[tahun_lalu]]
User hari/bulan: [user_hari_ini] / [user_bulan_ini] [user_vs]

*SALES HARI INI*
[sales_per_platform]

*TARGET BULANAN*
[target_per_platform]
Target: [total_target] ([target_persen])
[semangat_target]`;

export function allVars(f) {
  const t = f.total;
  const b = blocks(f);
  const v = (x) => (x == null ? '…' : num(x));
  return {
    tanggal: f.tanggal,
    jam: f.jam,
    hari_ini: rp(t.hari_ini),
    hari_ini_vs: cmp(t.hari_ini, t.kemarin_jam_sama),
    total_kemarin: rp(t.kemarin_full),
    pending_hari_ini: rp(t.pending),
    pending_vs: cmp(t.pending, t.pending_kemarin),
    gagal_hari_ini: rp(t.gagal),
    gagal_vs: cmp(t.gagal, t.gagal_kemarin),
    bulan_ini: rp(t.bulan_ini),
    bulan_lalu: v(t.bulan_lalu),
    bulan_lalu_sama_periode: v(t.bulan_lalu_sama_periode),
    tahun_ini: t.tahun_ini == null ? '(dihitung…)' : rp(t.tahun_ini),
    tahun_lalu: v(t.tahun_lalu),
    user_hari_ini: num(t.user_hari_ini),
    user_bulan_ini: num(t.user_bulan_ini),
    user_vs: cmp(t.user_hari_ini, t.user_kemarin_jam_sama),
    sales_per_platform: b.sales,
    pending_per_platform: b.pending,
    expired_per_platform: b.expired,
    target_per_platform: b.target,
    total_target: num(t.target),
    target_persen: pctOf(t.bulan_ini, t.target),
    kurang_target: num(b.kurang),
    sisa_hari: String(f.sisa_hari),
    kebutuhan_per_hari: num(b.perHari),
    semangat_target: b.semangat,
    ringkasan_all: allTemplateMessage(f),
  };
}
