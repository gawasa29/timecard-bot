-- 散歩を無くす。記録済みの散歩は休憩に置き換え、実働から引く時間は変えない。
UPDATE punches SET type = 'break_start' WHERE type = 'walk_start';
UPDATE punches SET type = 'break_end' WHERE type = 'walk_end';
