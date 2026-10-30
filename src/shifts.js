'use strict';

// 打刻を勤務単位にまとめて集計する。Discord に依存しない。

const TYPE_LABELS = {
  in: '出勤',
  break_start: '休憩開始',
  break_end: '休憩終了',
  walk_start: '散歩開始',
  walk_end: '散歩終了',
  out: '退勤',
};
// 休憩と散歩は勤務中に抜ける時間で、どちらも実働から引く
const AWAY_START = { break_start: 'break', walk_start: 'walk' };
const AWAY_END = { break_end: 'break', walk_end: 'walk' };
const STATUS_LABELS = { off: '未出勤', working: '勤務中', break: '休憩中', walk: '散歩中' };
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

const pad = (n) => String(n).padStart(2, '0');
const byTs = (a, b) => a.ts - b.ts || a.id - b.id;

function dateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 日付をまたいだ時刻には「翌」を付ける
function fmtTimeFrom(ts, baseTs) {
  return (dateKey(ts) !== dateKey(baseTs) ? '翌' : '') + fmtTime(ts);
}

function fmtDuration(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  return `${Math.floor(m / 60)}:${pad(m % 60)}`;
}

function fmtDateLabel(ts) {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}(${WEEKDAYS[d.getDay()]})`;
}

// 出勤から退勤までを 1 つの勤務とし、勤務日は出勤した日とする。
// 順番がおかしい打刻を含む勤務は error を立てる。
function buildShifts(list) {
  const shifts = [];
  let cur = null;
  const orphan = (p) => shifts.push({ punches: [p], start: null, end: null, aways: [], open: false, error: true });

  for (const p of [...list].sort(byTs)) {
    if (p.type === 'in') {
      if (cur) {
        cur.error = true;
        shifts.push(cur);
      }
      cur = { punches: [p], start: p.ts, end: null, aways: [], open: false, error: false };
      continue;
    }
    if (!cur) {
      orphan(p);
      continue;
    }
    cur.punches.push(p);
    const last = cur.aways.at(-1);
    const away = last !== undefined && last.end === null ? last : null;
    if (Object.hasOwn(AWAY_START, p.type)) {
      if (away) cur.error = true;
      else cur.aways.push({ kind: AWAY_START[p.type], start: p.ts, end: null });
    } else if (Object.hasOwn(AWAY_END, p.type)) {
      if (away && away.kind === AWAY_END[p.type]) away.end = p.ts;
      else cur.error = true;
    } else {
      if (away) away.end = p.ts;
      cur.end = p.ts;
      shifts.push(cur);
      cur = null;
    }
  }
  if (cur) {
    cur.open = true;
    shifts.push(cur);
  }
  return shifts;
}

function shiftDay(shift) {
  return dateKey(shift.punches[0].ts);
}

// 退勤がなく終わりを決められない勤務は null を返す
function shiftStats(shift, now) {
  const end = shift.end ?? (shift.open ? now : null);
  if (shift.start === null || end === null) return { breakMs: null, walkMs: null, workMs: null };
  const awayMs = { break: 0, walk: 0 };
  for (const a of shift.aways) awayMs[a.kind] += (a.end ?? end) - a.start;
  return {
    breakMs: awayMs.break,
    walkMs: awayMs.walk,
    workMs: end - shift.start - awayMs.break - awayMs.walk,
  };
}

function currentState(shifts) {
  const last = shifts.at(-1);
  if (!last || !last.open) return { status: 'off', shift: null, away: null };
  const away = last.aways.at(-1);
  if (away && away.end === null) return { status: away.kind, shift: last, away };
  return { status: 'working', shift: last, away: null };
}

function errorCount(list) {
  return buildShifts(list).filter((s) => s.error).length;
}

module.exports = {
  TYPE_LABELS,
  STATUS_LABELS,
  WEEKDAYS,
  pad,
  dateKey,
  fmtTime,
  fmtTimeFrom,
  fmtDuration,
  fmtDateLabel,
  buildShifts,
  shiftDay,
  shiftStats,
  currentState,
  errorCount,
};
