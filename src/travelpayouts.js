import { cfg } from './config.js';
import { sleep, diffDays } from './util.js';

const BASE = 'https://api.travelpayouts.com/aviasales/v3/prices_for_dates';
let currencyWarned = false;

// 1路線×1ヶ月分の往復キャッシュ価格を取得し、出発日ごとの最安 (LCC除外後) に集約する
export async function scanRouteMonth(route, month, today) {
  const params = new URLSearchParams({
    origin: cfg.origin,
    destination: route.dest,
    departure_at: month, // YYYY-MM 指定でその月の全日付が対象
    one_way: 'false',    // 往復運賃
    direct: String(!!route.direct),
    unique: 'false',
    sorting: 'price',
    limit: '1000',
    currency: cfg.tpCurrency,
    token: cfg.tpToken,
  });

  let json;
  try {
    const res = await fetch(`${BASE}?${params}`);
    if (!res.ok) {
      console.warn(`[TP] ${route.dest} ${month}: HTTP ${res.status}`);
      return {};
    }
    json = await res.json();
  } catch (e) {
    console.warn(`[TP] ${route.dest} ${month}: 通信エラー (${e.message})`);
    return {};
  }
  if (!json.success) {
    console.warn(`[TP] ${route.dest} ${month}: ${json.error ?? '不明なエラー'}`);
    return {};
  }
  if (!currencyWarned && json.currency && String(json.currency).toLowerCase() !== cfg.tpCurrency) {
    console.warn(`[TP] 通貨が ${json.currency} で返っています。TP_CURRENCY の指定を確認してください。`);
    currencyWarned = true;
  }

  const best = {}; // depDate -> observation
  for (const t of json.data ?? []) {
    const dep = String(t.departure_at ?? '').slice(0, 10);
    const ret = String(t.return_at ?? '').slice(0, 10);
    if (!dep || !ret || dep <= today) continue;

    const stay = diffDays(dep, ret);
    if (stay < route.stay.min || stay > route.stay.max) continue; // 滞在日数フィルタ
    if (cfg.excludedAirlines.has(t.airline)) continue;            // LCC除外
    if (route.direct && ((t.transfers ?? 0) > 0 || (t.return_transfers ?? 0) > 0)) continue;

    const price = Number(t.price);
    if (!Number.isFinite(price) || price <= 0) continue;

    if (!best[dep] || price < best[dep].price) {
      best[dep] = {
        price,
        retDate: ret,
        airline: t.airline ?? '?',
        transfers: (t.transfers ?? 0) + (t.return_transfers ?? 0),
        link: t.link ? 'https://www.aviasales.com' + t.link : null,
        source: 'tp',
      };
    }
  }
  return best;
}

// 全路線 × 監視対象月を順にスキャン
export async function scanAll(months, today) {
  const result = {}; // routeKey -> depDate -> observation
  for (const route of cfg.routes) {
    const key = `${cfg.origin}-${route.dest}`;
    result[key] = {};
    for (const month of months) {
      Object.assign(result[key], await scanRouteMonth(route, month, today));
      await sleep(350); // レート制限への配慮
    }
    console.log(`[TP] ${key}: ${Object.keys(result[key]).length}日分の価格を取得`);
  }
  return result;
}
