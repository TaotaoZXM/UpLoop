const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

export type ShanghaiParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
  ymd: string;
  ym: string;
};

export function shanghaiParts(date = new Date()): ShanghaiParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const bag: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") bag[p.type] = p.value;
  }
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const year = Number(bag.year);
  const month = Number(bag.month);
  const day = Number(bag.day);
  const ymd = `${bag.year}-${bag.month}-${bag.day}`;
  return {
    year,
    month,
    day,
    hour: Number(bag.hour),
    minute: Number(bag.minute),
    weekday: weekdayMap[bag.weekday] ?? 0,
    ymd,
    ym: `${bag.year}-${bag.month}`,
  };
}

export function todayShanghai(date = new Date()) {
  return shanghaiParts(date).ymd;
}

export function monthShanghai(date = new Date()) {
  return shanghaiParts(date).ym;
}

export function addDays(ymd: string, n: number) {
  const [y, m, d] = ymd.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() + n);
  return utc.toISOString().slice(0, 10);
}

export function weekdayIndex(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function weekdayLabel(ymd: string) {
  return WEEK[weekdayIndex(ymd)];
}

export function prettyDay(ymd: string) {
  const [y, m, d] = ymd.split("-");
  return `${Number(y)}年${Number(m)}月${Number(d)}日`;
}

export function shortDay(ymd: string) {
  const [, m, d] = ymd.split("-");
  return `${Number(m)}月${Number(d)}日`;
}

export function isYmd(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function nowIso() {
  return new Date().toISOString();
}
