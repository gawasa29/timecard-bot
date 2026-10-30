// Worker の環境変数（secrets と wrangler.toml の vars）を読む

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} を設定してください（README の「設定」を参照）`);
  return value;
}

function idSet(env, name) {
  return new Set(required(env, name).split(',').map((s) => s.trim()).filter(Boolean));
}

function minutes(env, name, fallback) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} は 0 以上の分数で指定してください`);
  return value * 60 * 1000;
}

export function loadConfig(env) {
  return {
    token: required(env, 'DISCORD_TOKEN'),
    publicKey: required(env, 'DISCORD_PUBLIC_KEY'),
    guildId: required(env, 'GUILD_ID'),
    userIds: idSet(env, 'USER_IDS'),
    workVoiceChannelIds: idSet(env, 'WORK_VOICE_CHANNEL_IDS'),
    logChannelId: env.LOG_CHANNEL_ID?.trim() || null,
    graceMs: minutes(env, 'GRACE_MINUTES', 5),
    maxAwayMs: minutes(env, 'MAX_AWAY_MINUTES', 180),
    timeZone: env.TIME_ZONE?.trim() || 'Asia/Tokyo',
    apiBase: env.DISCORD_API_BASE?.trim() || undefined,
  };
}
