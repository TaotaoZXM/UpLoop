/**
 * WP3.1: knowledge-base interval / confidence rules live in ONE place.
 * PRD §5.KB principle 3: numbers carry a source, a unit basis and confidence;
 * prefer a range over a point value. Table hits are narrow, model estimates wide.
 */
export type IntervalKind = "table" | "table_portion" | "model" | "missing";

export const KB_RANGES: Record<IntervalKind, { spread: number; confidence: number }> = {
  table: { spread: 0.05, confidence: 0.9 },
  table_portion: { spread: 0.15, confidence: 0.75 },
  model: { spread: 0.35, confidence: 0.5 },
  missing: { spread: 0, confidence: 0 },
};

export type Interval = { kcal_low: number; kcal_high: number; confidence: number };

export function intervalFor(kind: IntervalKind, kcal: number): Interval {
  const rule = KB_RANGES[kind];
  if (!rule.spread || kcal <= 0) {
    return { kcal_low: kcal, kcal_high: kcal, confidence: rule.confidence };
  }
  return {
    kcal_low: Math.max(0, Math.round(kcal * (1 - rule.spread))),
    kcal_high: Math.round(kcal * (1 + rule.spread)),
    confidence: rule.confidence,
  };
}

/**
 * Personal correction factor is bounded to 0.5-2.0 and updated gradually until
 * three confirmations (knowledge-base design doc §8.1).
 */
export function blendedFactor(current: number, observed: number, confirmations: number) {
  const bounded = Math.min(2, Math.max(0.5, observed));
  const weight = Math.min(0.5, 0.15 + confirmations * 0.1);
  return Math.round(Math.min(2, Math.max(0.5, current * (1 - weight) + bounded * weight)) * 100) / 100;
}
