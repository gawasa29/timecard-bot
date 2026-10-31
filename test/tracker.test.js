import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './d1.js';
import { Store } from '../src/store.js';
import { Tracker } from '../src/tracker.js';
import { buildShifts, shiftStats, fmtTime } from '../src/shifts.js';
import { fromLocal } from '../src/time.js';

const MIN = 60 * 1000;
const A = 'user-a';
const B = 'user-b';

// 1 分ごとの確認を手で進められる Tracker
function setup({ graceMinutes = 5, maxAwayMinutes = 180 } = {}) {
  let now = fromLocal(2026, 10, 30, 9, 0);
  const inVoice = new Set();
  const store = new Store(createD1());
  const tracker = new Tracker({ store, graceMs: graceMinutes * MIN, maxAwayMs: maxAwayMinutes * MIN });
  const users = new Set([A]);
  const tick = async () => {
    for (const id of users) await tracker.observe(id, inVoice.has(id), now);
  };
  return {
    tracker,
    store,
    users,
    now: () => now,
    // minutes 分すすめる。1 分ごとに確認する
    advance: async (minutes) => {
      for (let i = 0; i < minutes; i++) {
        now += MIN;
        await tick();
      }
    },
    tick,
    join: (id = A) => inVoice.add(id),
    leave: (id = A) => inVoice.delete(id),
    press: (type, id = A) => tracker.press(id, type, now),
    punches: async (id = A) => (await store.list(id)).map((p) => `${p.type}@${fmtTime(p.ts)}`),
    stats: async (id = A) =>
      buildShifts(await store.list(id)).map((s) => {
        const r = shiftStats(s, now);
        return { work: r.workMs / MIN, break: r.breakMs / MIN, walk: r.walkMs / MIN, error: s.error };
      }),
  };
}

test('VC に入ると出勤、抜けて猶予が過ぎると抜けた時刻で退勤', async () => {
  const t = setup();
  t.join();
  await t.tick();
  await t.advance(8 * 60);
  t.leave();
  await t.advance(5); // 17:01 の確認で抜けたことに気づき、そこから猶予 5 分
  assert.deepEqual(await t.punches(), ['in@09:00']);
  await t.advance(1);
  assert.deepEqual(await t.punches(), ['in@09:00', 'out@17:01']);
  assert.deepEqual(await t.stats(), [{ work: 481, break: 0, walk: 0, error: false }]);
});

test('猶予内に戻れば勤務が続く', async () => {
  const t = setup();
  t.join();
  await t.tick();
  await t.advance(60);
  t.leave();
  await t.advance(3);
  t.join();
  await t.advance(30);
  assert.deepEqual(await t.punches(), ['in@09:00']);
  assert.equal((await t.tracker.state(A)).status, 'working');
  assert.equal((await t.tracker.presence(A)).leftAt, null);
});

test('変化がない確認では何も書き込まない', async () => {
  const t = setup();
  t.join();
  await t.tick();
  const { version } = await t.tracker.presence(A);
  await t.advance(30);
  assert.equal((await t.tracker.presence(A)).version, version);
});

test('散歩中は VC を抜けても退勤にならず、戻ると散歩が終わる', async () => {
  const t = setup();
  t.join();
  await t.tick();
  await t.advance(60);
  assert.equal((await t.press('walk_start')).ok, true);
  t.leave();
  await t.advance(30);
  t.join();
  await t.advance(1);
  assert.deepEqual(await t.punches(), ['in@09:00', 'walk_start@10:00', 'walk_end@10:31']);
  await t.advance(29);
  t.leave();
  await t.advance(6);
  assert.deepEqual(await t.stats(), [{ work: 90, break: 0, walk: 31, error: false }]);
});

test('休憩は VC にいたままでも記録でき、実働から引く', async () => {
  const t = setup();
  t.join();
  await t.tick();
  await t.advance(180);
  await t.press('break_start');
  await t.advance(60);
  await t.press('break_end');
  await t.advance(60);
  assert.deepEqual(await t.punches(), ['in@09:00', 'break_start@12:00', 'break_end@13:00']);
  assert.deepEqual(await t.stats(), [{ work: 240, break: 60, walk: 0, error: false }]);
});

test('VC を抜けた直後（猶予中）に散歩開始を押すと、抜けた時刻から散歩になる', async () => {
  const t = setup();
  t.join();
  await t.tick();
  await t.advance(60);
  t.leave();
  await t.advance(2);
  assert.equal((await t.press('walk_start')).ok, true);
  await t.advance(10);
  assert.deepEqual(await t.punches(), ['in@09:00', 'walk_start@10:01']);
  assert.equal((await t.tracker.state(A)).status, 'walk');
});

test('VC の外で休憩終了を押し、戻らなければその時刻で退勤', async () => {
  const t = setup();
  t.join();
  await t.tick();
  await t.advance(60);
  await t.press('break_start');
  t.leave();
  await t.advance(30);
  const r = await t.press('break_end');
  assert.match(r.note, /5分以内/);
  await t.advance(5);
  assert.deepEqual(await t.punches(), ['in@09:00', 'break_start@10:00', 'break_end@10:30', 'out@10:30']);
});

test('戻らない休憩・散歩は、抜けた時点の退勤になる', async () => {
  const t = setup({ maxAwayMinutes: 180 });
  t.join();
  await t.tick();
  await t.advance(60);
  await t.press('walk_start');
  t.leave();
  await t.advance(180);
  assert.equal((await t.tracker.state(A)).status, 'walk');
  await t.advance(1);
  assert.deepEqual(await t.punches(), ['in@09:00', 'walk_start@10:00', 'out@10:00']);
  assert.deepEqual(await t.stats(), [{ work: 60, break: 0, walk: 0, error: false }]);
  t.join();
  await t.advance(1);
  assert.equal((await t.tracker.state(A)).status, 'working');
});

test('休憩中に VC にいたままなら、長くなっても退勤にしない', async () => {
  const t = setup({ maxAwayMinutes: 60 });
  t.join();
  await t.tick();
  await t.press('break_start');
  await t.advance(120);
  assert.equal((await t.tracker.state(A)).status, 'break');
});

test('ボタンは今の状態で押せるものだけ受け付ける', async () => {
  const t = setup();
  assert.equal((await t.press('break_start')).ok, false);
  t.join();
  await t.tick();
  assert.equal((await t.press('break_end')).ok, false);
  assert.equal((await t.press('walk_start')).ok, true);
  assert.equal((await t.press('break_start')).ok, false);
  assert.equal((await t.press('break_end')).ok, false);
  assert.equal((await t.press('out')).ok, false);
  assert.equal((await t.press('nope')).ok, false);
});

test('立ち時間は実働から引かず、休憩に入ると終わる', async () => {
  const t = setup();
  t.join();
  await t.tick();
  assert.equal((await t.press('stand_end')).ok, false);
  await t.advance(10);
  assert.equal((await t.press('stand_start')).ok, true);
  assert.match((await t.press('stand_start')).message, /すでに立っています/);
  await t.advance(20);
  assert.equal((await t.press('stand_end')).ok, true);
  await t.advance(10);
  await t.press('stand_start');
  await t.advance(15);
  assert.equal((await t.press('break_start')).ok, true);
  assert.equal((await t.press('stand_start')).ok, false);
  assert.equal((await t.press('stand_end')).ok, false);
  await t.advance(30);
  await t.press('break_end');
  const [shift] = buildShifts(await t.store.list(A));
  assert.equal(shift.error, false);
  const stats = shiftStats(shift, t.now());
  assert.equal(stats.standMs / MIN, 35);
  assert.equal(stats.workMs / MIN, 55);
  assert.equal((await t.tracker.state(A)).stand, null);
});

test('立ったまま VC を抜けると、抜けた時刻で立ち時間も退勤も終わる', async () => {
  const t = setup();
  t.join();
  await t.tick();
  await t.press('stand_start');
  await t.advance(30);
  t.leave();
  await t.advance(6);
  assert.deepEqual(await t.punches(), ['in@09:00', 'stand_start@09:00', 'out@09:31']);
  const [shift] = buildShifts(await t.store.list(A));
  assert.equal(shift.error, false);
  assert.equal(shiftStats(shift, t.now()).standMs / MIN, 31);
});

test('猶予中の立ちボタンでも打刻の順番が崩れない', async () => {
  const t = setup();
  t.join();
  await t.tick();
  await t.press('stand_start');
  await t.advance(30);
  t.leave();
  await t.advance(2);
  assert.equal((await t.press('stand_end')).ok, true);
  assert.match((await t.press('stand_start')).message, /戻ってから/);
  await t.advance(10);
  assert.deepEqual(await t.punches(), ['in@09:00', 'stand_start@09:00', 'stand_end@09:31', 'out@09:31']);
  assert.equal(buildShifts(await t.store.list(A))[0].error, false);
});

test('初めての確認で VC にいれば出勤、いなければ何も記録しない', async () => {
  const t = setup();
  await t.tick();
  assert.deepEqual(await t.punches(), []);
  t.join();
  await t.tick();
  assert.deepEqual(await t.punches(), ['in@09:00']);
});

test('同時に動いた操作は片方だけ反映する', async () => {
  const t = setup();
  t.join();
  await Promise.all([t.tick(), t.tick(), t.press('walk_start')]);
  const punches = await t.punches();
  assert.equal(punches.filter((p) => p.startsWith('in@')).length, 1);
  assert.equal((await t.stats()).every((s) => !s.error), true);
});

test('手動追加は順番が合う打刻だけ受け付ける', async () => {
  const t = setup();
  const now = fromLocal(2026, 10, 30, 19, 0);
  const at = (h, m) => fromLocal(2026, 10, 30, h, m);
  const add = (type, ts) => t.tracker.addManual(A, [{ type, ts }], now);
  assert.match((await add('in', at(20, 0))).message, /未来/);
  assert.equal((await add('break_end', at(12, 0))).ok, false);
  assert.equal((await add('in', at(9, 0))).ok, true);
  assert.equal((await add('out', at(18, 0))).ok, true);
  assert.equal((await add('walk_start', at(10, 0))).ok, true);
  assert.equal((await add('break_start', at(10, 30))).ok, false); // 散歩と重なる
  assert.equal((await add('walk_end', at(10, 20))).ok, true);
  assert.equal((await add('in', at(17, 0))).ok, false); // 勤務の途中に出勤
  assert.deepEqual(await t.punches(), ['in@09:00', 'walk_start@10:00', 'walk_end@10:20', 'out@18:00']);
});

test('出勤だけでは順番が合わない過去の勤務も、退勤と一緒なら追加できる', async () => {
  const t = setup();
  t.join();
  await t.tick(); // 10/30 09:00 に出勤
  const now = t.now();
  const day29 = (h, m) => fromLocal(2026, 10, 29, h, m);
  assert.equal((await t.tracker.addManual(A, [{ type: 'in', ts: day29(9, 0) }], now)).ok, false);
  const r = await t.tracker.addManual(A, [{ type: 'in', ts: day29(9, 0) }, { type: 'out', ts: day29(18, 0) }], now);
  assert.equal(r.ok, true);
  assert.equal(r.punches.length, 2);
  assert.equal((await t.stats()).every((s) => !s.error), true);
});

test('取り消しは最後に記録した打刻を消す', async () => {
  const t = setup();
  t.join();
  await t.tick();
  await t.advance(60);
  await t.press('break_start');
  assert.equal((await t.tracker.undo(A)).punch.type, 'break_start');
  assert.deepEqual(await t.punches(), ['in@09:00']);
  await t.tracker.undo(A);
  assert.equal((await t.tracker.undo(A)).ok, false);
});

test('複数人を別々に記録する', async () => {
  const t = setup();
  t.users.add(B);
  t.join(A);
  await t.tick();
  await t.advance(30);
  t.join(B);
  await t.advance(1);
  await t.press('walk_start', A);
  assert.equal((await t.tracker.state(A)).status, 'walk');
  assert.equal((await t.tracker.state(B)).status, 'working');
  assert.deepEqual(await t.punches(B), ['in@09:31']);
});
