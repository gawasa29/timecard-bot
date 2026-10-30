import { STATUS_LABELS, buildShifts, currentState, errorCount } from './shifts.js';

const AWAY_NAMES = { break: '休憩', walk: '散歩' };
const NO_PRESENCE = { inVoice: false, leftAt: null, version: null };
const fail = (message) => ({ ok: false, message });

// VC にいるかどうかの確認（定期実行とボタン操作のとき）とボタン操作を打刻に変える。
// - 勤務用 VC に入ると出勤、抜けると猶予（graceMs）のあとに、抜けた時刻で退勤。猶予内に戻れば勤務が続く。
// - 休憩・散歩中は VC を抜けても退勤にしない。VC に戻ると休憩・散歩を終える。
// - maxAwayMs を過ぎても戻らない休憩・散歩は、抜けた時点で退勤したものとみなす。
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
  async observe(userId, inVoice, now) {
    const presence = await this.presence(userId);
    const { status, away } = await this.state(userId);
    const punches = [];
    let leftAt = presence.leftAt;

    if (inVoice) {
      if (leftAt !== null) {
        leftAt = null; // 猶予内に戻った
      } else if (!presence.inVoice) {
        if (status === 'off') {
          punches.push({ type: 'in', ts: now, source: 'voice' });
        } else if (away && now - away.start > this.maxAwayMs) {
          punches.push({ type: 'out', ts: away.start, source: 'auto' }, { type: 'in', ts: now, source: 'voice' });
        } else if (away) {
          punches.push({ type: `${away.kind}_end`, ts: now, source: 'voice' });
        }
      }
    } else {
      // 勤務中に VC を抜けた（初めての確認で VC の外にいた場合も含む）
      if (status === 'working' && leftAt === null && (presence.inVoice || presence.version === null)) leftAt = now;
      if (leftAt !== null && now - leftAt >= this.graceMs) {
        if (status === 'working') punches.push({ type: 'out', ts: leftAt, source: 'voice' });
        leftAt = null;
      } else if (away && now - away.start > this.maxAwayMs) {
        punches.push({ type: 'out', ts: away.start, source: 'auto' });
      }
    }

    const unchanged = presence.version !== null && presence.inVoice === inVoice && presence.leftAt === leftAt;
    if (unchanged && punches.length === 0) return [];
    return (await this.commit(userId, presence, { inVoice, leftAt }, punches)) ?? [];
  }

  // ---------- パネルのボタン ----------
  async press(userId, type, now) {
    const presence = await this.presence(userId);
    const { status } = await this.state(userId);
    const next = { inVoice: presence.inVoice, leftAt: presence.leftAt };
    let punch;
    let note = '';

    if (type === 'break_start' || type === 'walk_start') {
      if (status === 'off') return fail('出勤していません。勤務用のボイスチャンネルに入ると出勤になります。');
      if (status !== 'working') return fail(`今は${STATUS_LABELS[status]}です。`);
      // VC を抜けた直後（猶予中）に押したなら、抜けた時刻から休憩・散歩にする
      punch = { type, ts: presence.leftAt ?? now, source: 'button' };
      next.leftAt = null;
    } else if (type === 'break_end' || type === 'walk_end') {
      const kind = type === 'break_end' ? 'break' : 'walk';
      if (status !== kind) return fail(`${AWAY_NAMES[kind]}中ではありません。`);
      punch = { type, ts: now, source: 'button' };
      if (!presence.inVoice) {
        next.leftAt = now;
        note = `勤務用のボイスチャンネルに${Math.round(this.graceMs / 60000)}分以内に戻らないと、この時刻で退勤になります。`;
      }
    } else if (type === 'out') {
      if (status === 'off') return fail('出勤していません。');
      if (presence.inVoice) return fail('勤務用のボイスチャンネルを抜けると退勤になります。');
      punch = { type, ts: presence.leftAt ?? now, source: 'button' };
      next.leftAt = null;
    } else {
      return fail('不明な操作です。');
    }

    const recorded = await this.commit(userId, presence, next, [punch]);
    if (!recorded) return fail('ほかの操作と重なりました。もう一度押してください。');
    return { ok: true, punch: recorded[0], note };
  }

  // ---------- コマンドでの修正 ----------
  // additions: [{ type, ts }]。出勤と退勤のように、まとめて入れると順番が合う打刻は一緒に渡す
  async addManual(userId, additions, now) {
    if (additions.some((a) => a.ts > now)) return fail('未来の時刻は追加できません。');
    const list = await this.store.list(userId);
    const candidate = [...list, ...additions.map((a, i) => ({ id: Number.MAX_SAFE_INTEGER - additions.length + i, userId, ...a }))];
    if (errorCount(candidate) > errorCount(list)) {
      return fail('その時刻に入れると打刻の順番が合わなくなります（出勤で始め、休憩・散歩は開始と終了を対にする）。');
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
