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
  const sum = { days: new Set(), work: 0, break: 0, walk: 0 };
  for (const s of shifts) {
    const { workMs, breakMs, walkMs } = shiftStats(s, now);
    if (s.start !== null) sum.days.add(shiftDay(s));
    sum.work += workMs ?? 0;
    sum.break += breakMs ?? 0;
    sum.walk += walkMs ?? 0;
  }
  return sum;
}

export function statusLine(punches, now, disconnected) {
  const shifts = buildShifts(punches);
  const { status, shift, away } = currentState(shifts);
  if (status === 'working') {
    return `勤務中 · ${fmtDuration(shiftStats(shift, now).workMs)}${disconnected ? '（ボイスチャンネルから切断中）' : ''}`;
  }
  if (away) return `${STATUS_LABELS[status]} · ${fmtDuration(now - away.start)}`;
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
  lines.push(`実働 **${fmtDuration(t.work)}** · 休憩 ${fmtDuration(t.break)} · 散歩 ${fmtDuration(t.walk)}`);
  if (shifts.some((s) => s.error)) lines.push('⚠️ 打刻の順番が合わない勤務があります。');
  return lines.join('\n');
}

function monthShifts(punches, ym) {
  return buildShifts(punches).filter((s) => shiftDay(s).startsWith(ym));
}

export function monthReport(punches, ym, now) {
  const shifts = monthShifts(punches, ym);
  const [y, m] = ym.split('-').map(Number);
  const t = totals(shifts, now);
  const header = `**${y}年${m}月**　出勤 ${t.days.size}日 · 実働 **${fmtDuration(t.work)}** · 休憩 ${fmtDuration(t.break)} · 散歩 ${fmtDuration(t.walk)}`;
  if (shifts.length === 0) return `${header}\nこの月の記録はありません。`;

  const rows = shifts.map((s) => {
    const first = s.punches[0].ts;
    const { workMs, breakMs, walkMs } = shiftStats(s, now);
    const start = s.start !== null ? fmtTime(s.start) : '--:--';
    const end = s.end !== null ? fmtTimeFrom(s.end, s.start) : s.open ? '勤務中' : '--:--';
    const detail = workMs === null
      ? '要確認'
      : `休${fmtDuration(breakMs)} 散${fmtDuration(walkMs)} 実${fmtDuration(workMs)}${s.error ? ' 要確認' : ''}`;
    return `${fmtDateLabel(first)} ${start}-${end.padEnd(5)} ${detail}`;
  });
  const body = `${header}\n\`\`\`\n${rows.join('\n')}\n\`\`\``;
  // Discord のメッセージは 2000 文字まで
  return body.length <= 1900 ? body : `${header}\n記録が多いため一覧は省略しました。\`/csv\` で書き出してください。`;
}

export function monthCsv(punches, ym, now) {
  const lines = [['日付', '曜日', '出勤', '退勤', '休憩(分)', '散歩(分)', '実働(分)', '実働(時間)', '備考'].join(',')];
  for (const s of monthShifts(punches, ym)) {
    if (s.start === null) continue;
    const done = s.end !== null;
    const { breakMs, walkMs, workMs } = shiftStats(s, now);
    lines.push([
      shiftDay(s),
      WEEKDAYS[localParts(s.start).weekday],
      fmtTime(s.start),
      done ? fmtTimeFrom(s.end, s.start) : '',
      done ? Math.floor(breakMs / 60000) : '',
      done ? Math.floor(walkMs / 60000) : '',
      done ? Math.floor(workMs / 60000) : '',
      done ? fmtDuration(workMs) : '',
      s.error ? '要確認' : s.open ? '勤務中' : '',
    ].join(','));
  }
  // Excel で文字化けしないよう BOM を付ける
  return '﻿' + lines.join('\r\n') + '\r\n';
}
