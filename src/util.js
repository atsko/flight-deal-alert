// 日付・数値まわりの小さなユーティリティ

const JST_OFFSET = 9 * 3600 * 1000;

// JST基準の今日 (YYYY-MM-DD)
export const todayJST = () => new Date(Date.now() + JST_OFFSET).toISOString().slice(0, 10);

// ISO日付に日数を加算
export const addDays = (isoDate, n) => {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// 'YYYY-MM-DD' -> 'YYYY-MM'
export const monthOf = (isoDate) => isoDate.slice(0, 7);

// 'YYYY-MM' に月数を加算
export const addMonths = (isoMonth, n) => {
  const [y, m] = isoMonth.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};

// その月の日数
export const daysInMonth = (isoMonth) => {
  const [y, m] = isoMonth.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

// 日付差 (b - a) を日数で
export const diffDays = (a, b) =>
  Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

export const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const yen = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');

const WD = ['日', '月', '火', '水', '木', '金', '土'];

// '2026-08-15' -> '8/15(土)'
export const fmtDate = (iso) => {
  const wd = WD[new Date(iso + 'T00:00:00Z').getUTCDay()];
  return `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}(${wd})`;
};

// '2026-08' -> '2026年8月'
export const fmtMonth = (m) => `${+m.slice(0, 4)}年${+m.slice(5, 7)}月`;
