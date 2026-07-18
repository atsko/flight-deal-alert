import { cfg } from './config.js';
import { sleep } from './util.js';

const BASE = () =>
  cfg.amadeus.env === 'test' ? 'https://test.api.amadeus.com' : 'https://api.amadeus.com';

export const enabled = () => Boolean(cfg.amadeus.id && cfg.amadeus.secret);

let token = null;
let tokenExp = 0;

async function getToken() {
  if (token && Date.now() < tokenExp - 60_000) return token;
  const res = await fetch(`${BASE()}/v1/security/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.amadeus.id,
      client_secret: cfg.amadeus.secret,
    }),
  });
  if (!res.ok) throw new Error(`認証に失敗 (HTTP ${res.status})`);
  const json = await res.json();
  token = json.access_token;
  tokenExp = Date.now() + (json.expires_in ?? 1799) * 1000;
  return token;
}

// 認証付きGET。呼び出し回数は counter.calls に加算 (無料枠の管理用)
async function get(pathname, params, counter) {
  counter.calls++;
  try {
    const t = await getToken();
    const url = `${BASE()}${pathname}?${new URLSearchParams(params)}`;
    let res = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
    if (res.status === 429) {
      await sleep(1500);
      res = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
    }
    await sleep(300); // 秒間リクエスト制限への配慮
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

const gfLink = (dest, dep, ret) =>
  'https://www.google.com/travel/flights?q=' +
  encodeURIComponent(`Flights from ${cfg.origin} to ${dest} on ${dep} through ${ret}`);

// 指定日の往復最安運賃 (実際に予約可能なGDS運賃) を取得
export async function cheapestOffer(route, depDate, retDate, counter) {
  const params = {
    originLocationCode: cfg.origin,
    destinationLocationCode: route.dest,
    departureDate: depDate,
    returnDate: retDate,
    adults: '1',
    currencyCode: 'JPY',
    max: '5',
  };
  if (route.direct) params.nonStop = 'true';

  const json = await get('/v2/shopping/flight-offers', params, counter);
  if (json.error) {
    console.warn(`[Amadeus] ${route.dest} ${depDate}: ${json.error}`);
    return null;
  }

  let best = null;
  for (const offer of json.data ?? []) {
    const price = Number(offer.price?.grandTotal);
    if (!Number.isFinite(price)) continue;
    const airline = offer.validatingAirlineCodes?.[0] ?? '?';
    if (cfg.excludedAirlines.has(airline)) continue; // LCC除外
    const transfers = (offer.itineraries ?? []).reduce(
      (s, it) => s + Math.max(0, (it.segments?.length ?? 1) - 1),
      0,
    );
    if (!best || price < best.price) {
      best = { price, retDate, airline, transfers, link: gfLink(route.dest, depDate, retDate), source: 'am' };
    }
  }
  return best;
}

// 過去運賃の四分位分布 (履歴が貯まるまでの初期判定に使用)
export async function priceMetrics(dest, depDate, counter) {
  const json = await get(
    '/v1/analytics/itinerary-price-metrics',
    {
      originIataCode: cfg.origin,
      destinationIataCode: dest,
      departureDate: depDate,
      currencyCode: 'JPY',
      oneWay: 'false',
    },
    counter,
  );
  if (json.error || !json.data?.[0]?.priceMetrics) return null;
  const m = {};
  for (const q of json.data[0].priceMetrics) m[q.quartileRanking] = Number(q.amount);
  return m; // { MINIMUM, FIRST, MEDIUM, THIRD, MAXIMUM }
}
