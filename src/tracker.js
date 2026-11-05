import { STATUS_LABELS, buildShifts, currentState, errorCount } from './shifts.js';

const NO_PRESENCE = { state: null, leftAt: null, version: null };
const fail = (message) => ({ ok: false, message });

// VC にいるかどうかの確認（定期実行とボタン操作のとき）とボタン操作を打刻に変える。
// vcState: 'work'（勤務として数える VC）/ 'other'（それ以外の VC）/ 'none'（VC の外）
// - 勤務用 VC に入ると出勤、抜けると猶予（graceMs）のあとに、抜けた時刻で退勤。猶予内に戻れば勤務が続く。
// - 勤務用 VC から別の VC に移ると休憩。勤務用 VC に戻ると休憩を終える。
// - 休憩中は VC を抜けても退勤にしない。maxAwayMs を過ぎても戻らない休憩は、抜けた時点で退勤したものとみなす。
export class Tracker {
  constructor({ store, graceMs, maxAwayMs, onPunch = () => {} }) {
    this.store = store;
    this.graceMs = graceMs;
    this.maxAwayMs = maxAwayMs;
    this.onPunch = onPunch;
  }

  async state(userId) {
    return currentState(buildShifts(await this.store.list(userId)));
  }

  async presence(userId) {
    return (await this.store.getPresence(userId)) ?? NO_PRESENCE;
  }

  async record(userId, type, ts, source) {
    const punch = await this.store.add(userId, type, ts, source);
    this.onPunch(punch);
    return punch;
  }

  // presence を読んだときのまま更新できたときだけ打刻を書く。
  // 定期実行とボタン操作が同時に動いても二重に記録しないため。
  async commit(userId, presence, next, punches) {
    if (!(await this.store.savePresence(userId, next, presence.version))) return null;
    const recorded = [];
    for (const p of punches) recorded.push(await this.record(userId, p.type, p.ts, p.source));
    return recorded;
  }

  // ---------- VC にいるかの確認 ----------
  async observe(userId, vcState, now) {
    const presence = await this.presence(userId);
    const prev = presence.state ?? 'none';
    const { status, onBreak } = await this.state(userId);
    const punches = [];
    let leftAt = presence.leftAt;
    const awayTooLong = status === 'break' && onBreak && now - onBreak.start > this.maxAwayMs;

    if (vcState === 'work') {
      // 勤務用 VC に戻れば、猶予も休憩も終わる
      leftAt = null;
      if (prev !== 'work') {
        if (status === 'off') {
          punches.push({ type: 'in', ts: now, source: 'voice' });
        } else if (status === 'break') {
          if (awayTooLong) {
            punches.push({ type: 'out', ts: onBreak.start, source: 'auto' }, { type: 'in', ts: now, source: 'voice' });
          } else {
            punches.push({ type: 'break_end', ts: now, source: 'voice' });
          }
        }
      }
      // 勤務用 VC にいたままの休憩は、長くなっても退勤にしない
    } else if (vcState === 'other') {
      if (status === 'working') {
        if (prev === 'none') {
          if (leftAt === null) leftAt = now;
          if (now - leftAt >= this.graceMs) {
            // 猶予が過ぎていたら、抜けた時点で退勤
            punches.push({ type: 'out', ts: leftAt, source: 'voice' });
          } else {
            // 猶予中に別の VC へ移ったら、抜けた時刻から休憩にする
            punches.push({ type: 'break_start', ts: leftAt, source: 'voice' });
          }
          leftAt = null;
        } else if (prev === 'work') {
          punches.push({ type: 'break_start', ts: now, source: 'voice' });
        }
      }
      if (awayTooLong) {
        punches.push({ type: 'out', ts: onBreak.start, source: 'auto' });
        leftAt = null;
      }
    } else {
      if (status === 'working' && leftAt === null) leftAt = now;
      if (leftAt !== null && now - leftAt >= this.graceMs) {
        if (status === 'working') punches.push({ type: 'out', ts: leftAt, source: 'voice' });
        leftAt = null;
      }
      if (awayTooLong) {
        punches.push({ type: 'out', ts: onBreak.start, source: 'auto' });
        leftAt = null;
      }
    }

    const unchanged = presence.version !== null && presence.state === vcState && presence.leftAt === leftAt;
    if (unchanged && punches.length === 0) return [];
    return (await this.commit(userId, presence, { state: vcState, leftAt }, punches)) ?? [];
  }

  // ---------- パネルのボタン ----------
  async press(userId, type, now) {
    const presence = await this.presence(userId);
    const { status, stand } = await this.state(userId);
    const next = { state: presence.state, leftAt: presence.leftAt };
    let punch;

    if (type === 'stand_start') {
      if (status === 'off') return fail('出勤していません。勤務用のボイスチャンネルに入ると出勤になります。');
      if (status !== 'working') return fail(`今は${STATUS_LABELS[status]}です。`);
      if (stand) return fail('すでに立っています。');
      // 猶予が過ぎると抜けた時刻で退勤になるので、そのあとの時刻で始めない
      if (presence.leftAt !== null) return fail('勤務用のボイスチャンネルに戻ってから押してください。');
      punch = { type, ts: now, source: 'button' };
    } else if (type === 'stand_end') {
      if (!stand) return fail('立っていません。');
      // VC を抜けた直後（猶予中）に押したなら、抜けた時刻で終える
      punch = { type, ts: presence.leftAt ?? now, source: 'button' };
    } else {
      return fail('不明な操作です。');
    }

    const recorded = await this.commit(userId, presence, next, [punch]);
    if (!recorded) return fail('ほかの操作と重なりました。もう一度押してください。');
    return { ok: true, punch: recorded[0] };
  }

  // ---------- コマンドでの修正 ----------
  // additions: [{ type, ts }]。出勤と退勤のように、まとめて入れると順番が合う打刻は一緒に渡す
  async addManual(userId, additions, now) {
    if (additions.some((a) => a.ts > now)) return fail('未来の時刻は追加できません。');
    const list = await this.store.list(userId);
    const candidate = [...list, ...additions.map((a, i) => ({ id: Number.MAX_SAFE_INTEGER - additions.length + i, userId, ...a }))];
    if (errorCount(candidate) > errorCount(list)) {
      return fail('その時刻に入れると打刻の順番が合わなくなります（出勤で始め、休憩・立ちは開始と終了を対にする）。');
    }
    const punches = [];
    for (const a of additions) punches.push(await this.record(userId, a.type, a.ts, 'command'));
    return { ok: true, punches };
  }

  async undo(userId) {
    const punch = await this.store.lastAdded(userId);
    if (!punch) return fail('取り消せる打刻がありません。');
    await this.store.remove(punch.id);
    return { ok: true, punch };
  }
}
