import fs from 'node:fs';
import path from 'node:path';
import { cfg, assertConfig, ROOT } from './config.js';
import * as tp from './travelpayouts.js';
import * as gf from './serpapi.js';
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

// Google判定「安い」による通知候補を作る
function makeGoogleLowDeal(routeKey, depDate, offer) {
  const [lo, hi] = offer.insights?.typicalRange ?? [];
  const baseline = lo && hi ? (lo + hi) / 2 : null;
  const rangeText =
    lo && hi
      ? ` (通常 ¥${Math.round(lo).toLocaleString('ja-JP')}〜¥${Math.round(hi).toLocaleString('ja-JP')})`
      : '';
  return {
    routeKey,
    depDate,
    obs: offer,
    baseline,
    verified: true, // Google Flightsの実売価格そのもの
    reasons: [
      { type: 'google_low', text: `Google Flights判定: この日程の価格水準は「安い」${rangeText}` },
    ],
  };
}

// SerpAPIの予算で「初期判定」と「キャッシュの薄い所の穴埋め」を行う。
// どの検索結果にも Google の価格水準判定 (price_insights) が付いてくるので、
// 「low (安い)」と判定された日程はそのまま通知候補として返す。
async function runProbes(obsMap, coverage, months, today, state, counter, budget, historyAge) {
  const targets = [];

  // (a) 履歴が貯まるまでの初期判定: 各路線の「今日の最安日」を日替わりの順番でチェック
  if (historyAge < cfg.detect.bootstrapDays * 2) {
    const rot = state.bootCursor ?? 0;
    for (let i = 0; i < cfg.routes.length; i++) {
      const route = cfg.routes[(rot + i) % cfg.routes.length];
      const key = `${cfg.origin}-${route.dest}`;
      const entries = Object.entries(obsMap[key] ?? {}).sort((a, b) => a[1].price - b[1].price);
      if (entries.length) {
        targets.push({ route, key, dep: entries[0][0], ret: entries[0][1].retDate });
      }
    }
    state.bootCursor = (rot + 1) % cfg.routes.length;
  }

  // (b) キャッシュの薄い (路線, 月) の穴埋め (1セルにつき1日付、日替わりカーソル)
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
  for (const cell of cells) {
    const coveredSet = new Set(
      Object.keys(obsMap[cell.key]).filter((d) => monthOf(d) === cell.month),
    );
    const dates = futureDatesInMonth(cell.month, today).filter((d) => !coveredSet.has(d));
    if (!dates.length) continue;
    const ckey = `${cell.key}:${cell.month}`;
    const cur = state.probeCursor[ckey] ?? 0;
    targets.push({ route: cell.route, key: cell.key, dep: dates[cur % dates.length], ret: null });
    state.probeCursor[ckey] = (cur + 1) % dates.length;
  }

  // 予算内で順に実行 (実売検証用の取り置き分は残す)
  const googleLow = [];
  for (const t of targets) {
    if (budget() <= cfg.serpapi.verifyReserve) break;
    const ret = t.ret ?? addDays(t.dep, t.route.probeStay);
    const offer = await gf.cheapestOffer(t.route, t.dep, ret, counter);
    if (!offer) continue;
    if (!obsMap[t.key][t.dep] || offer.price < obsMap[t.key][t.dep].price) {
      obsMap[t.key][t.dep] = offer;
    }
    if (offer.insights?.level === 'low') {
      googleLow.push(makeGoogleLowDeal(t.key, t.dep, offer));
    }
  }
  return googleLow;
}

// 通知候補を Google Flights の実売価格で検証してから通知する
async function verifyDeals(deals, counter, budget) {
  for (const deal of deals) {
    if (deal.obs.source !== 'tp') {
      deal.verified = true; // Google Flights由来の観測はそのまま実売価格
      continue;
    }
    if (budget() <= 0) {
      deal.verified = false;
      continue;
    }
    const route = cfg.routes.find((r) => `${cfg.origin}-${r.dest}` === deal.routeKey);
    const offer = await gf.cheapestOffer(route, deal.depDate, deal.obs.retDate, counter);
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
        source: 'tp+gf',
      };
      if (offer.insights?.level === 'low' && !deal.reasons.some((r) => r.type === 'google_low')) {
        deal.reasons.push({ type: 'google_low', text: 'Google Flights判定でも価格水準は「安い」' });
      }
    } else {
      deal.stale = true; // キャッシュ価格がすでに消滅していた
    }
  }
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
  delete state.amadeus; // 旧構成 (Amadeus) の残骸を掃除
  state.serpapi ??= {};
  if (state.serpapi.month !== monthOf(today)) {
    state.serpapi = { month: monthOf(today), calls: 0 };
  }

  // SerpAPI無料枠のガード (1日と1ヶ月の両方でキャップ)
  const counter = { calls: 0 };
  const budget = () =>
    Math.min(
      cfg.serpapi.dailyCap - counter.calls,
      cfg.serpapi.monthlyCap - state.serpapi.calls - counter.calls,
    );

  const months = Array.from({ length: cfg.months }, (_, i) => addMonths(monthOf(today), i));
  console.log(`監視対象: ${cfg.routes.length}路線 × ${months[0]}〜${months.at(-1)} (往復・LCC除外)`);

  // ① Travelpayouts で全路線×6ヶ月を広域スキャン (無料)
  const obsMap = await tp.scanAll(months, today);

  // ② SerpAPI (Google Flights) で初期判定とキャッシュの穴埋め
  const coverage = computeCoverage(obsMap, months, today);
  const gfOn = gf.enabled();
  const historyAge = Math.max(0, diffDays(state.firstRunAt, today));
  let googleLowDeals = [];
  if (gfOn) {
    googleLowDeals = await runProbes(
      obsMap, coverage, months, today, state, counter, budget, historyAge,
    );
  }

  // ③ 履歴ベースの割安判定
  let deals = D.findDeals(history, state, obsMap, today, historyAge);

  // ③' Google判定「安い」の候補をマージ (重複除去 + クールダウン)
  const seen = new Set(deals.map((d) => `${d.routeKey}|${d.depDate}`));
  for (const g of googleLowDeals) {
    const akey = `${g.routeKey}|${g.depDate}`;
    if (seen.has(akey)) continue;
    const prev = state.alerts[akey];
    if (prev && g.obs.price > prev.price * cfg.detect.realertRatio) continue;
    deals.push(g);
  }

  // ④ 通知前に実売価格を検証 (キャッシュ由来の候補のみ)
  if (gfOn) await verifyDeals(deals, counter, budget);
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
  state.serpapi.calls += counter.calls;
  H.save(history);
  saveState(state);

  // ⑥ 通知
  const routesByKey = Object.fromEntries(cfg.routes.map((r) => [`${cfg.origin}-${r.dest}`, r]));
  console.log(
    `割安便: ${deals.length}件 / SerpAPI本日: ${counter.calls}回 (今月累計 ${state.serpapi.calls}回)`,
  );
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
      usage: { todayCalls: counter.calls, monthCalls: state.serpapi.calls },
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
