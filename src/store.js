'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// 打刻を SQLite に保存する
class Store {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS punches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        ts INTEGER NOT NULL,
        source TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS punches_user_ts ON punches (user_id, ts);
    `);
    this.insertStmt = this.db.prepare('INSERT INTO punches (user_id, type, ts, source) VALUES (?, ?, ?, ?)');
    this.listStmt = this.db.prepare('SELECT id, user_id, type, ts, source FROM punches WHERE user_id = ? ORDER BY ts, id');
    this.deleteStmt = this.db.prepare('DELETE FROM punches WHERE id = ?');
    this.usersStmt = this.db.prepare('SELECT DISTINCT user_id FROM punches');
  }

  // source: voice（VC の入退室）/ button / command / reconcile（起動時の補正）
  add(userId, type, ts, source) {
    const { lastInsertRowid } = this.insertStmt.run(userId, type, ts, source);
    return { id: Number(lastInsertRowid), userId, type, ts, source };
  }

  list(userId) {
    return this.listStmt.all(userId).map((r) => ({ id: r.id, userId: r.user_id, type: r.type, ts: r.ts, source: r.source }));
  }

  // 最後に記録した打刻（時刻順ではなく記録順）
  lastAdded(userId) {
    const list = this.list(userId);
    return list.reduce((latest, p) => (latest === null || p.id > latest.id ? p : latest), null);
  }

  remove(id) {
    this.deleteStmt.run(id);
  }

  users() {
    return this.usersStmt.all().map((r) => r.user_id);
  }

  close() {
    this.db.close();
  }
}

module.exports = { Store };
