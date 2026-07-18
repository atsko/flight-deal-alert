// SerpAPI (Google Flights) レスポンス解析のオフラインテスト。APIキー不要。
//   実行: npm run selftest (selftest.mjs と一緒に実行される)
import { parseCheapest } from '../src/serpapi.js';

const route = { dest: 'CTS', direct: true };

// 実レスポンスの構造を模したフィクスチャ
const json = {
  best_flights: [
    // LCC (GK=ジェットスター・ジャパン) が最安 → 除外されるべき
    { price: 28000, flights: [{ flight_number: 'GK 105', airline: 'Jetstar Japan' }], layovers: [] },
    { price: 31000, flights: [{ flight_number: 'NH 61', airline: 'ANA' }], layovers: [] },
  ],
  other_flights: [
    // 乗継便 → direct指定の路線では除外されるべき
    {
      price: 29500,
      flights: [
        { flight_number: 'JL 500', airline: 'JAL' },
        { flight_number: 'JL 2870', airline: 'JAL' },
      ],
      layovers: [{ duration: 75 }],
    },
    { price: 30500, flights: [{ flight_number: 'BC 765', airline: 'Skymark' }], layovers: [] },
  ],
  price_insights: {
    lowest_price: 28000,
    price_level: 'LOW', // 大文字で来ても正規化されること
    typical_price_range: [38000, 52000],
  },
};

const { best, insights } = parseCheapest(json, route, '2026-09-12');
console.log(`最安 (LCC・乗継除外後): ¥${best.price.toLocaleString('ja-JP')} ${best.airline}`);
if (best.price !== 30500 || best.airline !== 'BC') {
  throw new Error('LCC除外・直行フィルタが期待どおりに動いていません');
}
if (insights.level !== 'low' || insights.typicalRange[0] !== 38000) {
  throw new Error('price_insights の解析が不正です');
}
console.log('price_insights: OK (level=low, 通常レンジ ¥38,000〜¥52,000)');

// price_insights が無いレスポンスでも落ちないこと
const { best: b2, insights: i2 } = parseCheapest(
  { other_flights: [{ price: 45000, flights: [{ flight_number: 'NH 75' }], layovers: [] }] },
  route,
  '2026-09-12',
);
if (b2.price !== 45000 || i2 !== null) throw new Error('insights欠落時の処理が不正です');
console.log('insights欠落時: OK');

console.log('\nSerpAPIパーステスト: すべて成功 ✅');
