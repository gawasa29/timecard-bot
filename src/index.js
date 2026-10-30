'use strict';

// config は TZ を設定するので最初に読み込む
const { loadConfig } = require('./config');
const { Client, Events, GatewayIntentBits, MessageFlags } = require('discord.js');
const { Store } = require('./store');
const { Tracker } = require('./tracker');
const { commandData, handleInteraction, punchLogLine } = require('./bot');

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const config = loadConfig();
const store = new Store(config.dbPath);
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

const isWorkChannel = (channelId) => channelId !== null && config.workVoiceChannelIds.has(channelId);

function isInWorkVoice(userId) {
  const guild = client.guilds.cache.get(config.guildId);
  return isWorkChannel(guild?.voiceStates.cache.get(userId)?.channelId ?? null);
}

async function log(content) {
  if (!config.logChannelId) return;
  try {
    const channel = await client.channels.fetch(config.logChannelId);
    await channel.send({ content, allowedMentions: { parse: [] } });
  } catch (err) {
    console.error('ログチャンネルへの送信に失敗しました', err);
  }
}

const tracker = new Tracker({
  store,
  graceMs: config.graceMs,
  maxAwayMs: config.maxAwayMs,
  isInWorkVoice,
  onPunch: (punch) => {
    console.log(`[punch] ${punch.userId} ${punch.type} ${new Date(punch.ts).toISOString()} (${punch.source})`);
    log(punchLogLine(punch));
  },
});

client.once(Events.ClientReady, async (c) => {
  const guild = await c.guilds.fetch(config.guildId);
  await guild.commands.set(commandData);

  const inVoice = [...guild.voiceStates.cache.values()]
    .filter((v) => isWorkChannel(v.channelId) && !v.member?.user.bot)
    .map((v) => v.id);
  tracker.reconcile([...new Set([...store.users(), ...inVoice])]);
  setInterval(() => tracker.sweep(store.users()), SWEEP_INTERVAL_MS);

  console.log(`${c.user.tag} として ${guild.name} で起動しました`);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (newState.guild.id !== config.guildId || newState.member?.user.bot) return;
  tracker.voiceChanged(newState.id, isWorkChannel(oldState.channelId), isWorkChannel(newState.channelId));
});

client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction, { tracker, store, config, log }).catch(async (err) => {
    console.error('操作の処理に失敗しました', err);
    if (!interaction.isRepliable() || interaction.replied || interaction.deferred) return;
    await interaction.reply({ content: 'エラーが発生しました。', flags: MessageFlags.Ephemeral }).catch(() => {});
  });
});

function shutdown() {
  client.destroy();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(config.token);
