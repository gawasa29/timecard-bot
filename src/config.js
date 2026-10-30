'use strict';

try {
  process.loadEnvFile();
} catch {
  // .env がなければ環境変数だけを使う
}
// 日付の区切りと表示の時刻は TZ に従う
process.env.TZ ||= 'Asia/Tokyo';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`環境変数 ${name} を設定してください（.env.example を参照）`);
  return value;
}

function minutes(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`環境変数 ${name} は 0 以上の分数で指定してください`);
  return value * 60 * 1000;
}

function loadConfig() {
  return {
    token: required('DISCORD_TOKEN'),
    guildId: required('GUILD_ID'),
    workVoiceChannelIds: new Set(required('WORK_VOICE_CHANNEL_IDS').split(',').map((s) => s.trim()).filter(Boolean)),
    logChannelId: process.env.LOG_CHANNEL_ID?.trim() || null,
    graceMs: minutes('GRACE_MINUTES', 5),
    maxAwayMs: minutes('MAX_AWAY_MINUTES', 180),
    dbPath: process.env.DB_PATH?.trim() || 'data/timecard.db',
  };
}

module.exports = { loadConfig };
