// 日期工具：统一使用 ISO 日期串（YYYY-MM-DD），按 UTC 计算，避免时区歧义进入账务。
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDate(iso) {
  const match = ISO_DATE.exec(iso);
  if (!match) throw new Error(`非法日期: ${iso}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function formatDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(iso, days) {
  return formatDate(parseDate(iso) + days * DAY_MS);
}

export function diffDays(from, to) {
  return Math.round((parseDate(to) - parseDate(from)) / DAY_MS);
}

// ISO 日期串的字典序与时间序一致，直接比较即可。
export function compareDates(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// 对月对日加月，月末日期自动钳制（如 01-31 加一月落到 02-28）。
export function addMonths(iso, months) {
  const [year, month, day] = iso.split("-").map(Number);
  const total = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(total / 12);
  const nextMonth = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
  return formatDate(Date.UTC(nextYear, nextMonth - 1, Math.min(day, lastDay)));
}

export function dayOfWeek(iso) {
  return new Date(parseDate(iso)).getUTCDay(); // 0=周日 6=周六
}
