import { cfg } from './config.js';
import { sleep } from './util.js';

const BASE = 'https://serpapi.com/search.json';

export const enabled = () => Boolean(cfg.serpapi.key);

export const gfLink = (dest, dep, ret) =>
  'https://www.google.com/travel/flights?q=' +
  encodeURIComponent(`Flights from ${cfg.origin} to ${dest} on ${dep} through ${ret}`);

const AIRLINE_CODE = /^([A-Z0-9]{2})\s?\d/; // "NH 461" -> "NH"

// レスポンスから最安の便 (LCC除外後) と Google の価格水準判定を取り出す (純粋関数・テスト対象)
export function parseCheapest(json, route, retDate) {
  const options = [...(json.best_flights ?? []), ...(json.other_flights ?? [])];
  let best = null;
  for (const opt of options) {
    const price = Number(opt.price); // 往復検索では往復合計金額
    if (!Number.isFinite(price) || price <= 0) continue;
    const segs = opt.flights ?? [];
    const codes = segs.map((f) => f.flight_number?.match(AIRLINE_CODE)?.[1]).filter(Boolean);
    if (codes.some((c) => cfg.excludedAirlines.has(c))) continue; // LCC除外
    if (route.direct && segs.length > 1) continue; // 直行指定の路線は乗継便を捨てる
    const transfers = (opt.layovers ?? []).length;
    const airline = codes[0] ?? segs[0]?.airline ?? '?';
    if (!best || price < best.price) best = { price, retDate, airline, transfers };
  }

  const pi = json.price_insights;
  const insights = pi
    ? {
        level: typeof pi.price_level === 'string' ? pi.price_level.toLowerCase() : null, // low / typical / high
        typicalRange: Array.isArray(pi.typical_price_range)
          ? pi.typical_price_range.map(Number)
          : null,
        lowestPrice: Number(pi.lowest_price) || null,
      }
    : null;

  return { best, insights };
}

// 指定日の往復を Google Flights (SerpAPI経由) で検索する。
// 往復検索の初回レスポンスは「往路候補 × 往復合計金額」の一覧なので、最安の合計金額は1コールで取れる
// (復路の便まで特定するには追加コールが要るが、価格監視には不要)。
export async function cheapestOffer(route, depDate, retDate, counter) {
  counter.calls++;
  const params = new URLSearchParams({
    engine: 'google_flights',
    departure_id: cfg.origin,
    arrival_id: route.gfDest ?? route.dest, // 都市コードの路線は代表空港 (routes.json の gfDest)
    outbound_date: depDate,
    return_date: retDate,
    type: '1', // 往復
    currency: 'JPY',
    hl: 'en', // price_level を 'low' 等の英語表記で安定して受け取るため
    gl: 'jp',
    deep_search: 'true', // ブラウザ版と同等の価格精度 (応答は遅くなるが呼び出しは少数)
    api_key: cfg.serpapi.key,
  });
  if (route.direct) params.set('stops', '1'); // 1 = 直行便のみ

  let json;
  try {
    const res = await fetch(`${BASE}?${params}`);
    await sleep(300);
    if (!res.ok) {
      console.warn(`[SerpAPI] ${route.dest} ${depDate}: HTTP ${res.status}`);
      return null;
    }
    json = await res.json();
  } catch (e) {
    console.warn(`[SerpAPI] ${route.dest} ${depDate}: 通信エラー (${e.message})`);
    return null;
  }
  if (json.error) {
    console.warn(`[SerpAPI] ${route.dest} ${depDate}: ${json.error}`);
    return null;
  }

  const { best, insights } = parseCheapest(json, route, retDate);
  if (!best) return null;
  return { ...best, link: gfLink(route.gfDest ?? route.dest, depDate, retDate), source: 'gf', insights };
}
