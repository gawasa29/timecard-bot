import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './d1.js';
import worker from '../src/worker.js';

const hex = (buf) => Buffer.from(buf).toString('hex');
const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const publicKey = hex(await crypto.subtle.exportKey('raw', keys.publicKey));

// Discord の REST API の代わり
function fakeDiscord() {
  const voice = new Map(); // userId -> channelId
  const messages = [];
  let failing = false;
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    if (failing) return new Response('{"message":"oops"}', { status: 500 });
    const vs = pathname.match(/^\/api\/v10\/guilds\/g1\/voice-states\/(\w+)$/);
    if (vs) {
      const channelId = voice.get(vs[1]);
      return channelId ? Response.json({ channel_id: channelId, user_id: vs[1] }) : Response.json({ code: 10065 }, { status: 404 });
    }
    if (pathname === '/api/v10/channels/log1/messages' && init.method === 'POST') {
      messages.push(JSON.parse(init.body).content);
      return Response.json({ id: 'm' });
    }
    return new Response('not found', { status: 404 });
  };
  return { voice, messages, fetch, fail: (v) => (failing = v) };
}

function setup() {
  const discord = fakeDiscord();
  globalThis.fetch = discord.fetch;
  const env = {
    DB: createD1(),
    DISCORD_TOKEN: 'token',
    DISCORD_PUBLIC_KEY: publicKey,
    GUILD_ID: 'g1',
    USER_IDS: 'ua, ub',
    WORK_VOICE_CHANNEL_IDS: 'vc1',
    LOG_CHANNEL_ID: 'log1',
    GRACE_MINUTES: '5',
    MAX_AWAY_MINUTES: '180',
    TIME_ZONE: 'Asia/Tokyo',
  };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const settle = () => Promise.all(pending.splice(0));

  async function send(interaction, { sign = true } = {}) {
    const body = JSON.stringify(interaction);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign
      ? hex(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(timestamp + body)))
      : '00'.repeat(64);
    const res = await worker.fetch(new Request('https://bot.example/', {
      method: 'POST',
      headers: { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp, 'Content-Type': 'application/json' },
      body,
    }), env, ctx);
    await settle();
    return res;
  }
  const member = (id) => ({ user: { id, username: `name-${id}` } });
  const button = (type, userId = 'ua') => send({ type: 3, guild_id: 'g1', member: member(userId), data: { custom_id: `timecard:${type}` } });
  const command = (name, options = [], userId = 'ua', resolved) =>
    send({ type: 2, guild_id: 'g1', member: member(userId), data: { name, options, resolved } });
  const cron = async () => {
    await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() }, env, ctx);
    await settle();
  };
  return { discord, env, send, button, command, cron };
}

test('Worker 全体の流れ', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 30, 0, 0) }); // 日本時間 09:00
  const minutes = async (n, cron) => {
    for (let i = 0; i < n; i++) {
      t.mock.timers.tick(60 * 1000);
      await cron();
    }
  };
  const app = setup();
  const data = async (res) => (await res.json()).data;

  // 署名と PING
  assert.equal((await worker.fetch(new Request('https://bot.example/'), app.env, { waitUntil() {} })).status, 200);
  assert.equal((await app.send({ type: 1 }, { sign: false })).status, 401);
  assert.deepEqual(await (await app.send({ type: 1 })).json(), { type: 1 });

  // VC に入ると出勤
  app.discord.voice.set('ua', 'vc1');
  await app.cron();
  assert.deepEqual(app.discord.messages, ['🟢 <@ua> 出勤 09:00']);

  // ほかの VC は勤務に数えない
  app.discord.voice.set('ub', 'other');
  await app.cron();
  assert.equal(app.discord.messages.length, 1);

  // パネル
  const panel = await (await app.command('panel')).json();
  assert.equal(panel.data.flags, undefined);
  assert.equal(panel.data.components.length, 4);
  assert.deepEqual(panel.data.components[1].components.map((b) => b.custom_id), ['timecard:walk_start', 'timecard:walk_end']);
  assert.deepEqual(panel.data.components[2].components.map((b) => b.custom_id), ['timecard:stand_start', 'timecard:stand_end']);
  assert.deepEqual(panel.data.components[3].components.map((b) => b.custom_id), ['timecard:today', 'timecard:month']);

  // 散歩に出て VC を抜け、30 分後に戻る
  await minutes(60, app.cron);
  let res = await data(await app.button('walk_start'));
  assert.match(res.content, /散歩開始 10:00 を記録しました/);
  assert.equal(res.flags, 64);
  app.discord.voice.delete('ua');
  await minutes(30, app.cron);
  app.discord.voice.set('ua', 'vc1');
  await minutes(1, app.cron);
  assert.deepEqual(app.discord.messages.slice(1), ['🚶 <@ua> 散歩開始 10:00', '↩️ <@ua> 散歩終了 10:31']);

  // 押せないボタン・対象外の人
  assert.match((await data(await app.button('break_end'))).content, /休憩中ではありません/);
  assert.match((await data(await app.button('walk_start', 'stranger'))).content, /記録の対象ではありません/);

  // ボタンを押した瞬間に VC の状態を確かめる（定期実行を待たない）
  app.discord.voice.delete('ua');
  t.mock.timers.tick(20 * 1000);
  res = await data(await app.button('today'));
  assert.match(res.content, /切断中/);

  // Discord の API が失敗しているあいだは状態を変えない
  app.discord.fail(true);
  await minutes(10, app.cron);
  app.discord.fail(false);
  app.discord.voice.set('ua', 'vc1');
  await minutes(1, app.cron);
  assert.equal(app.discord.messages.length, 3);

  // 退勤
  await minutes(60, app.cron);
  app.discord.voice.delete('ua');
  await minutes(6, app.cron);
  assert.equal(app.discord.messages.at(-1), '🔴 <@ua> 退勤 11:43');

  // 集計
  res = await data(await app.command('month'));
  assert.match(res.content, /出勤 1日 · 実働 \*\*2:12\*\* · 休憩 0:00 · 散歩 0:31/);
  res = await data(await app.button('month'));
  assert.match(res.content, /出勤 1日 · 実働 \*\*2:12\*\* · 休憩 0:00 · 散歩 0:31/);
  assert.equal(res.flags, 64);
  res = await data(await app.command('today', [{ name: 'user', type: 6, value: 'ub' }], 'ua', { users: { ub: { id: 'ub', username: 'bee' } } }));
  assert.match(res.content, /<@ub> の記録\n\*\*未出勤\*\*/);

  // CSV はファイルで返す
  const csvRes = await app.command('csv', [{ name: 'month', type: 3, value: '2026-10' }]);
  const form = await csvRes.formData();
  const payload = JSON.parse(form.get('payload_json'));
  assert.deepEqual(payload.data.attachments, [{ id: 0, filename: 'timecard-name-ua-2026-10.csv' }]);
  const csv = await form.get('files[0]').text();
  assert.match(csv, /2026-10-30,金,09:00,11:43,0,31,132,2:12,/);

  // 手動追加と取り消し
  const opt = (name, value) => ({ name, type: 3, value });
  res = await data(await app.command('add', [opt('type', 'in'), opt('time', '9:00'), opt('date', '2026-10-29')]));
  assert.match(res.content, /順番が合わなくなります/);
  res = await data(await app.command('addshift', [opt('start', '２２：００'), opt('end', '2:30'), opt('date', '2026-10-28')]));
  assert.match(res.content, /2026-10-28 22:00〜翌02:30 の勤務を追加しました/);
  assert.equal(app.discord.messages.at(-1), '🔴 <@ua> 退勤 2026-10-29 02:30（手動）');
  res = await data(await app.command('add', [opt('type', 'break_start'), opt('time', '23:00'), opt('date', '2026-10-28')]));
  assert.match(res.content, /2026-10-28 23:00 に休憩開始を追加しました/);
  res = await data(await app.command('add', [opt('type', 'break_end'), opt('time', '23:30'), opt('date', '2026-10-28')]));
  res = await data(await app.command('month'));
  assert.match(res.content, /出勤 2日 · 実働 \*\*6:12\*\* · 休憩 0:30 · 散歩 0:31/);
  res = await data(await app.command('undo'));
  assert.match(res.content, /休憩終了 2026-10-28 23:30 を取り消しました/);
  assert.match(app.discord.messages.at(-1), /取り消しました/);

  // ほかのサーバーからは使えない
  res = await data(await app.send({ type: 2, guild_id: 'other', member: { user: { id: 'ua' } }, data: { name: 'today' } }));
  assert.match(res.content, /このサーバーでは使えません/);
});
