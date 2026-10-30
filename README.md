# タイムカード（Discord ボット）

ボイスチャンネルにいる時間を勤務時間として記録する Discord ボットです。休憩と散歩はボタンで記録し、どちらも実働から引きます。

Cloudflare Workers の上で動くので、常時起動のサーバーはいりません。1 分ごとに、記録する人が勤務用のボイスチャンネルにいるかを Discord に問い合わせます。

## 使い方

- **出勤・退勤**: 勤務用のボイスチャンネル（VC）に入ると出勤、抜けると退勤です。1 分ごとに確かめるので、記録される時刻は最大 1 分ずれます。
  - 回線が切れても、5 分以内（`GRACE_MINUTES`）に戻れば勤務が続きます。退勤の時刻は抜けた時刻です。
  - 勤務用 VC どうしの移動や、ミュートでは何も起きません。1 分未満の出入りは記録されないことがあります。
- **休憩・散歩**: `/panel` で置いたパネルのボタンで記録します。ボタンを押すと、その時点で VC にいるかもすぐ確かめます。
  - 休憩・散歩中は VC を抜けても退勤になりません。VC に戻ると自動で終わります（ボタンで終えることもできます）。
  - VC を抜けた直後（猶予中）に開始ボタンを押すと、抜けた時刻から休憩・散歩になります。
  - VC の外で 3 時間（`MAX_AWAY_MINUTES`）たっても戻らない休憩・散歩は、抜けた時点で退勤したものとみなします。
  - 休憩と散歩は同時にはできません。
- **退勤（VCの外から）**: 休憩・散歩に出たまま戻らずに終わる日は、このボタンで退勤します。
- 日付をまたぐ勤務は、出勤した日の勤務として数えます。

### コマンド

結果は本人にだけ表示されます。`user` を指定すると、ほかの人の記録も見られます。

| コマンド | 内容 |
|---|---|
| `/panel` | 休憩・散歩ボタンのパネルをそのチャンネルに置く（サーバー管理権限が必要） |
| `/today [user]` | 今日の状況と打刻 |
| `/month [month] [user]` | 月の出勤日数・実働・休憩・散歩と日ごとの一覧（`month` は `2026-10` の形式） |
| `/csv [month] [user]` | 月の記録を CSV で受け取る（Excel で開けます） |
| `/add type time [date]` | 打刻し忘れた分を 1 つ追加する（自分の分だけ） |
| `/addshift start end [date]` | 勤務ごと記録し忘れた日の出勤と退勤をまとめて追加する。退勤が出勤より前の時刻なら翌日として扱う |
| `/undo` | 自分が最後に記録した打刻を取り消す |

時刻を直したいときは、`/undo` で消してから `/add` で入れ直してください。打刻の順番が合わなくなる追加（出勤していないのに休憩開始など）はできません。

`LOG_CHANNEL_ID` を設定すると、打刻のたびにそのチャンネルへ「🟢 @名前 出勤 09:02」のように流れます（メンションの通知は飛びません）。

## セットアップ

手元のパソコンに Node.js 22.13 以上が必要です。最初に一度だけ次の手順を行います。

### 1. Discord でボットを作る

1. [Discord Developer Portal](https://discord.com/developers/applications) で **New Application** を作ります。
2. **General Information** の **APPLICATION ID** と **PUBLIC KEY** を控えます。
3. **Bot** ページで **Reset Token** を押し、表示されたトークンを控えます。トークンは人に見せないでください。
   - 特権インテント（Presence / Server Members / Message Content）はどれも不要です。
4. **OAuth2 → URL Generator** で、Scopes に `bot` と `applications.commands`、Bot Permissions に `View Channels` と `Send Messages` を選び、できた URL を開いてサーバーに招待します。

### 2. ID を調べる

Discord の **ユーザー設定 → 詳細設定 → 開発者モード** をオンにすると、右クリックで ID をコピーできます。

- サーバーアイコン → **サーバー ID をコピー**（`GUILD_ID`）
- 記録する人（2 人とも） → **ユーザー ID をコピー**（`USER_IDS`）
- 勤務用の VC → **チャンネル ID をコピー**（`WORK_VOICE_CHANNEL_IDS`）
- 打刻を流すテキストチャンネル（任意） → **チャンネル ID をコピー**（`LOG_CHANNEL_ID`）

### 3. 設定ファイルを作る

`secrets.example.json` をコピーして `secrets.json` を作り、控えた値を入れます。複数の ID はカンマで区切ります。`LOG_CHANNEL_ID` を使わないなら、その行を消します。`secrets.json` は Git に入りません。

### 4. Cloudflare に置く

[Cloudflare](https://dash.cloudflare.com/sign-up) の無料アカウントを作ってから、このフォルダで次を実行します。

```sh
npm install
npx wrangler login              # ブラウザで Cloudflare にログイン
npx wrangler d1 create timecard # 表示された database_id を wrangler.toml に書く
npm run db:migrate              # 記録用のテーブルを作る
npm run deploy                  # 公開。https://timecard-bot.<あなたのサブドメイン>.workers.dev が表示される
npm run secrets                 # secrets.json の値を Cloudflare に入れる
npm run setup                   # スラッシュコマンドを登録する
```

### 5. Discord とつなぐ

Developer Portal の **General Information → Interactions Endpoint URL** に、`npm run deploy` で表示された URL を入れて保存します。保存できれば、Discord からボットに届いています。

最後に、パネルを置きたいテキストチャンネルで `/panel` を実行します。

## 運用

- **更新**: コードを変えたら `npm run deploy`。コマンドを変えたら `npm run setup` も実行します。
- **設定の変更**: `secrets.json` を直して `npm run secrets`。猶予やタイムゾーンは `wrangler.toml` の `[vars]` を直して `npm run deploy`。
- **ログを見る**: `npm run logs`
- **バックアップ**: `npx wrangler d1 export timecard --remote --output backup.sql`
- **無料プランの範囲**: 1 分ごとの確認で 1 日 1,440 回動きます。Workers と D1 の無料枠に収まる想定ですが、上限は [Cloudflare の公式ページ](https://developers.cloudflare.com/workers/platform/limits/) で確認してください。

## 開発

```sh
npm test
```

| ファイル | 内容 |
|---|---|
| `src/worker.js` | Worker の入り口（Discord からのリクエストと 1 分ごとの確認） |
| `src/interactions.js` | コマンド、ボタンパネル、返信 |
| `src/tracker.js` | VC にいるかどうかとボタンを打刻に変えるルール |
| `src/shifts.js` | 打刻を勤務にまとめて集計する |
| `src/report.js` | 今日・月の表示と CSV |
| `src/time.js` | タイムゾーンの変換（Workers の時計は UTC） |
| `src/store.js` | D1 への保存（スキーマは `migrations/`） |
| `src/discord.js` | Discord の REST API と署名の検証 |
| `src/commands.js` | スラッシュコマンドの定義 |
| `scripts/setup.js` | コマンドの登録 |
