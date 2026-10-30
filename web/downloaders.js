import { fetchDownloaderRange } from './downloader-data.js';

export function compareDownloaderCounts(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return '—';
  if (previous === 0) return current === 0 ? 'Tidak berubah (0)' : `Bertambah ${current.toLocaleString('id-ID')} (pembanding 0)`;
  const change = (current - previous) / previous * 100;
  return `${change > 0 ? '▲' : change < 0 ? '▼' : '•'} ${Math.abs(change).toLocaleString('id-ID', { maximumFractionDigits: 1 })}%`;
}

export function createDownloaderPanel({ chart, downloadCsv, dateLabel, rangeLabel, num, esc, apiUrl, onUpdate = () => {} }) {
  const $ = (id) => document.getElementById(id);
  let controller;
  let snapshot;
  let latest;

  const count = (value) => Number.isFinite(value) ? num(value) : '—';
  function renderKpi(view, current, previous, loading = false) {
    const total = completeTotal(current);
    const prevTotal = completeTotal(previous);
    const label = view.daily ? 'Downloader harian' : 'Total downloader';
    const period = view.daily ? dateLabel(view.range.start) : rangeLabel(view.range.start, view.range.end);
    let delta = '<span class="muted">Data belum tersedia/lengkap</span>';
    if (loading) delta = '<span class="muted">Sedang memuat…</span>';
    else if (total !== null && prevTotal === null) delta = '<span class="muted">Pembanding belum tersedia/lengkap</span>';
    else if (total !== null) {
      const direction = total > prevTotal ? 'up' : total < prevTotal ? 'down' : '';
      delta = `<span class="${direction}">${esc(compareDownloaderCounts(total, prevTotal))}</span> <span class="muted">vs ${esc(view.compare.short)} (${esc(count(prevTotal))})</span>`;
    }
    $('downloaderKpi').innerHTML = `<div class="kpi" style="--kc: var(--s4)"><div class="label">${esc(label)}</div><div class="value">${loading ? '…' : esc(count(total))}</div><div class="delta">${delta}</div><div class="muted">${esc(period)}</div></div>`;
    onUpdate({ view, current, previous, loading });
  }
  const completeTotal = (result) => result?.summary?.complete ? result.summary.total : null;

  async function request(platform, range, signal) {
    return fetchDownloaderRange({ apiUrl, platform, range, signal, onProgress: (days) => {
      if (!signal.aborted) $('downloaderStatus').textContent = `Mengambil downloader ${platform === 'all' ? 'semua platform' : ''}… ${days} hari untuk rentang ${range.start}–${range.end}.`;
    } });
  }

  function render(results, view) {
    const current = results[0].status === 'fulfilled' ? results[0].value : null;
    const previous = results[1].status === 'fulfilled' ? results[1].value : null;
    latest = { current, previous, view };
    const rows = current?.data || [];
    renderKpi(view, current, previous);

    const warnings = results.flatMap((result, i) => result.status === 'rejected'
      ? [`${i ? 'Pembanding' : 'Periode terpilih'}: ${result.reason.message}`]
      : result.value.warnings.map((message) => `${i ? 'Pembanding' : 'Periode terpilih'}: ${message}`));
    $('downloaderWarning').textContent = warnings.join(' ');
    $('downloaderWarning').hidden = warnings.length === 0;
    $('downloaderStatus').textContent = current
      ? `${current.demo ? 'Data contoh • ' : ''}${current.summary.complete ? 'Data lengkap' : `Tercatat sementara ${num(current.summary.known_total)} downloader; total belum lengkap`} • ${view.platformLabel}`
      : 'Data downloader tidak tersedia. Data sales tetap ditampilkan.';

    const days = [];
    for (let date = view.range.start; date <= view.range.end; date = nextDay(date)) days.push(date);
    const currentByDay = new Map(rows.map((row) => [row.date, row]));
    const previousRows = previous?.data || [];
    const displayRows = days.map((date, i) => ({ date, current: currentByDay.get(date), previous: previousRows[i] }));
    const detail = (row) => row?.total === null
      ? `Tidak lengkap (${num(row.known_total)} tercatat; ${row.missing_platforms.map((slug) => view.platformNames[slug] || slug).join(', ')} belum dimuat)`
      : count(row?.total);
    $('downloaderTable').innerHTML = `<thead><tr><th>Tanggal</th><th class="num">Downloader</th><th>Tanggal pembanding</th><th class="num">Downloader pembanding</th><th>Perubahan</th></tr></thead><tbody>${displayRows.map((row) => `<tr><td>${esc(dateLabel(row.date))}</td><td class="num">${esc(detail(row.current))}</td><td>${row.previous ? esc(dateLabel(row.previous.date)) : '—'}</td><td class="num">${esc(detail(row.previous))}</td><td>${esc(compareDownloaderCounts(row.current?.total, row.previous?.total))}</td></tr>`).join('')}</tbody>`;
    $('exportDownloaders').disabled = !current;
    $('downloaderChartWrap').hidden = !rows.length;
    if (rows.length) chart('downloaderChart', {
      type: 'line',
      data: {
        labels: days.map(dateLabel),
        datasets: [
          { label: 'Downloader', data: displayRows.map((row) => row.current?.total ?? null), borderColor: color('--s3'), backgroundColor: color('--s3'), borderWidth: 2, tension: 0.2, pointRadius: days.length > 45 ? 0 : 2, spanGaps: false },
          { label: `Downloader ${view.compare.short}`, data: displayRows.map((row) => row.previous?.total ?? null), borderColor: color('--s7'), backgroundColor: color('--s7'), borderWidth: 2, borderDash: [5, 4], tension: 0.2, pointRadius: days.length > 45 ? 0 : 2, spanGaps: false },
        ],
      },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { grid: { display: false } } },
        plugins: { tooltip: { callbacks: { label: (context) => `${context.dataset.label}${context.datasetIndex === 1 && displayRows[context.dataIndex].previous ? ` (${dateLabel(displayRows[context.dataIndex].previous.date)})` : ''}: ${count(context.raw)}` } } },
      },
    });
  }

  async function load(source) {
    snapshot = source;
    const daily = $('downloaderMode').value !== 'range';
    const view = daily ? {
      ...source, daily,
      range: { start: source.range.end, end: source.range.end, days: 1 },
      compare: { ...source.compare, start: source.compare.end, end: source.compare.end },
    } : { ...source, daily };
    controller?.abort();
    const active = new AbortController();
    controller = active;
    latest = null;
    $('downloaderRange').textContent = `${view.platformLabel} • ${rangeLabel(view.range.start, view.range.end)} vs ${rangeLabel(view.compare.start, view.compare.end)}`;
    $('downloaderStatus').textContent = 'Mengambil downloader per hari… Rentang panjang dan semua platform membutuhkan waktu lebih lama.';
    $('downloaderWarning').hidden = true;
    renderKpi(view, null, null, true);
    $('downloaderTable').innerHTML = '';
    $('downloaderChartWrap').hidden = true;
    $('exportDownloaders').disabled = true;
    $('reloadDownloaders').disabled = true;
    try {
      const results = await Promise.allSettled([
        request(view.platform, view.range, active.signal),
        request(view.platform, view.compare, active.signal),
      ]);
      if (!active.signal.aborted) render(results, view);
    } catch {
      if (!active.signal.aborted) $('downloaderStatus').textContent = 'Tampilan downloader belum dapat dimuat. Silakan coba lagi.';
    } finally {
      if (controller === active) $('reloadDownloaders').disabled = false;
    }
  }

  $('reloadDownloaders').addEventListener('click', () => { if (snapshot) void load(snapshot); });
  $('downloaderMode').addEventListener('change', () => { if (snapshot) void load(snapshot); });
  $('exportDownloaders').addEventListener('click', () => {
    if (!latest?.current) return;
    const { current, previous, view } = latest;
    downloadCsv('downloader-harian.csv', current.data.map((row, i) => ({ ...row, previous: previous?.data[i] })), [
      ['platform', () => view.platformLabel], ['tanggal', (row) => row.date],
      ['downloader', (row) => row.total ?? ''], ['status_data', (row) => row.total === null ? 'tidak lengkap' : 'lengkap'],
      ['tercatat_sementara', (row) => row.known_total], ['platform_belum_dimuat', (row) => row.missing_platforms.join(' | ')],
      ['tanggal_pembanding', (row) => row.previous?.date || ''], ['downloader_pembanding', (row) => row.previous?.total ?? ''],
      ['perubahan', (row) => compareDownloaderCounts(row.total, row.previous?.total)],
      ['mode_data', () => current.demo ? 'demo' : 'live'],
    ]);
  });
  return { load };
}

const nextDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const color = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
