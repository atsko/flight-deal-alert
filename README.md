# flight-deal-alert ✈️

羽田 (HND) 発の国内・海外航空券を毎朝スキャンし、**往復運賃が「通常より安くなった」ときだけ** Gmail に通知するツールです。GitHub Actions 上で動くので、サーバー不要・月額0円で運用できます。

- 監視対象: 羽田発 11路線 × 直近6ヶ月 — ローマ / ミラノ / マドリード / バルセロナ / パリ / チューリッヒ / シドニー / メルボルン / 那覇 / 新千歳 / 長崎 (`config/routes.json` で変更可)
- 往復運賃ベース・LCC除外
- 価格履歴は `data/prices.json` に毎日コミットされ、それ自体が相場データベースに育っていく

## 仕組み

毎朝7時 (JST) に GitHub Actions が以下を実行します。

1. **広域スキャン** — Travelpayouts (Aviasales) Data API で全路線 × 6ヶ月分の往復キャッシュ価格を取得 (無料・回数課金なし)
2. **穴埋めと初期判定** — キャッシュが薄い路線×月を SerpAPI 経由の Google Flights 検索でサンプリング (無料枠の範囲内で自動調整)。検索結果に付いてくる Google の価格水準判定 (price_insights) で「安い」とされた日程はそのまま通知候補になる
3. **割安判定** — 自前の価格履歴と比較して判定 (下記)
4. **実売検証** — キャッシュ由来の通知候補は Google Flights で「本当に今その価格で買えるか」を確認してから通知
5. **通知と記録** — 割安便があれば Gmail にダイジェスト送信、履歴をリポジトリにコミット

### 割安の判定基準

| 条件 | 内容 | 既定値 |
|---|---|---|
| date_drop | 同じ出発日の直近30日中央値より安い | 15%安 (`DATE_DROP_RATIO=0.85`) |
| month_low | 同じ搭乗月の相場中央値 (45日プール) より安い | 20%安 (`MONTH_DROP_RATIO=0.80`) |
| new_low | その搭乗月の観測最安値を更新 | — |
| google_low | Google Flights の価格水準判定が「安い」 | SerpAPI設定時 |

- 同じ便は前回通知からさらに5%下がるまで再通知しません (`REALERT_RATIO=0.95`)
- 履歴が貯まるまでの最初の約2週間は、各路線の最安日を日替わりで Google Flights に照会するため、google_low 条件が主に働きます

## セットアップ (約15分)

### 1. このフォルダをGitHubリポジトリにする

```bash
cd flight-deal-alert
git init && git add -A && git commit -m "init"
gh repo create flight-deal-alert --private --source=. --push
# gh を使わない場合は Web でリポジトリを作って git push
```

### 2. Travelpayouts のトークンを取得 (無料)

1. https://www.travelpayouts.com/ でアカウント登録
2. プログラム一覧から **Aviasales** に参加
3. ツール → **API** からトークンをコピー

### 3. SerpAPI のキーを取得 (無料)

1. https://serpapi.com/ で登録 (無料プランは執筆時点で月100検索前後。登録後にダッシュボードで自分の枠を確認してください)
2. ダッシュボードに表示される **Api Key** をコピー

本ツールは既定で月90回以下に自動制御するので、無料枠内に収まります。

> 補足: 以前この役割を担っていた Amadeus Self-Service API は 2026年7月17日に廃止されたため、SerpAPI 経由の Google Flights 検索に置き換えています。

### 4. Gmail アプリパスワードを発行

1. Googleアカウントで **2段階認証** を有効化
2. https://myaccount.google.com/apppasswords で16桁のアプリパスワードを発行

### 5. GitHub Secrets を登録

リポジトリの Settings → Secrets and variables → Actions → **New repository secret**

| Secret名 | 内容 |
|---|---|
| `TP_TOKEN` | Travelpayouts のトークン |
| `SERPAPI_KEY` | SerpAPI の Api Key |
| `GMAIL_USER` | 送信元Gmailアドレス |
| `GMAIL_APP_PASSWORD` | 手順4の16桁 |
| `MAIL_TO` | (任意) 通知先。省略時は GMAIL_USER 宛 |

### 6. 初回実行

Actions タブ → **daily-scan** → **Run workflow**。完了すると初回レポートのメールが届き、以後は毎朝7時 (JST) に自動実行されます。

## ローカルで試す

```bash
npm install
npm run selftest        # APIキー不要。判定ロジックの動作確認
cp .env.example .env    # トークン類を記入
npm run scan
```

`.env` で `DRY_RUN=true` にすると、メールを送らずコンソール出力のみで確認できます (Gmail設定も不要)。

## 無料枠の収支 (既定構成)

| API | 使い方 | 1日あたり | 無料枠 |
|---|---|---|---|
| Travelpayouts Data API | 11路線 × 6ヶ月の広域スキャン (国内線は都市コードでの補完検索込み) | 最大84回 | 回数課金なし |
| SerpAPI (Google Flights) | 初期判定・穴埋め + 実売検証 | 最大5回 (`SERPAPI_DAILY_CAP`) | 月100回 (90回で自動停止) |

## カスタマイズ

**路線** — `config/routes.json` を編集します。

| フィールド | 意味 |
|---|---|
| `dest` | 目的地のIATAコード (ROM, PAR などの都市コード可) |
| `label` | メールに表示する名前 |
| `type` | `intl` / `dom` (滞在日数などの既定値が変わる) |
| `stay` | 往復の滞在日数の範囲。範囲外の運賃は無視 (既定: 国際 5〜21泊、国内 1〜7泊) |
| `probeStay` | Google Flightsで穴埋め検索するときの滞在日数 (既定: 国際7泊、国内2泊) |
| `direct` | `true` で直行便のみ |
| `gfDest` | Google Flights検索に使う代表空港 (都市コードの路線のみ。例: ROM→FCO) |

**国内線のキャッシュ補完** — トップレベルの `originCity` (既定: TYO) を設定すると、国内線は東京の都市コードでも検索し、羽田発のチケットだけを取り込みます。不要なら削除してください。

**LCCの範囲** — `excludedAirlines` (2レターコード) を編集。スカイマーク・ソラシド・スターフライヤーはLCC扱いにしていません。

**しきい値** — `.env` またはワークフローの env で `DATE_DROP_RATIO` などを上書きできます。

## よくある質問

**通知が来ない** — 最初の約1週間は履歴の学習期間です。また、割安便ゼロの日はメール自体を送りません (毎週月曜の稼働レポートは `WEEKLY_REPORT=true` で送信されます)。

**カバー率が低い路線がある** — Aviasalesのキャッシュはユーザー検索に依存するため、地方路線 (長崎など) は薄くなりがちです。国内線は東京の都市コード (TYO) での補完検索に加え、Google Flights (SerpAPI) の穴埋めが1日1〜2日付ずつ埋めていきます。ペースは控えめですが、履歴が貯まるほどTravelpayouts側の相場判定が効くようになります。

**「検索キャッシュの価格 (要確認)」と出る** — その日のSerpAPI検証予算を使い切った場合、Aviasalesキャッシュの価格のまま通知します。リンク先で実際の運賃を確認してください。

**Actionsが止まった** — GitHubの仕様で、60日間リポジトリに更新がないと schedule は無効化されます。本ツールは毎日履歴をコミットするので通常は自走しますが、長期停止後は Actions タブから再有効化してください。

**価格が日本円で返ってこない** — `TP_CURRENCY` の指定を確認してください (既定: `jpy`)。実行ログに通貨の警告が出ます。
