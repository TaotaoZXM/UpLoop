import { LI_PER_YUAN } from "../../env.js";
import { shanghaiParts } from "./time.js";

/**
 * DeepSeek Flash 官方人民币价（2026-09-10 起，见 api-docs.deepseek.com 定价页）。
 * 单位：元 / 百万 tokens。
 * 高峰：北京时间周一至周五（不含法定节假日）9:00–12:00、14:00–18:00。
 * 周末与节假日全天为空闲价。调休补班未逐日编码，可能少计高峰价，改价只改这里。
 */
export const PRICE_PER_MILLION = {
  off: { hit: 0.02, miss: 1, out: 4 },
  peak: { hit: 0.04, miss: 2, out: 8 },
} as const;

/** 2026 法定节假日近似表。以国务院当年通知为准，可直接改这个集合。 */
export const HOLIDAYS = new Set([
  "2026-01-01",
  "2026-01-02",
  "2026-02-15",
  "2026-02-16",
  "2026-02-17",
  "2026-02-18",
  "2026-02-19",
  "2026-02-20",
  "2026-02-21",
  "2026-02-22",
  "2026-02-23",
  "2026-04-04",
  "2026-04-05",
  "2026-04-06",
  "2026-05-01",
  "2026-05-02",
  "2026-05-03",
  "2026-05-04",
  "2026-05-05",
  "2026-06-19",
  "2026-06-20",
  "2026-06-21",
  "2026-09-25",
  "2026-09-26",
  "2026-09-27",
  "2026-10-01",
  "2026-10-02",
  "2026-10-03",
  "2026-10-04",
  "2026-10-05",
  "2026-10-06",
  "2026-10-07",
]);

export function isPeak(date = new Date()) {
  const p = shanghaiParts(date);
  if (p.weekday === 0 || p.weekday === 6) return false;
  if (HOLIDAYS.has(p.ymd)) return false;
  const mins = p.hour * 60 + p.minute;
  const morning = mins >= 9 * 60 && mins < 12 * 60;
  const afternoon = mins >= 14 * 60 && mins < 18 * 60;
  return morning || afternoon;
}

export function costLi(input: { cached: number; miss: number; completion: number; at?: Date }) {
  const rate = isPeak(input.at) ? PRICE_PER_MILLION.peak : PRICE_PER_MILLION.off;
  const yuan = (input.cached * rate.hit + input.miss * rate.miss + input.completion * rate.out) / 1_000_000;
  return Math.round(yuan * LI_PER_YUAN);
}

export function liToYuan(li: number) {
  return Math.round(li) / LI_PER_YUAN;
}
