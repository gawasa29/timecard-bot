import {
  TYPE_LABELS,
  STATUS_LABELS,
  WEEKDAYS,
  dateKey,
  fmtTime,
  fmtTimeFrom,
  fmtDuration,
  fmtDateLabel,
  buildShifts,
  shiftDay,
  shiftStats,
  currentState,
} from './shifts.js';
import { localParts } from './time.js';

function totals(shifts, now) {
  const sum = { days: new Set(), work: 0, break: 0, stand: 0 };
  for (const s of shifts) {
    const { workMs, breakMs, standMs } = shiftStats(s, now);
    if (s.start !== null) sum.days.add(shiftDay(s));
    sum.work += workMs ?? 0;
    sum.break += breakMs ?? 0;
    sum.stand += standMs ?? 0;
  }
  return sum;
}

export function statusLine(punches, now, disconnected) {
  const shifts = buildShifts(punches);
  const { status, shift, onBreak, stand } = currentState(shifts);
  if (status === 'working') {
    const standing = stand ? ` · 立ち ${fmtDuration(now - stand.start)}` : '';
    return `勤務中 · ${fmtDuration(shiftStats(shift, now).workMs)}${standing}${disconnected ? '（ボイスチャンネルから切断中）' : ''}`;
  }
  if (onBreak) return `${STATUS_LABELS[status]} · ${fmtDuration(now - onBreak.start)}`;
  const todayKey = dateKey(now);
  return shifts.some((s) => s.end !== null && shiftDay(s) === todayKey) ? '退勤済み' : '未出勤';
}

export function todayReport(punches, now, disconnected = false) {
  const todayKey = dateKey(now);
  const shifts = buildShifts(punches).filter((s) => s.open || shiftDay(s) === todayKey);
  const lines = [`**${statusLine(punches, now, disconnected)}**`];
  if (shifts.length === 0) {
    lines.push('今日の打刻はまだありません。');
    return lines.join('\n');
  }
  for (const s of shifts) {
    for (const p of s.punches) lines.push(`\`${fmtTimeFrom(p.ts, s.punches[0].ts).padStart(7)}\` ${TYPE_LABELS[p.type]}`);
  }
  const t = totals(shifts, now);
  lines.push(`実働 **${fmtDuration(t.work)}** · 休憩 ${fmtDuration(t.break)} · 立ち ${fmtDuration(t.stand)}`);
  if (shifts.some((s) => s.error)) lines.push('⚠️ 打刻の順番が合わない勤務があります。');
  return lines.join('\n');
}

function monthShifts(punches, ym) {
  return buildShifts(punches).filter((s) => shiftDay(s).startsWith(ym));
}

function monthHeader(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `**${y}年${m}月**`;
}

function summaryLine(shifts, now) {
  const t = totals(shifts, now);
  return `出勤 ${t.days.size}日 · 実働 **${fmtDuration(t.work)}** · 休憩 ${fmtDuration(t.break)} · 立ち ${fmtDuration(t.stand)}`;
}

function dayRows(shifts, now) {
  return shifts.map((s) => {
    const first = s.punches[0].ts;
    const { workMs, breakMs, standMs } = shiftStats(s, now);
    const start = s.start !== null ? fmtTime(s.start) : '--:--';
    const end = s.end !== null ? fmtTimeFrom(s.end, s.start) : s.open ? '勤務中' : '--:--';
    const detail = workMs === null
      ? '要確認'
      : `休${fmtDuration(breakMs)} 実${fmtDuration(workMs)} 立${fmtDuration(standMs)}${s.error ? ' 要確認' : ''}`;
    return `${fmtDateLabel(first)} ${start}-${end.padEnd(5)} ${detail}`;
  });
}

export function monthReport(punches, ym, now) {
  const shifts = monthShifts(punches, ym);
  const header = `${monthHeader(ym)}　${summaryLine(shifts, now)}`;
  if (shifts.length === 0) return `${header}\nこの月の記録はありません。`;

  const body = `${header}\n\`\`\`\n${dayRows(shifts, now).join('\n')}\n\`\`\``;
  // Discord のメッセージは 2000 文字まで
  return body.length <= 1900 ? body : `${header}\n記録が多いため一覧は省略しました。\`/csv\` で書き出してください。`;
}

// entries: [{ userId, punches }]。全員分を 1 つのメッセージにまとめる
export function monthReportAll(entries, ym, now) {
  const header = monthHeader(ym);
  const sections = entries.map(({ userId, punches }) => {
    const shifts = monthShifts(punches, ym);
    return { userId, shifts, rows: shifts.length > 0 ? dayRows(shifts, now) : [] };
  });
  const withRows = sections.filter((s) => s.rows.length > 0);
  if (withRows.length === 0) return `${header}\nこの月の記録はありません。`;

  const summaries = sections.map(({ userId, shifts }) => `<@${userId}> ${summaryLine(shifts, now)}`);
  const fixed = `${header}\n${summaries.join('\n')}\n`;
  // 一覧に使える文字数を人数で分ける。入りきらなければ、それぞれの途中まで出す
  const perUser = Math.floor((1900 - fixed.length - 60) / withRows.length);
  let truncated = false;
  const blocks = withRows.map(({ userId, rows }) => {
    const head = `<@${userId}>\n\`\`\`\n`;
    const tail = '\n```';
    let used = head.length + tail.length;
    const kept = [];
    for (const row of rows) {
      if (used + row.length + 1 > perUser) {
        truncated = true;
        break;
      }
      kept.push(row);
      used += row.length + 1;
    }
    return `${head}${kept.join('\n')}${kept.length < rows.length ? '\n…' : ''}${tail}`;
  });
  const note = truncated ? '\n記録が多いため、一覧は途中までです。`/csv` で人ごとに書き出せます。' : '';
  return `${fixed}\n${blocks.join('\n\n')}${note}`;
}

export function monthCsv(punches, ym, now) {
  const lines = [['日付', '曜日', '出勤', '退勤', '休憩(分)', '実働(分)', '実働(時間)', '立ち(分)', '備考'].join(',')];
  for (const s of monthShifts(punches, ym)) {
    if (s.start === null) continue;
    const done = s.end !== null;
    const { breakMs, workMs, standMs } = shiftStats(s, now);
    lines.push([
      shiftDay(s),
      WEEKDAYS[localParts(s.start).weekday],
      fmtTime(s.start),
      done ? fmtTimeFrom(s.end, s.start) : '',
      done ? Math.floor(breakMs / 60000) : '',
      done ? Math.floor(workMs / 60000) : '',
      done ? fmtDuration(workMs) : '',
      done ? Math.floor(standMs / 60000) : '',
      s.error ? '要確認' : s.open ? '勤務中' : '',
    ].join(','));
  }
  // Excel で文字化けしないよう BOM を付ける
  return '﻿' + lines.join('\r\n') + '\r\n';
}
