const nextDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

// Keep each Vercel invocation short; both dashboard views share this range reader.
export async function fetchDownloaderRange({ apiUrl, platform, range, signal, onProgress = () => {}, fetchImpl = fetch }) {
  const data = [];
  const byPlatform = new Map();
  let demo = false;
  const chunkSize = platform === 'all' ? 1 : 7;
  for (let start = range.start; start <= range.end;) {
    signal.throwIfAborted();
    let end = start;
    for (let i = 1; i < chunkSize && nextDay(end) <= range.end; i++) end = nextDay(end);
    const qs = new URLSearchParams({ platform, start_date: start, end_date: end });
    const response = await fetchImpl(apiUrl(`/api/downloaders?${qs}`), { signal, headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    signal.throwIfAborted();
    if (!response.ok || !body.status) throw new Error(body.message || `Gagal memuat downloader (HTTP ${response.status}).`);
    data.push(...body.data);
    demo = body.demo;
    for (const row of body.per_platform || []) {
      const aggregate = byPlatform.get(row.platform) || { platform: row.platform, known_total: 0, complete_days: 0 };
      aggregate.known_total += row.known_total;
      aggregate.complete_days += row.complete_days;
      byPlatform.set(row.platform, aggregate);
    }
    onProgress(data.length);
    start = nextDay(end);
  }
  const complete = data.every((row) => row.total !== null);
  const knownTotal = data.reduce((sum, row) => sum + row.known_total, 0);
  const completeDays = data.filter((row) => row.total !== null).length;
  const warnings = complete ? [] : [`Data downloader belum lengkap untuk ${data.length - completeDays} dari ${data.length} hari. Data yang gagal dimuat tidak dihitung sebagai nol.`];
  return {
    data, demo, warnings,
    per_platform: [...byPlatform.values()].map((row) => ({ ...row, days: data.length, complete: row.complete_days === data.length, total: row.complete_days === data.length ? row.known_total : null })),
    summary: { complete, total: complete ? knownTotal : null, known_total: knownTotal, complete_days: completeDays, days: data.length },
  };
}
