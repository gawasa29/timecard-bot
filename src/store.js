// D1（SQLite）への保存。スキーマは migrations/ にある。

export class Store {
  constructor(db) {
    this.db = db;
  }

  // source: voice（VC の入退室）/ button / command（手動）/ auto（戻らない休憩・散歩の締め）
  async add(userId, type, ts, source) {
    const row = await this.db
      .prepare('INSERT INTO punches (user_id, type, ts, source) VALUES (?, ?, ?, ?) RETURNING id')
      .bind(userId, type, ts, source)
      .first();
    return { id: row.id, userId, type, ts, source };
  }

  async list(userId) {
    const { results } = await this.db
      .prepare('SELECT id, type, ts, source FROM punches WHERE user_id = ? ORDER BY ts, id')
      .bind(userId)
      .all();
    return results.map((r) => ({ id: r.id, userId, type: r.type, ts: r.ts, source: r.source }));
  }

  // 最後に記録した打刻（時刻順ではなく記録順）
  async lastAdded(userId) {
    const r = await this.db
      .prepare('SELECT id, type, ts, source FROM punches WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .bind(userId)
      .first();
    return r && { id: r.id, userId, type: r.type, ts: r.ts, source: r.source };
  }

  async remove(id) {
    await this.db.prepare('DELETE FROM punches WHERE id = ?').bind(id).run();
  }

  async getPresence(userId) {
    const r = await this.db
      .prepare('SELECT in_voice, left_at, version FROM presence WHERE user_id = ?')
      .bind(userId)
      .first();
    return r && { inVoice: r.in_voice === 1, leftAt: r.left_at, version: r.version };
  }

  // 読んだときから誰も書き換えていなければ保存して true を返す
  async savePresence(userId, { inVoice, leftAt }, expectedVersion) {
    const stmt = expectedVersion === null
      ? this.db
        .prepare('INSERT INTO presence (user_id, in_voice, left_at, version) VALUES (?, ?, ?, 1) ON CONFLICT (user_id) DO NOTHING')
        .bind(userId, inVoice ? 1 : 0, leftAt)
      : this.db
        .prepare('UPDATE presence SET in_voice = ?, left_at = ?, version = version + 1 WHERE user_id = ? AND version = ?')
        .bind(inVoice ? 1 : 0, leftAt, userId, expectedVersion);
    const { meta } = await stmt.run();
    return meta.changes === 1;
  }
}
