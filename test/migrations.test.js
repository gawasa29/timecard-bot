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

test('presence の in_voice を state に移行する', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(sql('0001_init.sql'));
  db.exec(`
    INSERT INTO presence (user_id, in_voice, left_at, version) VALUES
      ('u1', 1, NULL, 3),
      ('u2', 0, 1234, 5)
  `);
  db.exec(sql('0003_presence_state.sql'));
  assert.deepEqual(
    db.prepare('SELECT user_id, state, left_at, version FROM presence ORDER BY user_id').all().map((r) => ({ ...r })),
    [
      { user_id: 'u1', state: 'work', left_at: null, version: 3 },
      { user_id: 'u2', state: 'none', left_at: 1234, version: 5 },
    ],
  );
});
