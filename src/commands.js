// スラッシュコマンドの定義。scripts/setup.js で Discord に登録する。

import { TYPE_LABELS } from './shifts.js';

const STRING = 3;
const USER = 6;
const MANAGE_GUILD = String(1 << 5);

const userOption = { type: USER, name: 'user', description: '見る人（省略すると自分）' };
const monthOption = { type: STRING, name: 'month', description: 'YYYY-MM（省略すると今月）' };

export const COMMANDS = [
  {
    name: 'panel',
    description: '休憩・散歩ボタンのパネルをこのチャンネルに置く',
    default_member_permissions: MANAGE_GUILD,
  },
  { name: 'today', description: '今日の勤務状況を見る', options: [userOption] },
  { name: 'month', description: '月の勤務時間を見る', options: [monthOption, userOption] },
  { name: 'csv', description: '月の勤務記録を CSV で受け取る', options: [monthOption, userOption] },
  {
    name: 'add',
    description: '自分の打刻を手動で追加する（打刻し忘れたとき）',
    options: [
      {
        type: STRING,
        name: 'type',
        description: '種類',
        required: true,
        choices: Object.entries(TYPE_LABELS).map(([value, name]) => ({ name, value })),
      },
      { type: STRING, name: 'time', description: '時刻（例 09:30）', required: true },
      { type: STRING, name: 'date', description: '日付 YYYY-MM-DD（省略すると今日）' },
    ],
  },
  {
    name: 'addshift',
    description: '自分の勤務を出勤から退勤までまとめて追加する（勤務ごと記録し忘れたとき）',
    options: [
      { type: STRING, name: 'start', description: '出勤の時刻（例 09:00）', required: true },
      { type: STRING, name: 'end', description: '退勤の時刻（例 18:00。出勤より前なら翌日）', required: true },
      { type: STRING, name: 'date', description: '出勤した日 YYYY-MM-DD（省略すると今日）' },
    ],
  },
  { name: 'undo', description: '自分が最後に記録した打刻を取り消す' },
];
