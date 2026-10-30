-- 打刻
CREATE TABLE punches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX punches_user_ts ON punches (user_id, ts);

-- 前回の確認で VC にいたか。left_at は勤務中に VC を抜けた時刻（猶予中だけ入る）
CREATE TABLE presence (
  user_id TEXT PRIMARY KEY,
  in_voice INTEGER NOT NULL,
  left_at INTEGER,
  version INTEGER NOT NULL
);
