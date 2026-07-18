import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');

// ローカル実行用に .env があれば読み込む (GitHub Actions では Secrets が環境変数に入る)
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const num = (v, d) => {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) ? n : d;
};
const bool = (v, d) => (v == null || v === '' ? d : String(v).toLowerCase() === 'true');
const str = (v, d) => (v == null || v === '' ? d : v);

const routesFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'routes.json'), 'utf8'));

// 路線ごとの既定値を補完 (国内: 1〜7泊 / 国際: 5〜21泊)
for (const r of routesFile.routes) {
  r.stay ??= r.type === 'dom' ? { min: 1, max: 7 } : { min: 5, max: 21 };
  r.probeStay ??= r.type === 'dom' ? 2 : 7;
}

export const cfg = {
  origin: routesFile.origin,
  months: routesFile.months ?? 6,
  routes: routesFile.routes,
  excludedAirlines: new Set(routesFile.excludedAirlines ?? []),

  tpToken: process.env.TP_TOKEN,
  tpCurrency: str(process.env.TP_CURRENCY, 'jpy').toLowerCase(),

  amadeus: {
    id: process.env.AMADEUS_CLIENT_ID,
    secret: process.env.AMADEUS_CLIENT_SECRET,
    env: str(process.env.AMADEUS_ENV, 'production'), // 動作確認は 'test'
    dailyCap: num(process.env.AMADEUS_DAILY_CAP, 60),
    monthlyCap: num(process.env.AMADEUS_MONTHLY_CAP, 1800),
    verifyReserve: num(process.env.AMADEUS_VERIFY_RESERVE, 15), // 実売検証用に取り置く1日あたりの回数
    priceAnalysis: bool(process.env.AMADEUS_PRICE_ANALYSIS, true),
  },

  mail: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
    to: str(process.env.MAIL_TO, process.env.GMAIL_USER),
    weeklyReport: bool(process.env.WEEKLY_REPORT, true),
  },

  detect: {
    dateDropRatio: num(process.env.DATE_DROP_RATIO, 0.85),   // 同一日付の直近中央値の85%以下 (=15%安) で通知
    monthDropRatio: num(process.env.MONTH_DROP_RATIO, 0.80), // 搭乗月の相場中央値の80%以下 (=20%安) で通知
    realertRatio: num(process.env.REALERT_RATIO, 0.95),      // 再通知は前回通知からさらに5%下がったとき
    minDateObs: num(process.env.MIN_DATE_OBS, 5),
    minMonthObs: num(process.env.MIN_MONTH_OBS, 20),
    bootstrapDays: num(process.env.BOOTSTRAP_DAYS, 7),       // 月間相場系の判定を始めるまでの学習日数
  },

  dryRun: bool(process.env.DRY_RUN, false),
};

export function assertConfig() {
  const missing = [];
  if (!cfg.tpToken) missing.push('TP_TOKEN');
  if (!cfg.dryRun) {
    if (!cfg.mail.user) missing.push('GMAIL_USER');
    if (!cfg.mail.pass) missing.push('GMAIL_APP_PASSWORD');
  }
  if (missing.length) {
    console.error('環境変数が不足しています: ' + missing.join(', '));
    console.error('.env.example を参考に設定してください (DRY_RUN=true ならメール設定は不要)。');
    process.exit(1);
  }
  if (!cfg.amadeus.id || !cfg.amadeus.secret) {
    console.warn('[Amadeus] 認証情報が未設定のため、キャッシュの穴埋めと実売価格の検証はスキップします。');
  }
}
