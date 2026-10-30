'use strict';

const { STATUS_LABELS, buildShifts, currentState, errorCount } = require('./shifts');

const AWAY_NAMES = { break: '休憩', walk: '散歩' };
const ok = (punch, note = '') => ({ ok: true, punch, note });
const fail = (message) => ({ ok: false, message });

// VC の入退室とボタン操作を打刻に変える。
// - 勤務用 VC に入ると出勤、抜けると猶予（graceMs）のあとに退勤。猶予内に戻れば勤務が続く。
// - 休憩・散歩中は VC を抜けても退勤にしない。VC に戻ると休憩・散歩を終える。
// - maxAwayMs を過ぎても戻らない休憩・散歩は、抜けた時点で退勤したものとみなす。
class Tracker {
  constructor({ store, graceMs, maxAwayMs, isInWorkVoice, now = Date.now, timers = { set: setTimeout, clear: clearTimeout }, onPunch = () => {} }) {
    this.store = store;
    this.graceMs = graceMs;
    this.maxAwayMs = maxAwayMs;
    this.isInWorkVoice = isInWorkVoice;
    this.now = now;
    this.timers = timers;
    this.onPunch = onPunch;
    this.pending = new Map(); // userId -> { timer, leftAt }
  }

  state(userId) {
    return currentState(buildShifts(this.store.list(userId)));
  }

  isDisconnected(userId) {
    return this.pending.has(userId);
  }

  record(userId, type, ts, source) {
    const punch = this.store.add(userId, type, ts, source);
    this.onPunch(punch);
    return punch;
  }

  cancelPending(userId) {
    const pending = this.pending.get(userId);
    if (!pending) return null;
    this.timers.clear(pending.timer);
    this.pending.delete(userId);
    return pending;
  }

  startGrace(userId, leftAt) {
    this.cancelPending(userId);
    const timer = this.timers.set(() => {
      this.pending.delete(userId);
      if (this.state(userId).status === 'working' && !this.isInWorkVoice(userId)) {
        this.record(userId, 'out', leftAt, 'voice');
      }
    }, Math.max(0, leftAt + this.graceMs - this.now()));
    this.pending.set(userId, { timer, leftAt });
  }

  // ---------- ボイスチャンネル ----------
  voiceChanged(userId, wasIn, isIn) {
    if (wasIn === isIn) return;
    if (isIn) this.joined(userId);
    else this.left(userId);
  }

  joined(userId) {
    if (this.cancelPending(userId)) return; // 猶予内に戻った
    const now = this.now();
    const { status, away } = this.state(userId);
    if (status === 'off') {
      this.record(userId, 'in', now, 'voice');
    } else if (away) {
      if (now - away.start > this.maxAwayMs) {
        this.record(userId, 'out', away.start, 'auto');
        this.record(userId, 'in', now, 'voice');
      } else {
        this.record(userId, `${away.kind}_end`, now, 'voice');
      }
    }
  }

  left(userId) {
    if (this.state(userId).status === 'working') this.startGrace(userId, this.now());
  }

  // ---------- パネルのボタン ----------
  press(userId, type) {
    const { status } = this.state(userId);
    const pending = this.pending.get(userId);

    if (type === 'break_start' || type === 'walk_start') {
      if (status === 'off') return fail('出勤していません。勤務用のボイスチャンネルに入ると出勤になります。');
      if (status !== 'working') return fail(`今は${STATUS_LABELS[status]}です。`);
      // VC を抜けた直後に押したなら、抜けた時刻から休憩・散歩にする
      const ts = pending ? pending.leftAt : this.now();
      this.cancelPending(userId);
      return ok(this.record(userId, type, ts, 'button'));
    }

    if (type === 'break_end' || type === 'walk_end') {
      const kind = type === 'break_end' ? 'break' : 'walk';
      if (status !== kind) return fail(`${AWAY_NAMES[kind]}中ではありません。`);
      const punch = this.record(userId, type, this.now(), 'button');
      if (this.isInWorkVoice(userId)) return ok(punch);
      this.startGrace(userId, punch.ts);
      const minutes = Math.round(this.graceMs / 60000);
      return ok(punch, `勤務用のボイスチャンネルに${minutes}分以内に戻らないと、この時刻で退勤になります。`);
    }

    if (type === 'out') {
      if (status === 'off') return fail('出勤していません。');
      if (this.isInWorkVoice(userId)) return fail('勤務用のボイスチャンネルを抜けると退勤になります。');
      const ts = pending ? pending.leftAt : this.now();
      this.cancelPending(userId);
      return ok(this.record(userId, 'out', ts, 'button'));
    }

    return fail('不明な操作です。');
  }

  // ---------- コマンドでの修正 ----------
  addManual(userId, type, ts) {
    if (ts > this.now()) return fail('未来の時刻は追加できません。');
    const list = this.store.list(userId);
    const candidate = [...list, { id: Number.MAX_SAFE_INTEGER, userId, type, ts }];
    if (errorCount(candidate) > errorCount(list)) {
      return fail('その時刻に入れると打刻の順番が合わなくなります（出勤で始め、休憩・散歩は開始と終了を対にする）。');
    }
    return ok(this.record(userId, type, ts, 'command'));
  }

  undo(userId) {
    const punch = this.store.lastAdded(userId);
    if (!punch) return fail('取り消せる打刻がありません。');
    this.store.remove(punch.id);
    if (this.state(userId).status !== 'working') this.cancelPending(userId);
    return ok(punch);
  }

  // ---------- 起動時と定期処理 ----------
  // ボットが止まっていた間の入退室に合わせる
  reconcile(userIds) {
    const now = this.now();
    for (const userId of userIds) {
      const { status } = this.state(userId);
      const inVoice = this.isInWorkVoice(userId);
      if (inVoice && status === 'off') this.record(userId, 'in', now, 'reconcile');
      else if (!inVoice && status === 'working') this.startGrace(userId, now);
    }
    this.sweep(userIds);
  }

  // 戻らない休憩・散歩を、抜けた時点の退勤にする
  sweep(userIds) {
    const now = this.now();
    for (const userId of userIds) {
      const { away } = this.state(userId);
      if (away && now - away.start > this.maxAwayMs && !this.isInWorkVoice(userId)) {
        this.record(userId, 'out', away.start, 'auto');
      }
    }
  }
}

module.exports = { Tracker };
