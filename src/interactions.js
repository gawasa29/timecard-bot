// Discord から HTTP で届くボタン操作とスラッシュコマンドを処理する

import { TYPE_LABELS, dateKey, fmtTime, fmtTimeFrom } from './shifts.js';
import { fromLocal } from './time.js';
import { statusLine, todayReport, monthReport, monthCsv } from './report.js';

const InteractionType = { PING: 1, COMMAND: 2, COMPONENT: 3 };
const ResponseType = { PONG: 1, MESSAGE: 4 };
const ButtonStyle = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3 };
const EPHEMERAL = 1 << 6;
const NO_MENTIONS = { parse: [] };
const BUTTON_PREFIX = 'timecard:';

const EMOJI = { in: '🟢', out: '🔴', break_start: '☕', break_end: '↩️', walk_start: '🚶', walk_end: '↩️', stand_start: '🧍', stand_end: '🪑' };
const SOURCE_NOTES = { command: '手動', auto: '休憩・散歩から戻らなかったため' };

const reply = (content, extra = {}) =>
  Response.json({ type: ResponseType.MESSAGE, data: { content, flags: EPHEMERAL, allowed_mentions: NO_MENTIONS, ...extra } });

export function punchLogLine(punch, now = Date.now()) {
  const when = dateKey(punch.ts) === dateKey(now) ? fmtTime(punch.ts) : `${dateKey(punch.ts)} ${fmtTime(punch.ts)}`;
  const note = SOURCE_NOTES[punch.source] ? `（${SOURCE_NOTES[punch.source]}）` : '';
  return `${EMOJI[punch.type]} <@${punch.userId}> ${TYPE_LABELS[punch.type]} ${when}${note}`;
}

function panelMessage() {
  const button = (type, style, label = TYPE_LABELS[type]) => ({ type: 2, style, label, custom_id: BUTTON_PREFIX + type });
  const row = (...components) => ({ type: 1, components });
  return {
    content: [
      '**タイムカード**',
      '勤務用のボイスチャンネルに入ると出勤、抜けると退勤になります（反映まで1分ほどかかります）。休憩・散歩・立ち時間はこのボタンで記録してください。',
      '休憩・散歩中はボイスチャンネルを抜けても退勤になりません。戻ると自動で終わります。',
      '立ち時間は実働に含みます。休憩・散歩に入ると立ち時間も終わります。',
    ].join('\n'),
    components: [
      row(button('break_start', ButtonStyle.PRIMARY), button('break_end', ButtonStyle.SECONDARY)),
      row(button('walk_start', ButtonStyle.SUCCESS), button('walk_end', ButtonStyle.SECONDARY)),
      row(button('stand_start', ButtonStyle.PRIMARY), button('stand_end', ButtonStyle.SECONDARY)),
      row(button('today', ButtonStyle.SECONDARY, '今日の記録'), button('month', ButtonStyle.SECONDARY, '今月の記録')),
    ],
    allowed_mentions: NO_MENTIONS,
  };
}

// ---------- 入力の解釈 ----------
export function parseMonth(value, now) {
  if (!value) return dateKey(now).slice(0, 7);
  const m = toHalfWidth(value).match(/^(\d{4})-(\d{1,2})$/);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}`;
}

// 全角の数字やコロンも受け付ける
const toHalfWidth = (s) => s.replace(/[０-９：－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim();

export function parseDateTime(dateValue, timeValue, now) {
  const t = toHalfWidth(timeValue).match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!t) return null;
  const d = toHalfWidth(dateValue || dateKey(now)).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!d) return null;
  const [year, month, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const ts = fromLocal(year, month, day, Number(t[1]), Number(t[2]));
  if (dateKey(ts) !== `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`) return null;
  return ts;
}

function options(interaction) {
  return Object.fromEntries((interaction.data.options ?? []).map((o) => [o.name, o.value]));
}

// ---------- 処理 ----------
async function handleButton(interaction, user, app) {
  const { tracker, store, config } = app;
  const customId = interaction.data.custom_id ?? '';
  if (!customId.startsWith(BUTTON_PREFIX)) return reply('不明な操作です。');
  if (!config.userIds.has(user.id)) {
    return reply(`<@${user.id}> は記録の対象ではありません。設定の USER_IDS に追加してください。`);
  }
  const type = customId.slice(BUTTON_PREFIX.length);

  // 押した時点で VC にいるかを確かめてから処理する
  await app.syncUser(user.id);
  const now = app.now();
  const disconnected = async () => (await tracker.presence(user.id)).leftAt !== null;

  if (type === 'today') return reply(todayReport(await store.list(user.id), now, await disconnected()));
  if (type === 'month') return reply(monthReport(await store.list(user.id), parseMonth(null, now), now));

  const result = await tracker.press(user.id, type, now);
  if (!result.ok) return reply(result.message);
  const lines = [
    `${TYPE_LABELS[type]} ${fmtTime(result.punch.ts)} を記録しました。`,
    statusLine(await store.list(user.id), now, await disconnected()),
  ];
  if (result.note) lines.push(result.note);
  return reply(lines.join('\n'));
}

async function handleCommand(interaction, user, app) {
  const { tracker, store } = app;
  const now = app.now();
  const opts = options(interaction);
  const targetId = opts.user ?? user.id;
  const target = interaction.data.resolved?.users?.[targetId] ?? user;
  const who = targetId === user.id ? '' : `<@${targetId}> の記録\n`;

  switch (interaction.data.name) {
    case 'panel':
      return Response.json({ type: ResponseType.MESSAGE, data: panelMessage() });

    case 'today': {
      const presence = await tracker.presence(targetId);
      return reply(who + todayReport(await store.list(targetId), now, presence.leftAt !== null));
    }

    case 'month': {
      const ym = parseMonth(opts.month, now);
      if (!ym) return reply('月は 2026-10 のように入力してください。');
      return reply(who + monthReport(await store.list(targetId), ym, now));
    }

    case 'csv': {
      const ym = parseMonth(opts.month, now);
      if (!ym) return reply('月は 2026-10 のように入力してください。');
      const filename = `timecard-${target.username ?? targetId}-${ym}.csv`;
      const form = new FormData();
      form.append('payload_json', JSON.stringify({
        type: ResponseType.MESSAGE,
        data: { content: `${who}${ym} の勤務記録です。`, flags: EPHEMERAL, allowed_mentions: NO_MENTIONS, attachments: [{ id: 0, filename }] },
      }));
      form.append('files[0]', new Blob([monthCsv(await store.list(targetId), ym, now)], { type: 'text/csv' }), filename);
      return new Response(form);
    }

    case 'add': {
      const ts = parseDateTime(opts.date, opts.time ?? '', now);
      if (ts === null) return reply('日時は「時刻 09:30」「日付 2026-10-30」のように入力してください。');
      const result = await tracker.addManual(user.id, [{ type: opts.type, ts }], now);
      if (!result.ok) return reply(result.message);
      return reply(`${dateKey(ts)} ${fmtTime(ts)} に${TYPE_LABELS[opts.type]}を追加しました。`);
    }

    case 'addshift': {
      const start = parseDateTime(opts.date, opts.start ?? '', now);
      let end = parseDateTime(opts.date, opts.end ?? '', now);
      if (start === null || end === null) return reply('日時は「時刻 09:30」「日付 2026-10-30」のように入力してください。');
      if (end <= start) end = parseDateTime(dateKey(start + 24 * 60 * 60 * 1000), opts.end, now); // 日付をまたぐ勤務
      const result = await tracker.addManual(user.id, [{ type: 'in', ts: start }, { type: 'out', ts: end }], now);
      if (!result.ok) return reply(result.message);
      return reply(`${dateKey(start)} ${fmtTime(start)}〜${fmtTimeFrom(end, start)} の勤務を追加しました。`);
    }

    case 'undo': {
      const result = await tracker.undo(user.id);
      if (!result.ok) return reply(result.message);
      const p = result.punch;
      const what = `${TYPE_LABELS[p.type]} ${dateKey(p.ts)} ${fmtTime(p.ts)}`;
      app.waitUntil(app.log(`🗑️ <@${p.userId}> の打刻を取り消しました: ${what}`));
      return reply(`${what} を取り消しました。`);
    }

    default:
      return reply('不明なコマンドです。');
  }
}

export async function handleInteraction(interaction, app) {
  if (interaction.type === InteractionType.PING) return Response.json({ type: ResponseType.PONG });
  if (interaction.guild_id !== app.config.guildId) return reply('このサーバーでは使えません。');
  const user = interaction.member?.user ?? interaction.user;
  if (interaction.type === InteractionType.COMPONENT) return handleButton(interaction, user, app);
  if (interaction.type === InteractionType.COMMAND) return handleCommand(interaction, user, app);
  return reply('不明な操作です。');
}
