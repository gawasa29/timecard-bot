// 打刻を勤務単位にまとめて集計する。Discord に依存しない。

import { localParts } from './time.js';

export const TYPE_LABELS = {
  in: '出勤',
  break_start: '休憩開始',
  break_end: '休憩終了',
  stand_start: '立ち開始',
  stand_end: '立ち終了',
  out: '退勤',
};
export const STATUS_LABELS = { off: '未出勤', working: '勤務中', break: '休憩中' };
export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

const pad = (n) => String(n).padStart(2, '0');
const byTs = (a, b) => a.ts - b.ts || a.id - b.id;

export function dateKey(ts) {
  const p = localParts(ts);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function fmtTime(ts) {
  const p = localParts(ts);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

// 日付をまたいだ時刻には「翌」を付ける
export function fmtTimeFrom(ts, baseTs) {
  return (dateKey(ts) !== dateKey(baseTs) ? '翌' : '') + fmtTime(ts);
}

export function fmtDuration(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  return `${Math.floor(m / 60)}:${pad(m % 60)}`;
}

export function fmtDateLabel(ts) {
  const p = localParts(ts);
  return `${pad(p.month)}/${pad(p.day)}(${WEEKDAYS[p.weekday]})`;
}

// 立ち時間の打刻を閉じていないものがあれば返す
const openStand = (shift) => {
  const last = shift.stands.at(-1);
  return last !== undefined && last.end === null ? last : null;
};

// 出勤から退勤までを 1 つの勤務とし、勤務日は出勤した日とする。
// 順番がおかしい打刻を含む勤務は error を立てる。
export function buildShifts(list) {
  const shifts = [];
  let cur = null;
  const orphan = (p) => shifts.push({ punches: [p], start: null, end: null, breaks: [], stands: [], open: false, error: true });

  for (const p of [...list].sort(byTs)) {
    if (p.type === 'in') {
      if (cur) {
        cur.error = true;
        shifts.push(cur);
      }
      cur = { punches: [p], start: p.ts, end: null, breaks: [], stands: [], open: false, error: false };
      continue;
    }
    if (!cur) {
      orphan(p);
      continue;
    }
    cur.punches.push(p);
    const last = cur.breaks.at(-1);
    const onBreak = last !== undefined && last.end === null ? last : null;
    const stand = openStand(cur);
    if (stand && p.type !== 'stand_start') stand.end = p.ts;
    if (p.type === 'stand_start') {
      if (onBreak || stand) cur.error = true;
      else cur.stands.push({ start: p.ts, end: null });
    } else if (p.type === 'stand_end') {
      if (!stand) cur.error = true;
    } else if (p.type === 'break_start') {
      if (onBreak) cur.error = true;
      else cur.breaks.push({ start: p.ts, end: null });
    } else if (p.type === 'break_end') {
      if (onBreak) onBreak.end = p.ts;
      else cur.error = true;
    } else if (p.type === 'out') {
      // 休憩を終えずに退勤したら、退勤の時刻で休憩も終える
      if (onBreak) onBreak.end = p.ts;
      cur.end = p.ts;
      shifts.push(cur);
      cur = null;
    } else {
      cur.error = true;
    }
  }
  if (cur) {
    cur.open = true;
    shifts.push(cur);
  }
  return shifts;
}

export function shiftDay(shift) {
  return dateKey(shift.punches[0].ts);
}

// 退勤がなく終わりを決められない勤務は null を返す
export function shiftStats(shift, now) {
  const end = shift.end ?? (shift.open ? now : null);
  if (shift.start === null || end === null) return { breakMs: null, workMs: null, standMs: null };
  // 休憩は勤務中に抜ける時間で、実働から引く。立ち時間は実働に含む
  const breakMs = shift.breaks.reduce((sum, b) => sum + (b.end ?? end) - b.start, 0);
  return {
    breakMs,
    workMs: end - shift.start - breakMs,
    standMs: shift.stands.reduce((sum, s) => sum + (s.end ?? end) - s.start, 0),
  };
}

export function currentState(shifts) {
  const last = shifts.at(-1);
  if (!last || !last.open) return { status: 'off', shift: null, onBreak: null, stand: null };
  const onBreak = last.breaks.at(-1);
  if (onBreak && onBreak.end === null) return { status: 'break', shift: last, onBreak, stand: null };
  return { status: 'working', shift: last, onBreak: null, stand: openStand(last) };
}

export function errorCount(list) {
  return buildShifts(list).filter((s) => s.error).length;
}
