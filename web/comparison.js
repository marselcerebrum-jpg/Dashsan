const DAY_MS = 86400000;
const toDate = (value) => new Date(`${value}T00:00:00Z`);
const format = (date) => date.toISOString().slice(0, 10);
const addDays = (value, days) => format(new Date(toDate(value).getTime() + days * DAY_MS));
const dayCount = (start, end) => Math.round((toDate(end) - toDate(start)) / DAY_MS) + 1;

function shiftCalendar(value, years, months) {
  const [year, month, day] = value.split('-').map(Number);
  const first = new Date(Date.UTC(year + years, month - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return format(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, last))));
}

export function compareRange(mode, start, end) {
  const days = dayCount(start, end);
  if (mode === 'prev') {
    const previousEnd = addDays(start, -1);
    return { mode, start: addDays(previousEnd, -(days - 1)), end: previousEnd, short: `${days} hari sebelumnya`, label: `${days} hari sebelumnya`, series: 'Omzet periode sebelumnya' };
  }
  if (mode === 'mom') {
    const previousEnd = shiftCalendar(end, 0, -1);
    let previousStart = addDays(previousEnd, -(days - 1));
    // Preserve the selected number of days, keeping a single-month range in the previous month.
    if (start.slice(0, 7) === end.slice(0, 7)) {
      const first = `${previousEnd.slice(0, 7)}-01`;
      if (previousStart < first) previousStart = first;
    }
    return { mode, start: previousStart, end: previousEnd, short: 'bulan lalu', label: 'periode sama bulan lalu', series: 'Omzet bulan lalu' };
  }
  return { mode: 'yoy', start: shiftCalendar(start, -1, 0), end: shiftCalendar(end, -1, 0), short: 'tahun lalu', label: 'periode sama tahun lalu', series: 'Omzet tahun lalu' };
}
