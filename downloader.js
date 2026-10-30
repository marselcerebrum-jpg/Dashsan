const DAY_MS = 86400000;
const apiError = (message, code) => Object.assign(new Error(message), { code });

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function downloaderDates(start, end) {
  if (!validDate(start) || !validDate(end)) throw apiError('Tanggal downloader harus valid dengan format YYYY-MM-DD.', 400);
  const days = (Date.parse(end) - Date.parse(start)) / DAY_MS + 1;
  if (days < 1) throw apiError('Tanggal akhir downloader tidak boleh sebelum tanggal awal.', 400);
  if (days > 400) throw apiError('Rentang downloader maksimal 400 hari.', 400);
  return Array.from({ length: days }, (_, i) => new Date(Date.parse(start) + i * DAY_MS).toISOString().slice(0, 10));
}

export async function requestDailyDownloader({ baseUrl, apiKey, authMode, platform, date, fetchImpl = fetch }) {
  const url = new URL(`${baseUrl}/api/user-daily`);
  url.searchParams.set('platform', platform);
  url.searchParams.set('date', date);
  const headers = { Accept: 'application/json' };
  if (authMode.query) url.searchParams.set(authMode.query, apiKey);
  else headers[authMode.header] = apiKey;

  let response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15000) });
  } catch {
    throw apiError('Tidak dapat terhubung ke API downloader Markaz.', 502);
  }
  const body = await response.json().catch(() => null);
  if ([401, 403].includes(response.status) || /api key/i.test(body?.message || '')) {
    throw apiError('API key downloader Markaz ditolak. Periksa API_KEY di server.', 401);
  }
  if (!response.ok || body?.status !== true) throw apiError(`Data downloader tidak dapat diambil (HTTP ${response.status}).`, 502);
  if (!Number.isSafeInteger(body.data?.total) || body.data.total < 0) throw apiError('Total downloader dari Markaz tidak valid.', 502);
  return body.data.total;
}

export function createDownloaderService({ platforms, requestDaily, today, demo = false, now = Date.now, budgetMs = 210000 }) {
  const cache = new Map();
  const pending = new Map();
  const waiting = [];
  let active = 0;

  // Batas berlaku juga untuk permintaan periode/pembanding yang berjalan bersamaan.
  async function limited(fn) {
    if (active >= 3) await new Promise((resolve) => waiting.push(resolve));
    else active++;
    try { return await fn(); } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }

  async function daily(platform, date) {
    const key = `${platform}|${date}`;
    const hit = cache.get(key);
    if (hit?.expires > now()) return hit.total;
    if (pending.has(key)) return pending.get(key);
    const promise = limited(async () => {
      const seed = [...key].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
      const total = demo ? 15 + seed % 230 : await requestDaily(platform, date);
      if (!Number.isSafeInteger(total) || total < 0) throw apiError('Total downloader dari Markaz tidak valid.', 502);
      const recent = date >= new Date(Date.parse(today()) - 2 * DAY_MS).toISOString().slice(0, 10);
      cache.set(key, { total, expires: now() + (recent ? 2 : 30) * 60000 });
      return total;
    });
    pending.set(key, promise);
    try { return await promise; } finally { pending.delete(key); }
  }

  return {
    async getRange(platform, start, end) {
      const dates = downloaderDates(start, end);
      if (platform !== 'all' && !platforms.some((p) => p.slug === platform)) throw apiError('Platform downloader tidak valid.', 400);
      const selected = platform === 'all' ? platforms.map((p) => p.slug) : [platform];
      const totals = new Map(selected.map((slug) => [slug, 0]));
      const data = dates.map((date) => ({ date, total: 0, known_total: 0, missing_platforms: [] }));
      const jobs = data.flatMap((row) => selected.map((slug) => ({ row, slug })));
      const deadline = now() + budgetMs;
      let cursor = 0;
      let fatal;
      await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => {
        while (cursor < jobs.length && !fatal) {
          const { row, slug } = jobs[cursor++];
          if (now() >= deadline) { row.missing_platforms.push(slug); continue; }
          try {
            const total = await daily(slug, row.date);
            row.known_total += total;
            totals.set(slug, totals.get(slug) + total);
          } catch (err) {
            if (err.code === 401 || err.code === 403) fatal = err;
            else row.missing_platforms.push(slug);
          }
        }
      }));
      if (fatal) throw fatal;
      for (const row of data) row.total = row.missing_platforms.length ? null : row.known_total;
      const complete = data.every((row) => row.total !== null);
      const knownTotal = data.reduce((sum, row) => sum + row.known_total, 0);
      const completeDays = data.filter((row) => row.total !== null).length;
      return {
        platform, start_date: start, end_date: end, data,
        per_platform: selected.map((slug) => {
          const completeDays = data.filter((row) => !row.missing_platforms.includes(slug)).length;
          const complete = completeDays === dates.length;
          return { platform: slug, complete, total: complete ? totals.get(slug) : null, known_total: totals.get(slug), complete_days: completeDays, days: dates.length };
        }),
        summary: { complete, total: complete ? knownTotal : null, known_total: knownTotal, complete_days: completeDays, days: dates.length },
        warnings: complete ? [] : [`Data downloader belum lengkap untuk ${dates.length - completeDays} dari ${dates.length} hari. Data yang gagal dimuat tidak dihitung sebagai nol.`],
      };
    },
  };
}
