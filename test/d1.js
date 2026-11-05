// テスト用: node:sqlite を D1 と同じ形で使えるようにする
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

const migrations = new URL('../migrations/', import.meta.url);

export function createD1() {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      const bound = (args) => ({
        bind: (...values) => bound(values),
        all: async () => ({ results: stmt.all(...args) }),
        first: async () => stmt.get(...args) ?? null,
        run: async () => {
          const r = stmt.run(...args);
          return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
        },
      });
      return bound([]);
    },
  };
}
