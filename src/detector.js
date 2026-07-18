import { cfg } from './config.js';
import * as H from './history.js';
import { monthOf, fmtMonth, yen } from './util.js';

const dropPct = (price, base) => Math.round((1 - price / base) * 100) + '%';

// 今日の観測 (routeKey -> depDate -> obs) から割安便を抽出する
// 判定は3系統:
//   1. date_drop : 同じ出発日の直近30日中央値より dateDropRatio 以下
//   2. month_low : 同じ搭乗月の45日間プール中央値より monthDropRatio 以下
//   3. new_low   : その搭乗月の観測最安値を更新
export function findDeals(history, state, obsMap, today, historyAge) {
  const d = cfg.detect;
  const deals = [];

  for (const [routeKey, dates] of Object.entries(obsMap)) {
    for (const [depDate, obs] of Object.entries(dates)) {
      const month = monthOf(depDate);
      const reasons = [];
      let baseline = null;

      const ds = H.dateMedian(history, routeKey, depDate, today, 30);
      if (ds.n >= d.minDateObs && obs.price <= ds.median * d.dateDropRatio) {
        reasons.push({
          type: 'date_drop',
          text: `この日付の直近相場 (${yen(ds.median)}) より${dropPct(obs.price, ds.median)}安い`,
        });
        baseline ??= ds.median;
      }

      // 月間相場系の判定は履歴が貯まってから
      if (historyAge >= d.bootstrapDays) {
        const ms = H.monthMedian(history, routeKey, month, today, 45);
        if (ms.n >= d.minMonthObs && obs.price <= ms.median * d.monthDropRatio) {
          reasons.push({
            type: 'month_low',
            text: `${fmtMonth(month)}の相場 (中央値 ${yen(ms.median)}) より${dropPct(obs.price, ms.median)}安い`,
          });
          baseline ??= ms.median;
        }
        const min = state.minSeen?.[routeKey]?.[month];
        if (min && obs.price < min.price) {
          reasons.push({
            type: 'new_low',
            text: `${fmtMonth(month)}の観測最安値を更新 (これまで ${yen(min.price)})`,
          });
          baseline ??= min.price;
        }
      }

      if (!reasons.length) continue;

      // クールダウン: 前回通知した価格から realertRatio を下回るまで再通知しない
      const akey = `${routeKey}|${depDate}`;
      const prev = state.alerts?.[akey];
      if (prev && obs.price > prev.price * d.realertRatio) continue;

      deals.push({ routeKey, depDate, obs, reasons, baseline });
    }
  }

  // 値下がり率の大きい順に並べる
  deals.sort(
    (a, b) =>
      a.obs.price / (a.baseline ?? a.obs.price) - b.obs.price / (b.baseline ?? b.obs.price),
  );
  return deals;
}

// 搭乗月ごとの観測最安値を更新 (通知の有無とは独立に毎日更新)
export function updateMinSeen(state, obsMap, today) {
  state.minSeen ??= {};
  for (const [routeKey, dates] of Object.entries(obsMap)) {
    const byMonth = (state.minSeen[routeKey] ??= {});
    for (const [depDate, obs] of Object.entries(dates)) {
      const m = monthOf(depDate);
      if (!byMonth[m] || obs.price < byMonth[m].price) {
        byMonth[m] = { price: obs.price, depDate, at: today };
      }
    }
  }
}
