// APIキー不要のロジック検証。判定エンジンが期待どおり動くかを確認する。
//   実行: npm run selftest
import * as H from '../src/history.js';
import * as D from '../src/detector.js';
import { addDays } from '../src/util.js';

const today = '2026-07-07';
const routeKey = 'HND-OKA';
const dep = '2026-08-15';

// 12日分の価格履歴 (約5万円前後) を合成
const history = {};
for (let i = 12; i >= 1; i--) {
  H.record(history, routeKey, dep, addDays(today, -i), {
    price: 50000 + (i % 3) * 800,
    retDate: '2026-08-17',
    source: 'tp',
    airline: 'NH',
  });
}
// 月間相場プール用に同月の別日付も追加
for (const d2 of ['2026-08-01', '2026-08-08', '2026-08-22', '2026-08-29']) {
  for (let i = 8; i >= 1; i--) {
    H.record(history, routeKey, d2, addDays(today, -i), {
      price: 52000 + (i % 4) * 500,
      retDate: addDays(d2, 2),
      source: 'tp',
      airline: 'JL',
    });
  }
}

const state = {
  firstRunAt: addDays(today, -12),
  alerts: {},
  minSeen: { [routeKey]: { '2026-08': { price: 46000, depDate: '2026-08-03' } } },
};

// 今日、¥39,800 の往復が観測されたケース
const obsMap = {
  [routeKey]: {
    [dep]: { price: 39800, retDate: '2026-08-17', airline: 'NH', transfers: 0, source: 'tp', link: null },
  },
};

let deals = D.findDeals(history, state, obsMap, today, 12);
console.log(`検出: ${deals.length}件`);
for (const r of deals[0]?.reasons ?? []) console.log('  ・' + r.text);
if (deals.length !== 1 || deals[0].reasons.length !== 3) {
  throw new Error('date_drop / month_low / new_low の3条件が検出されるはずです');
}

// クールダウン: 直前に ¥40,000 で通知済みなら、5%以内の下落では再通知しない
state.alerts[`${routeKey}|${dep}`] = { price: 40000, at: addDays(today, -2) };
deals = D.findDeals(history, state, obsMap, today, 12);
if (deals.length !== 0) throw new Error('クールダウンが効いていません');
console.log('クールダウン: OK (¥40,000通知済み → ¥39,800では再通知しない)');

// さらに下がれば再通知する
obsMap[routeKey][dep].price = 37800;
deals = D.findDeals(history, state, obsMap, today, 12);
if (deals.length !== 1) throw new Error('大幅下落時は再通知されるはずです');
console.log('再通知: OK (¥37,800まで下がれば通知)');

console.log('\nセルフテスト: すべて成功 ✅');
