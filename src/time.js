// Workers の Date は常に UTC なので、日付の区切りと表示は Intl でタイムゾーンに変換する。

const formatters = new Map();
let formatter = getFormatter('Asia/Tokyo');

function getFormatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }));
  }
  return formatters.get(timeZone);
}

export function setTimeZone(timeZone) {
  formatter = getFormatter(timeZone);
}

// { year, month(1-12), day, hour, minute, second, weekday(0=日) }
export function localParts(ts) {
  const p = {};
  for (const { type, value } of formatter.formatToParts(ts)) {
    if (type !== 'literal') p[type] = Number(value);
  }
  p.weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return p;
}

function offsetAt(ts) {
  const p = localParts(ts);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}

// タイムゾーンでの日時をタイムスタンプにする
export function fromLocal(year, month, day, hour = 0, minute = 0) {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const guess = asUtc - offsetAt(asUtc);
  return asUtc - offsetAt(guess); // 夏時間の切り替わりに合わせてもう一度補正する
}
