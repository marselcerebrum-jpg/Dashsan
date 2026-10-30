import { fetchDownloaderRange } from './downloader-data.js';

export function platformMetrics(group, mode, downloader, salesComplete = true) {
  const denominator = mode === 'conversion'
    ? (downloader?.complete && Number.isFinite(downloader.total) ? downloader.total : null)
    : group.total;
  return { denominator, conversion: salesComplete && denominator > 0 ? group.success / denominator : NaN };
}

// The table always uses the entire applied sales range, independent of the daily KPI.
export function createPlatformDownloader({ apiUrl, onUpdate, request = fetchDownloaderRange }) {
  let context;
  let mode = 'purchase';
  let controller;
  let result = { loading: false, data: null, error: '', loadedDays: 0 };
  const emit = () => onUpdate(result);
  async function load() {
    if (!context || mode !== 'conversion' || context.platform !== 'all' || controller || result.data) return;
    const active = new AbortController();
    controller = active;
    result = { loading: true, data: null, error: '', loadedDays: 0 };
    emit();
    try {
      const data = await request({ apiUrl, platform: context.platform, range: context.range, signal: active.signal,
        onProgress: (loadedDays) => {
          if (active.signal.aborted) return;
          result = { ...result, loadedDays };
          emit();
        },
      });
      if (active.signal.aborted) return;
      result = { ...result, loading: false, data };
      emit();
    } catch (err) {
      if (active.signal.aborted) return;
      result = { ...result, loading: false, error: err.message };
      emit();
    } finally {
      if (controller === active) controller = null;
    }
  }
  return {
    reset() {
      controller?.abort();
      controller = null;
      context = null;
      result = { loading: false, data: null, error: '', loadedDays: 0 };
    },
    setContext(value) { this.reset(); context = value; void load(); },
    setMode(value) {
      mode = value === 'conversion' ? 'conversion' : 'purchase';
      if (mode === 'purchase') {
        controller?.abort();
        controller = null;
        result = { ...result, loading: false };
      } else void load();
      emit();
    },
    retry() { result = { loading: false, data: null, error: '', loadedDays: 0 }; void load(); },
    snapshot: () => result,
  };
}
