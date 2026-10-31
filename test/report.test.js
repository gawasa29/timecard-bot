import test from 'node:test';
import assert from 'node:assert/strict';
import { todayReport, monthReport, monthCsv } from '../src/report.js';
import { parseMonth, parseDateTime, punchLogLine } from '../src/interactions.js';
import { COMMANDS } from '../src/commands.js';
import { dateKey, fmtTime } from '../src/shifts.js';
import { fromLocal, setTimeZone } from '../src/time.js';

const at = (d, h, m) => fromLocal(2026, 10, d, h, m);
let id = 0;
const P = (type, d, h, m) => ({ id: ++id, userId: 'a', type, ts: at(d, h, m), source: 'voice' });

const october = [
  P('in', 29, 9, 0), P('walk_start', 29, 10, 0), P('walk_end', 29, 10, 20),
  P('break_start', 29, 12, 0), P('break_end', 29, 13, 0), P('out', 29, 18, 0),
  P('in', 30, 22, 0), P('out', 31, 2, 30), // 日付をまたぐ勤務
];

test('日時はプロセスのタイムゾーン（Workers では UTC）ではなく設定に従う', () => {
  assert.equal(new Date(at(30, 9, 0)).toISOString(), '2026-10-30T00:00:00.000Z');
  assert.equal(dateKey(Date.UTC(2026, 9, 30, 15, 30)), '2026-10-31');
  assert.equal(fmtTime(Date.UTC(2026, 9, 30, 15, 30)), '00:30');
  setTimeZone('America/New_York');
  try {
    assert.equal(new Date(fromLocal(2026, 11, 1, 9, 0)).toISOString(), '2026-11-01T14:00:00.000Z'); // 夏時間の終わった日
    assert.equal(new Date(fromLocal(2026, 10, 31, 9, 0)).toISOString(), '2026-10-31T13:00:00.000Z');
  } finally {
    setTimeZone('Asia/Tokyo');
  }
});

test('月の集計: 休憩と散歩を実働から引き、日付をまたぐ勤務は出勤日に数える', () => {
  const text = monthReport(october, '2026-10', at(31, 12, 0));
  assert.match(text, /出勤 2日 · 実働 \*\*12:10\*\* · 休憩 1:00 · 散歩 0:20/);
  assert.match(text, /10\/29\(木\) 09:00-18:00 休1:00 散0:20 実7:40/);
  assert.match(text, /10\/30\(金\) 22:00-翌02:30 休0:00 散0:00 実4:30/);
  assert.match(monthReport(october, '2026-09', at(31, 12, 0)), /記録はありません/);
});

test('CSV', () => {
  const lines = monthCsv(october, '2026-10', at(31, 12, 0)).split('\r\n');
  assert.equal(lines[0], '﻿日付,曜日,出勤,退勤,休憩(分),散歩(分),実働(分),実働(時間),立ち(分),備考');
  assert.equal(lines[1], '2026-10-29,木,09:00,18:00,60,20,460,7:40,0,');
  assert.equal(lines[2], '2026-10-30,金,22:00,翌02:30,0,0,270,4:30,0,');
});

test('立ち時間の表示', () => {
  const list = [P('in', 28, 9, 0), P('stand_start', 28, 10, 0), P('stand_end', 28, 10, 45), P('out', 28, 12, 0)];
  const now = at(28, 13, 0);
  assert.match(monthReport(list, '2026-10', now), /出勤 1日 · 実働 \*\*3:00\*\* · 休憩 0:00 · 散歩 0:00 · 立ち 0:45/);
  assert.match(monthReport(list, '2026-10', now), /10\/28\(水\) 09:00-12:00 休0:00 散0:00 実3:00 立0:45/);
  assert.equal(monthCsv(list, '2026-10', now).split('\r\n')[1], '2026-10-28,水,09:00,12:00,0,0,180,3:00,45,');
  assert.match(todayReport(list.slice(0, 2), at(28, 10, 15)), /勤務中 · 1:15 · 立ち 0:15/);
  assert.match(todayReport(list.slice(0, 2), at(28, 10, 15)), /実働 \*\*1:15\*\* · 休憩 0:00 · 散歩 0:00 · 立ち 0:15/);
  assert.equal(punchLogLine(P('stand_start', 30, 10, 0), at(30, 11, 0)), '🧍 <@a> 立ち開始 10:00');
});

test('今日の状況', () => {
  const list = [P('in', 30, 9, 0), P('walk_start', 30, 11, 0)];
  const text = todayReport(list, at(30, 11, 15));
  assert.match(text, /散歩中 · 0:15/);
  assert.match(text, /実働 \*\*2:00\*\* · 休憩 0:00 · 散歩 0:15/);
  assert.match(todayReport([], at(30, 9, 0)), /未出勤/);
  assert.match(todayReport(october.slice(0, 6), at(29, 19, 0)), /退勤済み/);
  assert.match(todayReport([P('in', 30, 9, 0)], at(30, 9, 30), true), /切断中/);
});

test('入力の解釈', () => {
  const now = at(30, 12, 0);
  assert.equal(parseMonth(undefined, now), '2026-10');
  assert.equal(parseMonth('2026-9', now), '2026-09');
  assert.equal(parseMonth('2026-13', now), null);
  assert.equal(parseDateTime(undefined, '9:05', now), at(30, 9, 5));
  assert.equal(parseDateTime('２０２６－１０－２９', '０９：３０', now), at(29, 9, 30));
  assert.equal(parseDateTime('2026-02-30', '09:00', now), null);
  assert.equal(parseDateTime(undefined, '25:00', now), null);
});

test('コマンド定義とログ', () => {
  assert.deepEqual(COMMANDS.map((c) => c.name), ['panel', 'today', 'month', 'csv', 'add', 'addshift', 'undo']);
  for (const c of COMMANDS) {
    assert.match(c.name, /^[a-z]{1,32}$/);
    assert.ok(c.description.length <= 100);
    const options = c.options ?? [];
    const firstOptional = options.findIndex((o) => !o.required);
    if (firstOptional >= 0) assert.ok(options.slice(firstOptional).every((o) => !o.required), `${c.name}: 必須の引数は先に並べる`);
  }
  assert.equal(punchLogLine(P('walk_start', 30, 10, 0), at(30, 11, 0)), '🚶 <@a> 散歩開始 10:00');
  assert.equal(punchLogLine({ ...P('in', 29, 9, 0), source: 'command' }, at(30, 11, 0)), '🟢 <@a> 出勤 2026-10-29 09:00（手動）');
});
