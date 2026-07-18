# flight-deal-alert ✈️

羽田 (HND) 発の国内・海外航空券を毎朝スキャンし、**往復運賃が「通常より安くなった」ときだけ** Gmail に通知するツールです。GitHub Actions 上で動くので、サーバー不要・月額0円で運用できます。

- 監視対象: 羽田発 11路線 × 直近6ヶ月 — ローマ / ミラノ / マドリード / バルセロナ / パリ / チューリッヒ / シドニー / メルボルン / 那覇 / 新千歳 / 長崎 (`config/routes.json` で変更可)
- 往復運賃ベース・LCC除外
- 価格履歴は `data/prices.json` に毎日コミットされ、それ自体が相場データベースに育っていく

## 仕組み

毎朝7時 (JST) に GitHub Actions が以下を実行します。

1. **広域スキャン** — Travelpayouts (Aviasales) Data API で全路線 × 6ヶ月分の往復キャッシュ価格を取得 (無料・回数課金なし)
2. **穴埋め** — キャッシュが薄い路線×月を Amadeus Flight Offers Search でサンプリング (無料枠の範囲内で自動調整)
3. **割安判定** — 自前の価格履歴と比較して3条件で判定 (下記)
4. **実売検証** — 通知候補は Amadeus で「本当に今その価格で買えるか」を確認してから通知
5. **通知と記録** — 割安便があれば Gmail にダイジェスト送信、履歴をリポジトリにコミット

### 割安の判定基準

| 条件 | 内容 | 既定値 |
|---|---|---|
| date_drop | 同じ出発日の直近30日中央値より安い | 15%安 (`DATE_DROP_RATIO=0.85`) |
| month_low | 同じ搭乗月の相場中央値 (45日プール) より安い | 20%安 (`MONTH_DROP_RATIO=0.80`) |
| new_low | その搭乗月の観測最安値を更新 | — |

- 同じ便は前回通知からさらに5%下がるまで再通知しません (`REALERT_RATIO=0.95`)
- 履歴が貯まるまでの最初の約2週間は、Amadeus Flight Price Analysis (過去運賃の四分位) を使った補助判定で動きます

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

### 3. Amadeus for Developers のキーを取得

1. https://developers.amadeus.com/ で登録 → My Self-Service Workspace → **Create New App**
2. まずは Test 環境のキーで動作確認できます (リポジトリ Variables に `AMADEUS_ENV = test`)
3. 実運用は App を **Production に移行** (クレジットカード登録が必要。Flight Offers Search は月2,000回まで無料で、本ツールは既定で月1,800回以下に自動制御します)

### 4. Gmail アプリパスワードを発行

1. Googleアカウントで **2段階認証** を有効化
2. https://myaccount.google.com/apppasswords で16桁のアプリパスワードを発行

### 5. GitHub Secrets を登録

リポジトリの Settings → Secrets and variables → Actions → **New repository secret**

| Secret名 | 内容 |
|---|---|
| `TP_TOKEN` | Travelpayouts のトークン |
| `AMADEUS_CLIENT_ID` | Amadeus の API Key |
| `AMADEUS_CLIENT_SECRET` | Amadeus の API Secret |
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
| Travelpayouts Data API | 11路線 × 6ヶ月の広域スキャン | 66回 | 回数課金なし |
| Amadeus Flight Offers Search | 穴埋め + 実売検証 | 最大60回 (`AMADEUS_DAILY_CAP`) | 月2,000回 (1,800回で自動停止) |
| Amadeus Flight Price Analysis | 初期判定 (最初の約2週間のみ) | 最大11回 | 別枠 |

## カスタマイズ

**路線** — `config/routes.json` を編集します。

| フィールド | 意味 |
|---|---|
| `dest` | 目的地のIATAコード (ROM, PAR などの都市コード可) |
| `label` | メールに表示する名前 |
| `type` | `intl` / `dom` (滞在日数などの既定値が変わる) |
| `stay` | 往復の滞在日数の範囲。範囲外の運賃は無視 (既定: 国際 5〜21泊、国内 1〜7泊) |
| `probeStay` | Amadeusで穴埋め検索するときの滞在日数 (既定: 国際7泊、国内2泊) |
| `direct` | `true` で直行便のみ |

**LCCの範囲** — `excludedAirlines` (2レターコード) を編集。スカイマーク・ソラシド・スターフライヤーはLCC扱いにしていません。

**しきい値** — `.env` またはワークフローの env で `DATE_DROP_RATIO` などを上書きできます。

## よくある質問

**通知が来ない** — 最初の約1週間は履歴の学習期間です。また、割安便ゼロの日はメール自体を送りません (毎週月曜の稼働レポートは `WEEKLY_REPORT=true` で送信されます)。

**カバー率が低い路線がある** — Aviasalesのキャッシュはユーザー検索に依存するため、地方路線 (長崎など) は薄くなりがちです。Amadeusの穴埋めが毎日少しずつ埋めていきます。急ぎたい場合は `AMADEUS_DAILY_CAP` を上げられますが、無料枠 (月2,000回) にご注意ください。

**「検索キャッシュの価格 (要確認)」と出る** — その日のAmadeus検証予算を使い切った場合、Aviasalesキャッシュの価格のまま通知します。リンク先で実際の運賃を確認してください。

**Actionsが止まった** — GitHubの仕様で、60日間リポジトリに更新がないと schedule は無効化されます。本ツールは毎日履歴をコミットするので通常は自走しますが、長期停止後は Actions タブから再有効化してください。

**価格が日本円で返ってこない** — `TP_CURRENCY` の指定を確認してください (既定: `jpy`)。実行ログに通貨の警告が出ます。
