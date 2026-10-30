// Cloudflare Worker の入り口。
// - fetch: Discord の Interactions（ボタン・コマンド）を受け取る
// - scheduled: 1 分ごとに、記録する人が勤務用 VC にいるかを確かめる

import { loadConfig } from './config.js';
import { DiscordApi, verifyRequest } from './discord.js';
import { Store } from './store.js';
import { Tracker } from './tracker.js';
import { setTimeZone } from './time.js';
import { handleInteraction, punchLogLine } from './interactions.js';

function createApp(env, ctx) {
  const config = loadConfig(env);
  setTimeZone(config.timeZone);
  const discord = new DiscordApi(config.token, { base: config.apiBase });
  const store = new Store(env.DB);

  const log = async (content) => {
    if (!config.logChannelId) return;
    try {
      await discord.sendMessage(config.logChannelId, content);
    } catch (err) {
      console.error('ログチャンネルへの送信に失敗しました', err);
    }
  };
  const waitUntil = (promise) => ctx.waitUntil(promise);
  const tracker = new Tracker({
    store,
    graceMs: config.graceMs,
    maxAwayMs: config.maxAwayMs,
    onPunch: (punch) => waitUntil(log(punchLogLine(punch))),
  });
  const isWorkChannel = (channelId) => channelId !== null && config.workVoiceChannelIds.has(channelId);

  // VC の状態を取れなかったときは前回の状態のままにする（入退室を取り違えないため）
  async function syncUser(userId) {
    let channelId;
    try {
      channelId = await discord.getVoiceChannel(config.guildId, userId);
    } catch (err) {
      console.error(err);
      return;
    }
    await tracker.observe(userId, isWorkChannel(channelId), Date.now());
  }

  return { config, store, tracker, log, waitUntil, syncUser, now: () => Date.now() };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') return new Response('timecard-bot is running');
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

    const app = createApp(env, ctx);
    const body = await verifyRequest(request, app.config.publicKey);
    if (body === null) return new Response('invalid request signature', { status: 401 });
    return handleInteraction(JSON.parse(body), app);
  },

  async scheduled(controller, env, ctx) {
    const app = createApp(env, ctx);
    for (const userId of app.config.userIds) await app.syncUser(userId);
  },
};
