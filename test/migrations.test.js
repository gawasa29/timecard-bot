import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const sql = (name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

test('記録済みの散歩は休憩に移行する', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(sql('0001_init.sql'));
  db.exec(`
    INSERT INTO punches (user_id, type, ts, source) VALUES
      ('u', 'walk_start', 1000, 'button'),
      ('u', 'walk_end', 2000, 'button')
  `);
  db.exec(sql('0002_walk_to_break.sql'));
  assert.deepEqual(
    db.prepare('SELECT type FROM punches ORDER BY ts').all().map((r) => r.type),
    ['break_start', 'break_end'],
  );
});
