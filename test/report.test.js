'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { todayReport, monthReport, monthCsv } = require('../src/report');
const { parseMonth, parseDateTime, commandData, punchLogLine } = require('../src/bot');

const at = (d, h, m) => new Date(2026, 9, d, h, m).getTime();
let id = 0;
const P = (type, d, h, m) => ({ id: ++id, userId: 'a', type, ts: at(d, h, m), source: 'voice' });

const october = [
  P('in', 29, 9, 0), P('walk_start', 29, 10, 0), P('walk_end', 29, 10, 20),
  P('break_start', 29, 12, 0), P('break_end', 29, 13, 0), P('out', 29, 18, 0),
  P('in', 30, 22, 0), P('out', 31, 2, 30), // 日付をまたぐ勤務
];

test('月の集計: 休憩と散歩を実働から引き、日付をまたぐ勤務は出勤日に数える', () => {
  const text = monthReport(october, '2026-10', at(31, 12, 0));
  assert.match(text, /出勤 2日 · 実働 \*\*12:10\*\* · 休憩 1:00 · 散歩 0:20/);
  assert.match(text, /10\/29\(木\) 09:00-18:00 休1:00 散0:20 実7:40/);
  assert.match(text, /10\/30\(金\) 22:00-翌02:30 休0:00 散0:00 実4:30/);
  assert.match(monthReport(october, '2026-09', at(31, 12, 0)), /記録はありません/);
});

test('CSV', () => {
  const lines = monthCsv(october, '2026-10', at(31, 12, 0)).split('\r\n');
  assert.equal(lines[0], '﻿日付,曜日,出勤,退勤,休憩(分),散歩(分),実働(分),実働(時間),備考');
  assert.equal(lines[1], '2026-10-29,木,09:00,18:00,60,20,460,7:40,');
  assert.equal(lines[2], '2026-10-30,金,22:00,翌02:30,0,0,270,4:30,');
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
  assert.equal(parseMonth(null, now), '2026-10');
  assert.equal(parseMonth('2026-9', now), '2026-09');
  assert.equal(parseMonth('2026-13', now), null);
  assert.equal(parseDateTime(null, '9:05', now), at(30, 9, 5));
  assert.equal(parseDateTime('２０２６－１０－２９', '０９：３０', now), at(29, 9, 30));
  assert.equal(parseDateTime('2026-02-30', '09:00', now), null);
  assert.equal(parseDateTime(null, '25:00', now), null);
});

test('コマンド定義とログ', () => {
  assert.deepEqual(commandData.map((c) => c.name), ['panel', 'today', 'month', 'csv', 'add', 'undo']);
  assert.equal(punchLogLine(P('walk_start', 30, 10, 0), at(30, 11, 0)), '🚶 <@a> 散歩開始 10:00');
  assert.equal(punchLogLine({ ...P('in', 29, 9, 0), source: 'command' }, at(30, 11, 0)), '🟢 <@a> 出勤 2026-10-29 09:00（手動）');
});
