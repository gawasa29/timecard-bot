# タイムカード（Discord ボット）

ボイスチャンネルにいる時間を勤務時間として記録する Discord ボットです。休憩と散歩はボタンで記録し、どちらも実働から引きます。

## 使い方

- **出勤・退勤**: 勤務用のボイスチャンネル（VC）に入ると出勤、抜けると退勤です。
  - 回線が切れても、5 分以内（`GRACE_MINUTES`）に戻れば勤務が続きます。退勤の時刻は抜けた時刻です。
  - 勤務用 VC どうしの移動や、ミュート・スピーカーミュートでは何も起きません。
- **休憩・散歩**: `/panel` で置いたパネルのボタンで記録します。
  - 休憩・散歩中は VC を抜けても退勤になりません。VC に戻ると自動で終わります（ボタンで終えることもできます）。
  - VC を抜けた直後（猶予中）に開始ボタンを押すと、抜けた時刻から休憩・散歩になります。
  - 3 時間（`MAX_AWAY_MINUTES`）たっても戻らない休憩・散歩は、抜けた時点で退勤したものとみなします。
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
| `/add type time [date]` | 打刻し忘れた分を手動で追加する（自分の分だけ。順番が合わない打刻は追加できません） |
| `/undo` | 自分が最後に記録した打刻を取り消す |

時刻を直したいときは、`/undo` で消してから `/add` で入れ直してください。

`LOG_CHANNEL_ID` を設定すると、打刻のたびにそのチャンネルへ「🟢 @名前 出勤 09:02」のように流れます（メンションの通知は飛びません）。

## セットアップ

### 1. Discord でボットを作る

1. [Discord Developer Portal](https://discord.com/developers/applications) で **New Application** を作ります。
2. **Bot** ページで **Reset Token** を押し、表示されたトークンを控えます（`DISCORD_TOKEN`）。トークンは人に見せないでください。
   - 特権インテント（Presence / Server Members / Message Content）はどれも不要です。
3. **OAuth2 → URL Generator** で、Scopes に `bot` と `applications.commands`、Bot Permissions に `View Channels` と `Send Messages` を選び、できた URL を開いてサーバーに招待します。

### 2. ID を調べる

Discord の **ユーザー設定 → 詳細設定 → 開発者モード** をオンにすると、右クリックで ID をコピーできます。

- サーバーアイコン → **サーバー ID をコピー**（`GUILD_ID`）
- 勤務用の VC → **チャンネル ID をコピー**（`WORK_VOICE_CHANNEL_IDS`）
- 打刻を流すテキストチャンネル（任意） → **チャンネル ID をコピー**（`LOG_CHANNEL_ID`）

### 3. 起動する

Node.js 22.13 以上が必要です。

```sh
cp .env.example .env   # 値を入れる
npm ci
npm start
```

「〇〇 として △△ で起動しました」と出たら、テキストチャンネルで `/panel` を実行してパネルを置きます。

### Docker で動かす場合

```sh
docker build -t timecard-bot .
docker run -d --name timecard-bot --restart unless-stopped --env-file .env -v timecard-data:/app/data timecard-bot
```

### 常に動かしておく

ボットは Discord と接続し続ける必要があるので、常に動いているサーバーに置きます。止まっている間の入退室は記録されません。起動したときに、VC にいる人は出勤、いないのに勤務中の人は退勤として補正します。

Linux サーバーなら systemd で自動起動できます（パスは置いた場所に合わせてください）。

```ini
# /etc/systemd/system/timecard-bot.service
[Unit]
Description=Timecard Discord bot
After=network-online.target

[Service]
WorkingDirectory=/opt/timecard-bot
ExecStart=/usr/bin/npm start
Restart=always
User=timecard

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now timecard-bot
```

## データ

記録は SQLite ファイル（`DB_PATH`、既定は `data/timecard.db`）に保存します。ときどきこのファイルをコピーしてバックアップしてください。

## 開発

```sh
npm test
```

| ファイル | 内容 |
|---|---|
| `src/index.js` | 起動、Discord のイベントの受け取り |
| `src/bot.js` | コマンド、ボタンパネル、返信 |
| `src/tracker.js` | VC の入退室とボタンを打刻に変えるルール |
| `src/shifts.js` | 打刻を勤務にまとめて集計する |
| `src/report.js` | 今日・月の表示と CSV |
| `src/store.js` | SQLite への保存 |
| `src/config.js` | 環境変数の読み込み |
