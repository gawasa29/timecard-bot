// 初回とコマンドを変えたときに手元で実行する: npm run setup
// 1. スラッシュコマンドをサーバーに登録する
// 2. ゲートウェイに一度だけ接続する（Discord は、一度も接続したことのないボットのメッセージ送信を受け付けない）

import { readFileSync } from 'node:fs';
import { COMMANDS } from '../src/commands.js';

const API = 'https://discord.com/api/v10';
const file = process.argv[2] ?? 'secrets.json';
const secrets = JSON.parse(readFileSync(file, 'utf8'));
for (const name of ['DISCORD_TOKEN', 'DISCORD_APPLICATION_ID', 'GUILD_ID']) {
  if (!secrets[name]) throw new Error(`${file} に ${name} を入れてください`);
}
const { DISCORD_TOKEN: token, DISCORD_APPLICATION_ID: applicationId, GUILD_ID: guildId } = secrets;

const res = await fetch(`${API}/applications/${applicationId}/guilds/${guildId}/commands`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(COMMANDS),
});
if (!res.ok) throw new Error(`コマンドを登録できませんでした (${res.status}): ${await res.text()}`);
console.log(`コマンドを登録しました: ${COMMANDS.map((c) => `/${c.name}`).join(' ')}`);

await identifyOnce(token);
console.log('ゲートウェイへの接続を確認しました');

function identifyOnce(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('ゲートウェイへの接続がタイムアウトしました'));
    }, 20000);
    const finish = (err) => {
      clearTimeout(timer);
      ws.close();
      if (err) reject(err);
      else resolve();
    };
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.op === 10) {
        ws.send(JSON.stringify({ op: 2, d: { token, intents: 0, properties: { os: process.platform, browser: 'timecard-bot', device: 'timecard-bot' } } }));
      } else if (msg.op === 0 && msg.t === 'READY') {
        finish();
      } else if (msg.op === 9) {
        finish(new Error('ゲートウェイに拒否されました。トークンを確認してください'));
      }
    });
    ws.addEventListener('close', (event) => {
      if (event.code >= 4000) finish(new Error(`ゲートウェイに拒否されました (${event.code} ${event.reason})`));
    });
    ws.addEventListener('error', () => finish(new Error('ゲートウェイに接続できませんでした')));
  });
}
