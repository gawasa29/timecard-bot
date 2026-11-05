-- 前回の確認でいた VC を、勤務扱いかどうか（in_voice）ではなく種類（state）で持つ。
-- work: 勤務として数える VC / other: それ以外の VC / none: VC の外
CREATE TABLE presence_new (
  user_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  left_at INTEGER,
  version INTEGER NOT NULL
);

-- それまでの「勤務 VC にいたか」から移行する。other は次の確認で入る
INSERT INTO presence_new (user_id, state, left_at, version)
  SELECT user_id, CASE WHEN in_voice = 1 THEN 'work' ELSE 'none' END, left_at, version
  FROM presence;

DROP TABLE presence;
ALTER TABLE presence_new RENAME TO presence;
