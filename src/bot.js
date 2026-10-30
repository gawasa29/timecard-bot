'use strict';

const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const { TYPE_LABELS, dateKey, fmtTime } = require('./shifts');
const { statusLine, todayReport, monthReport, monthCsv } = require('./report');

const BUTTON_PREFIX = 'timecard:';
const EMOJI = { in: '🟢', out: '🔴', break_start: '☕', break_end: '↩️', walk_start: '🚶', walk_end: '↩️' };
const SOURCE_NOTES = { command: '手動', reconcile: 'ボット起動時', auto: '休憩・散歩から戻らなかったため' };
const NO_MENTIONS = { parse: [] };

// ---------- コマンド定義 ----------
const userOption = (o) => o.setName('user').setDescription('見る人（省略すると自分）');
const monthOption = (o) => o.setName('month').setDescription('YYYY-MM（省略すると今月）');

const commandData = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('休憩・散歩ボタンのパネルをこのチャンネルに置く')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('today').setDescription('今日の勤務状況を見る').addUserOption(userOption),
  new SlashCommandBuilder().setName('month').setDescription('月の勤務時間を見る').addStringOption(monthOption).addUserOption(userOption),
  new SlashCommandBuilder().setName('csv').setDescription('月の勤務記録を CSV で受け取る').addStringOption(monthOption).addUserOption(userOption),
  new SlashCommandBuilder()
    .setName('add')
    .setDescription('自分の打刻を手動で追加する（打刻し忘れたとき）')
    .addStringOption((o) =>
      o.setName('type').setDescription('種類').setRequired(true)
        .addChoices(...Object.entries(TYPE_LABELS).map(([value, name]) => ({ name, value }))))
    .addStringOption((o) => o.setName('time').setDescription('時刻（例 09:30）').setRequired(true))
    .addStringOption((o) => o.setName('date').setDescription('日付 YYYY-MM-DD（省略すると今日）')),
  new SlashCommandBuilder().setName('undo').setDescription('自分が最後に記録した打刻を取り消す'),
].map((c) => c.toJSON());

function panelMessage() {
  const button = (type, style, label = TYPE_LABELS[type]) =>
    new ButtonBuilder().setCustomId(BUTTON_PREFIX + type).setLabel(label).setStyle(style);
  return {
    content: [
      '**タイムカード**',
      '勤務用のボイスチャンネルに入ると出勤、抜けると退勤になります。休憩と散歩はこのボタンで記録してください。',
      '休憩・散歩中はボイスチャンネルを抜けても退勤になりません。戻ると自動で終わります。',
    ].join('\n'),
    components: [
      new ActionRowBuilder().addComponents(button('break_start', ButtonStyle.Primary), button('break_end', ButtonStyle.Secondary)),
      new ActionRowBuilder().addComponents(button('walk_start', ButtonStyle.Success), button('walk_end', ButtonStyle.Secondary)),
      new ActionRowBuilder().addComponents(
        button('today', ButtonStyle.Secondary, '今日の記録'),
        button('out', ButtonStyle.Danger, '退勤（VCの外から）'),
      ),
    ],
    allowedMentions: NO_MENTIONS,
  };
}

function punchLogLine(punch, now = Date.now()) {
  const when = dateKey(punch.ts) === dateKey(now) ? fmtTime(punch.ts) : `${dateKey(punch.ts)} ${fmtTime(punch.ts)}`;
  const note = SOURCE_NOTES[punch.source] ? `（${SOURCE_NOTES[punch.source]}）` : '';
  return `${EMOJI[punch.type]} <@${punch.userId}> ${TYPE_LABELS[punch.type]} ${when}${note}`;
}

// ---------- 入力の解釈 ----------
function parseMonth(value, now) {
  if (!value) return dateKey(now).slice(0, 7);
  const m = value.trim().match(/^(\d{4})-(\d{1,2})$/);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}`;
}

// 全角の数字やコロンも受け付ける
const toHalfWidth = (s) => s.replace(/[０-９：－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim();

function parseDateTime(dateValue, timeValue, now) {
  const t = toHalfWidth(timeValue).match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!t) return null;
  const date = dateValue ? toHalfWidth(dateValue) : dateKey(now);
  const d = date.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!d) return null;
  const result = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  if (result.getMonth() !== Number(d[2]) - 1 || result.getDate() !== Number(d[3])) return null;
  return result.getTime();
}

// ---------- 操作の処理 ----------
const ephemeral = (content, extra = {}) => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS, ...extra });

async function handleButton(interaction, { tracker, store }) {
  const userId = interaction.user.id;
  const type = interaction.customId.slice(BUTTON_PREFIX.length);
  if (type === 'today') {
    return interaction.reply(ephemeral(todayReport(store.list(userId), Date.now(), tracker.isDisconnected(userId))));
  }
  const result = tracker.press(userId, type);
  if (!result.ok) return interaction.reply(ephemeral(result.message));
  const lines = [
    `${TYPE_LABELS[type]} ${fmtTime(result.punch.ts)} を記録しました。`,
    statusLine(store.list(userId), Date.now(), tracker.isDisconnected(userId)),
  ];
  if (result.note) lines.push(result.note);
  return interaction.reply(ephemeral(lines.join('\n')));
}

async function handleCommand(interaction, { tracker, store, log }) {
  const now = Date.now();
  const target = interaction.options.getUser('user') ?? interaction.user;
  const who = target.id === interaction.user.id ? '' : `<@${target.id}> の記録\n`;

  switch (interaction.commandName) {
    case 'panel':
      return interaction.reply(panelMessage());

    case 'today':
      return interaction.reply(ephemeral(who + todayReport(store.list(target.id), now, tracker.isDisconnected(target.id))));

    case 'month': {
      const ym = parseMonth(interaction.options.getString('month'), now);
      if (!ym) return interaction.reply(ephemeral('月は 2026-10 のように入力してください。'));
      return interaction.reply(ephemeral(who + monthReport(store.list(target.id), ym, now)));
    }

    case 'csv': {
      const ym = parseMonth(interaction.options.getString('month'), now);
      if (!ym) return interaction.reply(ephemeral('月は 2026-10 のように入力してください。'));
      const file = new AttachmentBuilder(Buffer.from(monthCsv(store.list(target.id), ym, now), 'utf8'), {
        name: `timecard-${target.username}-${ym}.csv`,
      });
      return interaction.reply(ephemeral(`${who}${ym} の勤務記録です。`, { files: [file] }));
    }

    case 'add': {
      const type = interaction.options.getString('type', true);
      const ts = parseDateTime(interaction.options.getString('date'), interaction.options.getString('time', true), now);
      if (ts === null) return interaction.reply(ephemeral('日時は「時刻 09:30」「日付 2026-10-30」のように入力してください。'));
      const result = tracker.addManual(interaction.user.id, type, ts);
      if (!result.ok) return interaction.reply(ephemeral(result.message));
      return interaction.reply(ephemeral(`${dateKey(ts)} ${fmtTime(ts)} に${TYPE_LABELS[type]}を追加しました。`));
    }

    case 'undo': {
      const result = tracker.undo(interaction.user.id);
      if (!result.ok) return interaction.reply(ephemeral(result.message));
      const p = result.punch;
      await log(`🗑️ <@${p.userId}> の打刻を取り消しました: ${TYPE_LABELS[p.type]} ${dateKey(p.ts)} ${fmtTime(p.ts)}`);
      return interaction.reply(ephemeral(`${TYPE_LABELS[p.type]} ${dateKey(p.ts)} ${fmtTime(p.ts)} を取り消しました。`));
    }

    default:
      return interaction.reply(ephemeral('不明なコマンドです。'));
  }
}

async function handleInteraction(interaction, ctx) {
  if (interaction.guildId !== ctx.config.guildId) return;
  if (interaction.isButton() && interaction.customId.startsWith(BUTTON_PREFIX)) return handleButton(interaction, ctx);
  if (interaction.isChatInputCommand()) return handleCommand(interaction, ctx);
}

module.exports = { commandData, handleInteraction, punchLogLine, parseMonth, parseDateTime };
