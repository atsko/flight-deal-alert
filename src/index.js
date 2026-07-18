import fs from 'node:fs';
import path from 'node:path';
import { cfg, assertConfig, ROOT } from './config.js';
import * as tp from './travelpayouts.js';
import * as am from './amadeus.js';
import * as H from './history.js';
import * as D from './detector.js';
import { sendDigest } from './notify.js';
import { todayJST, addDays, addMonths, monthOf, daysInMonth, diffDays } from './util.js';

const STATE_FILE = path.join(ROOT, 'data', 'state.json');
const loadState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
};
const saveState = (s) => {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
};

// その月の「今日より先」の日付一覧
function futureDatesInMonth(month, today) {
  const out = [];
  for (let d = 1; d <= daysInMonth(month); d++) {
    const iso = `${month}-${String(d).padStart(2, '0')}`;
    if (iso > today) out.push(iso);
  }
  return out;
}

// 路線×月ごとのキャッシュカバー率
function computeCoverage(obsMap, months, today) {
  const cov = {};
  for (const route of cfg.routes) {
    const key = `${cfg.origin}-${route.dest}`;
    cov[key] = {};
    for (const month of months) {
      const total = futureDatesInMonth(month, today).length;
      const covered = Object.keys(obsMap[key] ?? {}).filter((d) => monthOf(d) === month).length;
      cov[key][month] = { covered, total, ratio: total ? covered / total : 1 };
    }
  }
  return cov;
}

// キャッシュの薄い (路線, 月) をAmadeusの予約検索でサンプリングして穴埋め
async function probeGaps(obsMap, coverage, months, today, state, counter, budget) {
  state.probeCursor ??= {};
  const cells = [];
  for (const route of cfg.routes) {
    const key = `${cfg.origin}-${route.dest}`;
    for (const month of months) {
      const c = coverage[key][month];
      if (c.total > 0 && c.ratio < 0.5) cells.push({ route, key, month, ratio: c.ratio });
    }
  }
  cells.sort((a, b) => a.ratio - b.ratio);
  if (!cells.length) return;
  console.log(
    `[Amadeus] キャッシュの薄い ${cells.length}セル (路線×月) を穴埋めします (今日の残り予算 ${budget()}回)`,
  );

  for (const cell of cells) {
    if (budget() <= cfg.amadeus.verifyReserve) break;
    const covered = new Set(Object.keys(obsMap[cell.key]).filter((d) => monthOf(d) === cell.month));
    const dates = futureDatesInMonth(cell.month, today).filter((d) => !covered.has(d));
    if (!dates.length) continue;

    // 日々ずれるカーソルで月内を均等にサンプリング (1セルあたり最大3日付)
    const ckey = `${cell.key}:${cell.month}`;
    const cur = state.probeCursor[ckey] ?? 0;
    const step = Math.max(1, Math.floor(dates.length / 3));
    const picks = [...new Set([0, 1, 2].map((i) => dates[(cur + i * step) % dates.length]))];
    state.probeCursor[ckey] = (cur + 1) % Math.max(1, dates.length);

    for (const dep of picks) {
      if (budget() <= cfg.amadeus.verifyReserve) break;
      const ret = addDays(dep, cell.route.probeStay);
      const offer = await am.cheapestOffer(cell.route, dep, ret, counter);
      if (offer && (!obsMap[cell.key][dep] || offer.price < obsMap[cell.key][dep].price)) {
        obsMap[cell.key][dep] = offer;
      }
    }
  }
}

// 通知候補をAmadeusの実売価格で検証してから通知する
async function verifyDeals(deals, counter, budget) {
  for (const deal of deals) {
    if (deal.obs.source !== 'tp') {
      deal.verified = true; // Amadeus由来の観測はそのまま実売価格
      continue;
    }
    if (budget() <= 0) {
      deal.verified = false;
      continue;
    }
    const route = cfg.routes.find((r) => `${cfg.origin}-${r.dest}` === deal.routeKey);
    const offer = await am.cheapestOffer(route, deal.depDate, deal.obs.retDate, counter);
    if (!offer) {
      deal.verified = false;
      continue;
    }
    if (offer.price <= deal.obs.price * 1.15) {
      deal.verified = true;
      deal.obs = {
        ...deal.obs,
        price: offer.price,
        airline: offer.airline,
        transfers: offer.transfers,
        source: 'tp+am',
      };
    } else {
      deal.stale = true; // キャッシュ価格がすでに消滅していた
    }
  }
}

// 履歴が貯まるまでの初期判定: 過去運賃の四分位 (Flight Price Analysis) を利用
async function bootstrapDeals(obsMap, state, today) {
  const deals = [];
  const counterPM = { calls: 0 };
  for (const route of cfg.routes) {
    const key = `${cfg.origin}-${route.dest}`;
    const entries = Object.entries(obsMap[key] ?? {});
    if (!entries.length) continue;
    entries.sort((a, b) => a[1].price - b[1].price);
    const [dep, obs] = entries[0]; // その路線で今日いちばん安い日付だけ照会
    const m = await am.priceMetrics(route.dest, dep, counterPM);
    if (!m?.FIRST || obs.price > m.FIRST) continue;

    const akey = `${key}|${dep}`;
    const prev = state.alerts?.[akey];
    if (prev && obs.price > prev.price * cfg.detect.realertRatio) continue;

    deals.push({
      routeKey: key,
      depDate: dep,
      obs,
      baseline: m.MEDIUM ?? m.FIRST,
      reasons: [
        {
          type: 'quartile',
          text: `過去運賃分布の下位25%に入る安さ (過去中央値 ¥${Math.round(m.MEDIUM ?? m.FIRST).toLocaleString('ja-JP')})`,
        },
      ],
    });
  }
  state.amadeus.pmCalls = (state.amadeus.pmCalls ?? 0) + counterPM.calls;
  if (counterPM.calls) console.log(`[Amadeus] Price Analysis を ${counterPM.calls}回照会 (初期判定)`);
  return deals;
}

function pruneState(state, today) {
  for (const k of Object.keys(state.alerts ?? {})) {
    const dep = k.split('|')[1];
    if (dep && dep <= today) delete state.alerts[k];
  }
  for (const byMonth of Object.values(state.minSeen ?? {})) {
    for (const m of Object.keys(byMonth)) if (m < monthOf(today)) delete byMonth[m];
  }
}

async function main() {
  assertConfig();
  const today = todayJST();
  const state = loadState();
  const history = H.load();

  const isFirstRun = !state.firstRunAt;
  state.firstRunAt ??= today;
  state.alerts ??= {};
  state.amadeus ??= {};
  if (state.amadeus.month !== monthOf(today)) {
    state.amadeus = { month: monthOf(today), calls: 0, pmCalls: 0 };
  }

  // Amadeus無料枠のガード (1日と1ヶ月の両方でキャップ)
  const counter = { calls: 0 };
  const budget = () =>
    Math.min(
      cfg.amadeus.dailyCap - counter.calls,
      cfg.amadeus.monthlyCap - state.amadeus.calls - counter.calls,
    );

  const months = Array.from({ length: cfg.months }, (_, i) => addMonths(monthOf(today), i));
  console.log(`監視対象: ${cfg.routes.length}路線 × ${months[0]}〜${months.at(-1)} (往復・LCC除外)`);

  // ① Travelpayouts で全路線×6ヶ月を広域スキャン (無料)
  const obsMap = await tp.scanAll(months, today);

  // ② キャッシュの薄いところを Amadeus で穴埋め
  const coverage = computeCoverage(obsMap, months, today);
  const amadeusOn = am.enabled();
  if (amadeusOn) await probeGaps(obsMap, coverage, months, today, state, counter, budget);

  // ③ 割安判定
  const historyAge = Math.max(0, diffDays(state.firstRunAt, today));
  let deals = D.findDeals(history, state, obsMap, today, historyAge);

  // ③' 履歴が貯まるまでは過去運賃の四分位で補助判定
  if (amadeusOn && cfg.amadeus.priceAnalysis && historyAge < cfg.detect.bootstrapDays * 2) {
    const boot = await bootstrapDeals(obsMap, state, today);
    const seen = new Set(deals.map((d) => `${d.routeKey}|${d.depDate}`));
    for (const b of boot) if (!seen.has(`${b.routeKey}|${b.depDate}`)) deals.push(b);
  }

  // ④ 通知前に実売価格を検証 (キャッシュ由来の候補のみ)
  if (amadeusOn) await verifyDeals(deals, counter, budget);
  deals = deals.filter((d) => !d.stale);

  // ⑤ 履歴・状態を更新
  for (const [routeKey, dates] of Object.entries(obsMap)) {
    for (const [dep, obs] of Object.entries(dates)) H.record(history, routeKey, dep, today, obs);
  }
  D.updateMinSeen(state, obsMap, today);
  H.prune(history, today);
  pruneState(state, today);
  for (const deal of deals) {
    state.alerts[`${deal.routeKey}|${deal.depDate}`] = { price: deal.obs.price, at: today };
  }
  state.amadeus.calls += counter.calls;
  H.save(history);
  saveState(state);

  // ⑥ 通知
  const routesByKey = Object.fromEntries(cfg.routes.map((r) => [`${cfg.origin}-${r.dest}`, r]));
  console.log(`割安便: ${deals.length}件 / Amadeus本日: ${counter.calls}回 (今月累計 ${state.amadeus.calls}回)`);
  for (const d of deals) {
    console.log(
      `  - ${routesByKey[d.routeKey]?.label ?? d.routeKey} ${d.depDate}発 ¥${d.obs.price.toLocaleString('ja-JP')} : ${d.reasons.map((r) => r.type).join(', ')}`,
    );
  }

  if (cfg.dryRun) {
    console.log('[DRY_RUN] メール送信をスキップしました。');
    return;
  }
  const isMonday = new Date(today + 'T00:00:00Z').getUTCDay() === 1;
  const shouldMail = deals.length > 0 || isFirstRun || (cfg.mail.weeklyReport && isMonday);
  if (shouldMail) {
    await sendDigest({
      deals,
      coverage,
      routesByKey,
      usage: { todayCalls: counter.calls, monthCalls: state.amadeus.calls },
      today,
      isFirstRun,
      historyAge,
    });
  } else {
    console.log('通知条件を満たさないためメールは送信しません。');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
