import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { median, monthOf, diffDays } from './util.js';

const FILE = path.join(ROOT, 'data', 'prices.json');
const MAX_OBS_PER_DATE = 40; // 出発日あたり保持する観測数 (約40日分)

export function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function save(h) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(h));
}

// 観測を1件追記: h[routeKey][depDate] = [[obsDate, price, retDate, source, airline], ...]
export function record(h, routeKey, depDate, obsDate, obs) {
  const r = (h[routeKey] ??= {});
  const arr = (r[depDate] ??= []);
  const row = [obsDate, obs.price, obs.retDate, obs.source, obs.airline];
  const i = arr.findIndex((o) => o[0] === obsDate);
  if (i >= 0) {
    if (obs.price < arr[i][1]) arr[i] = row; // 同日複数回実行時は安い方を採用
  } else {
    arr.push(row);
  }
  if (arr.length > MAX_OBS_PER_DATE) arr.splice(0, arr.length - MAX_OBS_PER_DATE);
}

// 出発日が過去になったデータを掃除
export function prune(h, today) {
  for (const routeKey of Object.keys(h)) {
    for (const dep of Object.keys(h[routeKey])) {
      if (dep <= today) delete h[routeKey][dep];
    }
    if (!Object.keys(h[routeKey]).length) delete h[routeKey];
  }
}

// 同じ出発日の直近windowDays日の観測中央値 (今日の観測は除外)
export function dateMedian(h, routeKey, depDate, today, windowDays) {
  const arr = h[routeKey]?.[depDate] ?? [];
  const prices = arr
    .filter((o) => o[0] !== today && diffDays(o[0], today) <= windowDays)
    .map((o) => o[1]);
  return { median: median(prices), n: prices.length };
}

// 同じ搭乗月の全日付をプールした観測中央値 (今日の観測は除外)
export function monthMedian(h, routeKey, month, today, windowDays) {
  const prices = [];
  for (const [dep, arr] of Object.entries(h[routeKey] ?? {})) {
    if (monthOf(dep) !== month) continue;
    for (const o of arr) {
      if (o[0] !== today && diffDays(o[0], today) <= windowDays) prices.push(o[1]);
    }
  }
  return { median: median(prices), n: prices.length };
}
