'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');
const { Tracker } = require('../src/tracker');
const { buildShifts, shiftStats, fmtTime } = require('../src/shifts');

const MIN = 60 * 1000;
const A = 'user-a';

// 時計とタイマーを手で進められる Tracker
function setup({ graceMinutes = 5, maxAwayMinutes = 180 } = {}) {
  let now = new Date(2026, 9, 30, 9, 0).getTime();
  const timers = [];
  const inVoice = new Set();
  const store = new Store(':memory:');
  const tracker = new Tracker({
    store,
    graceMs: graceMinutes * MIN,
    maxAwayMs: maxAwayMinutes * MIN,
    isInWorkVoice: (id) => inVoice.has(id),
    now: () => now,
    timers: {
      set: (fn, ms) => {
        const t = { fn, at: now + ms, done: false };
        timers.push(t);
        return t;
      },
      clear: (t) => {
        t.done = true;
      },
    },
  });
  const advance = (minutes) => {
    now += minutes * MIN;
    for (const t of timers) {
      if (!t.done && t.at <= now) {
        t.done = true;
        t.fn();
      }
    }
  };
  // discord.js と同じく、キャッシュを更新してからイベントを渡す
  const join = (id = A) => {
    inVoice.add(id);
    tracker.voiceChanged(id, false, true);
  };
  const leave = (id = A) => {
    inVoice.delete(id);
    tracker.voiceChanged(id, true, false);
  };
  const punches = (id = A) => store.list(id).map((p) => `${p.type}@${fmtTime(p.ts)}`);
  const stats = (id = A) => {
    const s = buildShifts(store.list(id));
    return s.map((x) => {
      const r = shiftStats(x, now);
      return { work: r.workMs / MIN, break: r.breakMs / MIN, walk: r.walkMs / MIN, error: x.error };
    });
  };
  return { tracker, store, advance, join, leave, punches, stats, setNow: (d) => (now = d.getTime()) };
}

test('VC に入ると出勤、抜けて猶予が過ぎると抜けた時刻で退勤', () => {
  const t = setup();
  t.join();
  t.advance(8 * 60);
  t.leave();
  t.advance(4);
  assert.deepEqual(t.punches(), ['in@09:00']);
  t.advance(1);
  assert.deepEqual(t.punches(), ['in@09:00', 'out@17:00']);
  assert.deepEqual(t.stats(), [{ work: 480, break: 0, walk: 0, error: false }]);
});

test('猶予内に戻れば勤務が続く', () => {
  const t = setup();
  t.join();
  t.advance(60);
  t.leave();
  t.advance(3);
  t.join();
  t.advance(10);
  assert.deepEqual(t.punches(), ['in@09:00']);
  assert.equal(t.tracker.state(A).status, 'working');
});

test('VC 間の移動やミュートなどでは何も起きない', () => {
  const t = setup();
  t.tracker.voiceChanged(A, false, false);
  t.join();
  t.tracker.voiceChanged(A, true, true);
  assert.deepEqual(t.punches(), ['in@09:00']);
});

test('散歩中は VC を抜けても退勤にならず、戻ると散歩が終わる', () => {
  const t = setup();
  t.join();
  t.advance(60);
  assert.equal(t.tracker.press(A, 'walk_start').ok, true);
  t.leave();
  t.advance(30);
  t.join();
  assert.deepEqual(t.punches(), ['in@09:00', 'walk_start@10:00', 'walk_end@10:30']);
  t.advance(30);
  t.leave();
  t.advance(5);
  assert.deepEqual(t.stats(), [{ work: 90, break: 0, walk: 30, error: false }]);
});

test('休憩は VC にいたままでも記録でき、実働から引く', () => {
  const t = setup();
  t.join();
  t.advance(180);
  t.tracker.press(A, 'break_start');
  t.advance(60);
  t.tracker.press(A, 'break_end');
  t.advance(60);
  t.leave();
  t.advance(5);
  assert.deepEqual(t.punches(), ['in@09:00', 'break_start@12:00', 'break_end@13:00', 'out@14:00']);
  assert.deepEqual(t.stats(), [{ work: 240, break: 60, walk: 0, error: false }]);
});

test('VC を抜けた直後に散歩開始を押すと、抜けた時刻から散歩になる', () => {
  const t = setup();
  t.join();
  t.advance(60);
  t.leave();
  t.advance(2);
  const r = t.tracker.press(A, 'walk_start');
  assert.equal(r.ok, true);
  t.advance(10);
  assert.deepEqual(t.punches(), ['in@09:00', 'walk_start@10:00']);
  assert.equal(t.tracker.state(A).status, 'walk');
});

test('VC の外で休憩終了を押し、戻らなければその時刻で退勤', () => {
  const t = setup();
  t.join();
  t.advance(60);
  t.tracker.press(A, 'break_start');
  t.leave();
  t.advance(30);
  const r = t.tracker.press(A, 'break_end');
  assert.match(r.note, /5分以内/);
  t.advance(5);
  assert.deepEqual(t.punches(), ['in@09:00', 'break_start@10:00', 'break_end@10:30', 'out@10:30']);
});

test('戻らない休憩・散歩は、抜けた時点の退勤になる', () => {
  const t = setup({ maxAwayMinutes: 180 });
  t.join();
  t.advance(60);
  t.tracker.press(A, 'walk_start');
  t.leave();
  t.advance(170);
  t.tracker.sweep([A]);
  assert.equal(t.tracker.state(A).status, 'walk');
  t.advance(20);
  t.tracker.sweep([A]);
  assert.deepEqual(t.punches(), ['in@09:00', 'walk_start@10:00', 'out@10:00']);
  assert.deepEqual(t.stats(), [{ work: 60, break: 0, walk: 0, error: false }]);
  t.join();
  assert.equal(t.tracker.state(A).status, 'working');
});

test('長い休憩のあとに VC に戻ると、前の勤務を締めて新しく出勤する', () => {
  const t = setup({ maxAwayMinutes: 180 });
  t.join();
  t.advance(60);
  t.tracker.press(A, 'break_start');
  t.leave();
  t.advance(240);
  t.join();
  assert.deepEqual(t.punches(), ['in@09:00', 'break_start@10:00', 'out@10:00', 'in@14:00']);
  assert.equal(t.stats().every((s) => !s.error), true);
});

test('ボタンは今の状態で押せるものだけ受け付ける', () => {
  const t = setup();
  assert.equal(t.tracker.press(A, 'break_start').ok, false);
  t.join();
  assert.equal(t.tracker.press(A, 'break_end').ok, false);
  assert.equal(t.tracker.press(A, 'walk_start').ok, true);
  assert.equal(t.tracker.press(A, 'break_start').ok, false);
  assert.equal(t.tracker.press(A, 'break_end').ok, false);
  assert.match(t.tracker.press(A, 'out').message, /抜けると退勤/);
  assert.equal(t.tracker.press(A, 'nope').ok, false);
});

test('VC の外からの退勤ボタン', () => {
  const t = setup();
  t.join();
  t.advance(60);
  t.tracker.press(A, 'walk_start');
  t.leave();
  t.advance(30);
  assert.equal(t.tracker.press(A, 'out').ok, true);
  assert.deepEqual(t.punches(), ['in@09:00', 'walk_start@10:00', 'out@10:30']);
  assert.deepEqual(t.stats(), [{ work: 60, break: 0, walk: 30, error: false }]);
});

test('猶予中に退勤ボタンを押すと、抜けた時刻で退勤', () => {
  const t = setup();
  t.join();
  t.advance(60);
  t.leave();
  t.advance(2);
  t.tracker.press(A, 'out');
  t.advance(10);
  assert.deepEqual(t.punches(), ['in@09:00', 'out@10:00']);
});

test('手動追加は順番が合う打刻だけ受け付ける', () => {
  const t = setup();
  t.advance(10 * 60); // 19:00
  const at = (h, m) => new Date(2026, 9, 30, h, m).getTime();
  assert.match(t.tracker.addManual(A, 'in', at(20, 0)).message, /未来/);
  assert.equal(t.tracker.addManual(A, 'break_end', at(12, 0)).ok, false);
  assert.equal(t.tracker.addManual(A, 'in', at(9, 0)).ok, true);
  assert.equal(t.tracker.addManual(A, 'out', at(18, 0)).ok, true);
  assert.equal(t.tracker.addManual(A, 'walk_start', at(10, 0)).ok, true);
  assert.equal(t.tracker.addManual(A, 'break_start', at(10, 30)).ok, false); // 散歩と重なる
  assert.equal(t.tracker.addManual(A, 'walk_end', at(10, 20)).ok, true);
  assert.equal(t.tracker.addManual(A, 'in', at(17, 0)).ok, false); // 勤務の途中に出勤
  assert.deepEqual(t.punches(), ['in@09:00', 'walk_start@10:00', 'walk_end@10:20', 'out@18:00']);
});

test('取り消しは最後に記録した打刻を消す', () => {
  const t = setup();
  t.join();
  t.advance(60);
  t.tracker.press(A, 'break_start');
  assert.equal(t.tracker.undo(A).punch.type, 'break_start');
  assert.deepEqual(t.punches(), ['in@09:00']);
  t.tracker.undo(A);
  assert.equal(t.tracker.undo(A).ok, false);
});

test('起動時の補正: VC にいるのに未出勤なら出勤、いないのに勤務中なら猶予後に退勤', () => {
  const t = setup();
  const B = 'user-b';
  t.store.add(B, 'in', new Date(2026, 9, 30, 8, 0).getTime(), 'voice');
  t.join(A);
  t.store.remove(t.store.lastAdded(A).id); // ボットが止まっている間に入った状態にする
  t.tracker.reconcile([A, B]);
  assert.deepEqual(t.punches(A), ['in@09:00']);
  t.advance(5);
  assert.deepEqual(t.punches(B), ['in@08:00', 'out@09:00']);
});

test('複数人を別々に記録する', () => {
  const t = setup();
  const B = 'user-b';
  t.join(A);
  t.advance(30);
  t.join(B);
  t.tracker.press(A, 'walk_start');
  assert.equal(t.tracker.state(A).status, 'walk');
  assert.equal(t.tracker.state(B).status, 'working');
  assert.deepEqual(t.punches(B), ['in@09:30']);
});
