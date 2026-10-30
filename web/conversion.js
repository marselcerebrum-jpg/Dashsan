export function downloaderConversion(rows, view, result, complete = true) {
  if (!Array.isArray(rows) || !complete) return { rate: null, reason: 'Data transaksi belum tersedia/lengkap' };
  if (!result) return { rate: null, reason: 'Data downloader belum tersedia' };
  if (!result.summary?.complete || !Number.isSafeInteger(result.summary.total) || result.summary.total < 0) {
    return { rate: null, reason: 'Data downloader belum lengkap' };
  }
  const users = new Set(rows.filter((row) => Number(row.status) === 1
    && row.day >= view.range.start && row.day <= view.range.end
    && (view.platform === 'all' || row.platform === view.platform)).map((row) => row.custKey)).size;
  const downloads = result.summary.total;
  if (!downloads) return { users, downloads, rate: null, reason: 'Downloader 0; rasio tidak tersedia' };
  return { users, downloads, rate: users / downloads, reason: '' };
}

export function createConversionKpi({ element, esc, num, pct, rangeLabel }) {
  let activeId;
  let sales;
  let downloaders;

  function render() {
    const loading = !sales || !downloaders || downloaders.loading;
    const view = downloaders?.view;
    const current = view && sales ? downloaderConversion(sales.rows, view, downloaders.current, sales.complete) : null;
    const previous = view && sales ? downloaderConversion(sales.previousRows, { ...view, range: view.compare }, downloaders.previous, sales.previousComplete) : null;
    let delta = '<span class="muted">Menunggu data pembeli dan downloader…</span>';
    if (!loading) {
      if (current.rate === null) delta = `<span class="muted">${esc(current.reason)}</span>`;
      else if (previous.rate === null) delta = '<span class="muted">Pembanding belum tersedia/lengkap</span>';
      else if (!previous.rate) delta = `<span class="muted">vs ${esc(view.compare.short)} (0%)</span>`;
      else {
        const change = (current.rate - previous.rate) / previous.rate;
        const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '•';
        delta = `<span class="${change > 0 ? 'up' : change < 0 ? 'down' : ''}">${arrow} ${esc(pct(Math.abs(change)))}</span> <span class="muted">vs ${esc(view.compare.short)} (${esc(pct(previous.rate))})</span>`;
      }
    }
    const counts = !loading && current.users !== undefined
      ? `<div class="muted">${esc(num(current.users))} pembeli / ${esc(num(current.downloads))} downloader</div>` : '';
    const period = view ? `<div class="muted">${esc(rangeLabel(view.range.start, view.range.end))}</div>` : '';
    element.innerHTML = `<div class="kpi" style="--kc: var(--s7)" title="Konversi sekarang = pembeli unik ÷ downloader × 100%, untuk platform dan tanggal yang sama. Rasio volume, bukan pelacakan pengguna yang sama."><div class="label">Konversi</div><div class="value">${loading ? '…' : current.rate === null ? '—' : esc(pct(current.rate))}</div><div class="delta">${delta}</div>${counts}${period}</div>`;
  }

  return {
    begin(requestId) { activeId = requestId; sales = null; downloaders = null; render(); },
    setSales(requestId, value) { if (requestId === activeId) { sales = value; render(); } },
    setDownloaders(value) { if (value.view.requestId === activeId) { downloaders = value; render(); } },
  };
}
