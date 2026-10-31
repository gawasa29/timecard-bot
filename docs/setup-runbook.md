# セットアップ手順書（AI エージェント向け）

このボットを新しく Cloudflare と Discord に設定するための手順書です。AI エージェントが上から順に実行できるように書いています。人向けの短い説明は [README](../README.md) にあります。

## 守ること

1. **上から順に実行する。** 各ステップの「成功の条件」を確かめてから次へ進む。
2. **秘密の値を表示しない。** `secrets.json` を `cat` したり、読み込んで全文を出力したりしない。確認にはこの手順書のコマンドを使う。
3. **秘密の値をチャットで受け取らない。** トークンはユーザーに `secrets.json` へ直接書いてもらう。
4. **人の操作が必要な箇所では止まる。** 「👤 ユーザーの操作」と書かれたステップは、代わりに進めず、頼んで返事を待つ。アカウント作成とログインも代行しない。
5. **作り直さない。** すでにあるデータベースを消したり作り直したりしない。消すと打刻データが失われる。
6. **書いていないことでエラーになったら、推測で進めない。** エラー文をそのままユーザーに伝えて止まる。
7. **ユーザーに操作を頼むときは、開く URL をそのまま示す。** 「Developer Portal を開いて」だけで済ませず、クリックできるリンクと、画面のどこを押すかを一緒に伝える。ボットの招待 URL と `WORKER_URL` は、実際の値に置き換えて示す（どちらも秘密の値ではない）。

## 全体の流れ

| # | 内容 | 実行する人 |
|---|---|---|
| 0 | 現在の状態を確認する | AI |
| 1 | 依存関係を入れてテストする | AI |
| 2 | Discord でボットを作り、`secrets.json` に記入する | ユーザー |
| 3 | `secrets.json` の形式を確認する | AI |
| 4 | Cloudflare にログインする | ユーザー |
| 5 | データベースを用意する | AI |
| 6 | テーブルを作ってデプロイする | AI |
| 7 | シークレットを登録する | AI |
| 8 | ボットをサーバーに招待し、コマンドを登録する | ユーザー、AI |
| 9 | Worker に接続できるまで待つ | AI |
| 10 | Interactions Endpoint URL を保存する | ユーザー |
| 11 | 動作を確認する | ユーザー、AI |

コマンドはすべてリポジトリのルートで実行します。

## 0. 現在の状態を確認する

```sh
node -v
git status --short
ls secrets.json
grep database_id wrangler.toml
npx --no-install wrangler whoami
```

| 確認すること | 判断 |
|---|---|
| Node.js が 22.13 以上か | 古ければユーザーに更新を頼んで止まる |
| `secrets.json` があるか | あれば上書きしない。ステップ 3 で中身を確かめる |
| `database_id` が `REPLACE_WITH_DATABASE_ID` か | 実際の ID が入っていれば、ステップ 5 の確認に従う |
| ログイン済みか | `npm` のインストール前は `whoami` が失敗する。ステップ 1 のあとで確かめ直す |

## 1. 依存関係を入れてテストする

```sh
npm ci
npm test
```

**成功の条件:** テストの最後に `fail 0` と表示される。

次の表示は正常なので、対応しません。

- `npm ci` の `install-scripts` の警告（esbuild、fsevents、workerd）
- `npm test` の途中に出る `ボイスの状態を取得できませんでした (500)`（テストがわざと起こすエラーのログ）

ビルドできることも確かめます。

```sh
npx --no-install wrangler deploy --dry-run --outdir "$(mktemp -d)"
```

**成功の条件:** `--dry-run: exiting now.` と表示される。

## 2. 👤 Discord でボットを作り、`secrets.json` に記入する

`secrets.json` がなければ作ります。すでにあるときは上書きしません。

```sh
cp -n secrets.example.json secrets.json
chmod 600 secrets.json
```

ユーザーに次を頼み、終わるまで待ちます。

1. [Discord Developer Portal](https://discord.com/developers/applications) で **New Application** を作る。
2. 開発者モードをオンにする（Discord の **ユーザー設定 → 詳細設定 → 開発者モード**）。
3. `secrets.json` に次の値を書く。

| キー | 確認する場所 |
|---|---|
| `DISCORD_TOKEN` | Developer Portal の **Bot** ページで **Reset Token** を押す |
| `DISCORD_APPLICATION_ID` | 左メニュー一番上の **General Information** |
| `DISCORD_PUBLIC_KEY` | 同じく **General Information** |
| `GUILD_ID` | Discord でサーバーアイコンを右クリック → サーバー ID をコピー |
| `USER_IDS` | 記録する人を右クリック → ユーザー ID をコピー（複数はカンマ区切り） |
| `WORK_VOICE_CHANNEL_IDS` | 勤務用 VC を右クリック → チャンネル ID をコピー（複数はカンマ区切り） |
| `LOG_CHANNEL_ID` | 打刻を流すテキストチャンネルを右クリック。使わないなら行ごと消す |

伝えること: トークンはチャットに貼らず、ファイルに直接書いてください。特権インテント（Presence、Server Members、Message Content）はオンにしなくて大丈夫です。

## 3. `secrets.json` の形式を確認する

値を表示せずに確認します。

```sh
node -e '
const fs = require("fs");
const s = JSON.parse(fs.readFileSync("secrets.json", "utf8"));
const ex = JSON.parse(fs.readFileSync("secrets.example.json", "utf8"));
const id = /^\d{17,20}$/;
const list = (v) => v.split(",").map((x) => x.trim());
const check = {
  DISCORD_TOKEN: (v) => v.trim() === v && v.split(".").length === 3,
  DISCORD_APPLICATION_ID: (v) => id.test(v),
  DISCORD_PUBLIC_KEY: (v) => /^[0-9a-f]{64}$/.test(v),
  GUILD_ID: (v) => id.test(v),
  USER_IDS: (v) => list(v).every((x) => id.test(x)),
  WORK_VOICE_CHANNEL_IDS: (v) => list(v).every((x) => id.test(x)),
  LOG_CHANNEL_ID: (v) => id.test(v),
};
for (const k of Object.keys(check)) {
  if (s[k] === undefined) console.log(k, k === "LOG_CHANNEL_ID" ? "なし（任意）" : "なし（必須）");
  else if (s[k] === ex[k]) console.log(k, "説明文のまま");
  else console.log(k, check[k](s[k]) ? "OK" : "形式が不正");
}
console.log("USER_IDS の件数:", s.USER_IDS === ex.USER_IDS ? 0 : list(s.USER_IDS ?? "").length);
'
```

**成功の条件:** 必須の 6 項目がすべて `OK`。`LOG_CHANNEL_ID` は `OK` か `なし（任意）`。`USER_IDS` の件数がユーザーの想定と合っている。

それ以外の場合は、どのキーを直すかをユーザーに伝えて、ステップ 2 に戻ります。

**注意:** `LOG_CHANNEL_ID` が `説明文のまま` だと、ステップ 7 でその説明文が登録されてしまいます。使わないなら行ごと消してもらいます。

## 4. 👤 Cloudflare にログインする

アカウントがなければ、ユーザーに[無料で作成](https://dash.cloudflare.com/sign-up)してもらいます。

次のコマンドはブラウザを開き、ユーザーが許可するまで待ち続けます。ユーザーが操作できるターミナルで実行します。

```sh
npx wrangler login
```

許可してもらったら、確認します。

```sh
npx --no-install wrangler whoami
```

**成功の条件:** `You are logged in` と表示される。`You are not authenticated` なら、まだ許可が終わっていません。

アカウントが複数表示された場合は、どれを使うかをユーザーに聞きます。

`wrangler deploy --temporary` は使いません。

## 5. データベースを用意する

まず、すでにあるか確かめます。

```sh
npx --no-install wrangler d1 list --json
```

何も表示されないときは、まだ「ない」と判断せず、もう一度実行します。実績では、同じコマンドの結果が一時的に空になることがありました。`[]` と表示されたら、データベースはありません。

**`timecard` がすでにある場合:** 作成しません。一覧の `uuid` が `wrangler.toml` の `database_id` と同じならそのまま進みます。違う場合は `database_id` を一覧の `uuid` に書き換えます。

**`timecard` がない場合:** 作成します。

```sh
npx --no-install wrangler d1 create timecard
```

表示された `database_id` の値を、`wrangler.toml` の `database_id` に書きます。

**間違えやすい点:** コマンドの出力には `binding = "timecard"` という例が出ますが、これはコピーしません。`binding = "DB"` は変えないでください。変えるとコードがデータベースを見つけられなくなります。変えるのは `database_id` の 1 行だけです。

**成功の条件:** `wrangler.toml` の `database_id` が実際の ID になっている。

## 6. テーブルを作ってデプロイする

```sh
npm run db:migrate
npm run deploy
```

**成功の条件:**

- `db:migrate` で `0001_init.sql` が `✅`、または適用済みと表示される
- `deploy` で `https://timecard-bot.<サブドメイン>.workers.dev` と `schedule: * * * * *` が表示される

表示された URL を控えます。以降は `WORKER_URL` と呼びます。

`You need to register a workers.dev subdomain` という警告が出ても、続けて URL が表示されていれば問題ありません。

## 7. シークレットを登録する

```sh
npm run secrets
```

**成功の条件:** `7 secrets successfully created` と表示される（`LOG_CHANNEL_ID` を消した場合は 6）。

## 8. ボットをサーバーに招待し、コマンドを登録する

招待 URL を作ります。

```sh
node -e '
const s = JSON.parse(require("fs").readFileSync("secrets.json", "utf8"));
console.log(`https://discord.com/oauth2/authorize?client_id=${s.DISCORD_APPLICATION_ID}&permissions=3072&scope=bot+applications.commands&guild_id=${s.GUILD_ID}&disable_guild_select=true`);
'
```

`permissions=3072` は `View Channels` と `Send Messages` です。

👤 表示された URL をそのままユーザーに示し、開いて招待してもらって、返事を待ちます。招待するには、そのサーバーの「サーバー管理」権限が必要です。

招待が終わったら、コマンドを登録します。

```sh
npm run setup
```

**成功の条件:** 次の 2 行が表示される。

```
コマンドを登録しました: /panel /today /month /csv /add /addshift /undo
ゲートウェイへの接続を確認しました
```

失敗したら、次のコマンドで原因を調べます。値は表示されません。

```sh
node -e '
const s = JSON.parse(require("fs").readFileSync("secrets.json", "utf8"));
const get = async (p) => {
  const r = await fetch("https://discord.com/api/v10" + p, { headers: { Authorization: `Bot ${s.DISCORD_TOKEN}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
(async () => {
  const me = await get("/users/@me");
  console.log("トークン有効:", me.status === 200);
  const app = await get("/applications/@me");
  console.log("APPLICATION ID 一致:", app.body?.id === s.DISCORD_APPLICATION_ID);
  console.log("PUBLIC KEY 一致:", app.body?.verify_key === s.DISCORD_PUBLIC_KEY);
  const guilds = await get("/users/@me/guilds");
  console.log("GUILD_ID のサーバーに参加:", Array.isArray(guilds.body) && guilds.body.some((g) => g.id === s.GUILD_ID));
})();
'
```

| 結果 | 原因 | 対応 |
|---|---|---|
| トークン有効が `false` | トークンが違う | ユーザーに **Reset Token** で発行し直してもらい、ステップ 3、7、8 をやり直す |
| ID や KEY の一致が `false` | 別のアプリの値が入っている | `secrets.json` を直してもらい、ステップ 3、7、8 をやり直す |
| サーバーに参加が `false`（`Missing Access`、403） | 招待していない、または `GUILD_ID` が違う | 招待 URL を開いてもらい、`npm run setup` をやり直す |

## 9. Worker に接続できるまで待つ

```sh
curl -sS -o /dev/null -w 'GET: %{http_code}\n' --max-time 20 WORKER_URL
curl -sS -o /dev/null -w 'POST: %{http_code}\n' --max-time 20 -X POST -H 'Content-Type: application/json' -d '{"type":1}' WORKER_URL
```

**成功の条件:** `GET: 200` と `POST: 401`。POST は署名がないので、401 で拒否されるのが正しい動作です。

| 結果 | 原因 | 対応 |
|---|---|---|
| `handshake failure`（`curl: (35)`） | サブドメインを作った直後で、証明書を準備中 | 30 秒ごとに試す。実績では数分で解消した。30 分たっても直らなければユーザーに報告する |
| `POST: 500` | シークレットが足りない | ステップ 7 の結果を確かめる |

接続できるまで、次のステップへ進みません。先に進むと保存に失敗します。

## 10. 👤 Interactions Endpoint URL を保存する

ユーザーに頼みます。

1. [Developer Portal](https://discord.com/developers/applications) でアプリを開き、左メニュー一番上の **General Information** を表示する。
2. **Interactions Endpoint URL** に `WORKER_URL` の実際の値を入れて保存する。
3. パネルを置きたいテキストチャンネルで `/panel` を実行する。

保存できたか確かめます。

```sh
node -e '
const s = JSON.parse(require("fs").readFileSync("secrets.json", "utf8"));
fetch("https://discord.com/api/v10/applications/@me", { headers: { Authorization: `Bot ${s.DISCORD_TOKEN}` } })
  .then((r) => r.json())
  .then((a) => console.log("endpoint:", a.interactions_endpoint_url));
'
```

**成功の条件:** `WORKER_URL` が表示される。パネルが表示されたかは AI からは確かめられないので、ユーザーに聞きます。

保存に失敗するときは、ステップ 8 の調査コマンドで `PUBLIC KEY 一致` を確かめます。

## 11. 動作を確認する

### 打刻を調べるコマンド

時刻は日本時間で表示されます。ユーザー ID は末尾 4 桁だけ表示します。

```sh
npx --no-install wrangler d1 execute timecard --remote --json --command "select substr(user_id,-4) as u, type, source, datetime(ts/1000,'unixepoch','+9 hours') as jst from punches order by ts desc limit 10"
npx --no-install wrangler d1 execute timecard --remote --json --command "select substr(user_id,-4) as u, in_voice, datetime(left_at/1000,'unixepoch','+9 hours') as left_jst, version from presence"
```

`punches` が打刻、`presence` が VC の状態です。`left_jst` に値があれば、VC を抜けて猶予中です。

### 確認の手順

1. **定期実行:** デプロイのあと 10 分ほど待ち、`presence` の行数が `USER_IDS` の件数と同じになるか確かめる。ユーザーにパネルのボタンを押してもらう前に確かめる（ボタンでも行ができるため）。実績では、デプロイから最初の実行まで約 7 分かかった。
2. **👤 出勤:** ユーザーに勤務用 VC へ入ってもらい、2 分待つ。`punches` に `in` / `voice` の行があれば成功。
3. **👤 退勤:** ユーザーに VC を抜けてもらう。すぐには退勤にならない。5 分の猶予が過ぎたあとの確認で、`out` / `voice` の行が追加されていれば成功。
4. **👤 表示:** ユーザーに `/today` を実行してもらい、結果が表示されることを確かめる。

ここまで通れば完了です。

### 判断を間違えやすい点

- **VC を抜けてすぐ退勤にならないのは正常です。** 猶予の 5 分（`GRACE_MINUTES`）が過ぎるまで待ちます。退勤の時刻は、猶予が終わった時刻ではなく抜けた時刻です。
- **`/today` は VC の状態を確かめません。** 打刻を表示するだけです。パネルのボタンは、押した時点で VC の状態も確かめます。そのため、ボタンのあとに増えた打刻は、定期実行が動いた証拠になりません。
- **D1 の時刻は UTC で保存されています。** `ts` はミリ秒です。上のコマンドは日本時間に変換しています。
- **`wrangler tail` に何も出なくても、定期実行が止まったとは限りません。** 実績では 90 秒間に何も表示されませんでした。`presence` の変化で判断します。
- **macOS には `timeout` コマンドがありません。** `timeout 20 wrangler tail` のように書くと、実行されないまま空の結果になります。
- **時々 1 分抜けることがあります。** 実績では約 105 分のうち 6 分の実行記録がなく、エラーは 0 件でした。連続して何分も抜けていなければ、異常とは判断しません。

## 完了時にユーザーへ伝えること

- 確認できたことと、確認できなかったこと
- 変更した `wrangler.toml` がコミットされていないこと（コミットは頼まれてから行う）

## セットアップ後の作業

| やりたいこと | 手順 |
|---|---|
| 記録する人を増やす | `secrets.json` の `USER_IDS` を直し、ステップ 3 を実行してから `npm run secrets`。デプロイは不要 |
| 勤務用 VC を変える | `secrets.json` の `WORK_VOICE_CHANNEL_IDS` を直し、同じ手順 |
| 猶予やタイムゾーンを変える | `wrangler.toml` の `[vars]` を直して `npm run deploy` |
| コードを変える | `npm test` のあと `npm run deploy` |
| コマンドの定義を変える | `npm run deploy` のあと `npm run setup` |
| ログを見る | `npm run logs` |
| バックアップする | `npx wrangler d1 export timecard --remote --output backup.sql` |

`backup.sql` には全員の勤務記録が入り、`.gitignore` の対象でもありません。コミットしないでください。
