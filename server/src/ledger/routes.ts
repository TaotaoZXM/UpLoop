/**
 * WP1.4 / M04-F1,F2: expenses split out of the 1 MB JSON document.
 * Money is stored as integer cents; the front end used to send a string "12.5".
 */
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { asyncRoute, dayOf } from "../http.js";
import { authUser } from "../auth/session.js";
import { HttpError } from "../errors.js";
import { nowMsIso, type Db, type SqlParam } from "../db/pool.js";
import { todayShanghai } from "../wellness/logic/time.js";
import type { AppDeps } from "../types.js";

/** Q7 recommendation: a small fixed set, product can change it later. */
export const EXPENSE_CATEGORIES = ["餐饮", "交通", "购物", "其他"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** User-added requirement: income is recorded in the same ledger flow. */
export const INCOME_CATEGORIES = ["工资", "兼职", "报销", "理财", "其他"] as const;
export const EXPENSE_KINDS = ["expense", "income"] as const;
export type ExpenseKind = (typeof EXPENSE_KINDS)[number];

export function normalizeKind(value: unknown): ExpenseKind {
  return value === "income" ? "income" : "expense";
}

export function normalizeCategoryFor(kind: ExpenseKind, value: unknown): string | null {
  const raw = String(value || "").trim();
  const allowed: readonly string[] = kind === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  return allowed.includes(raw) ? raw : null;
}

export function amountToCents(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) return null;
  const cents = Math.round(n * 100);
  return cents > 0 ? cents : null;
}

export function normalizeCategory(value: unknown): string | null {
  return normalizeCategoryFor("expense", value);
}

/** Assistant may infer a category, but the user confirms it (PRD M04-F1). */
export function inferCategory(note: string): string | null {
  if (/饭|吃|外卖|咖啡|奶茶|早餐|午餐|晚餐|餐厅|零食/.test(note)) return "餐饮";
  if (/打车|地铁|公交|高铁|机票|加油|停车|共享单车/.test(note)) return "交通";
  if (/买|购物|衣服|鞋|超市|快递|淘宝|京东/.test(note)) return "购物";
  return null;
}

export type ExpenseInput = {
  amount: unknown;
  note?: string;
  category?: string | null;
  kind?: string;
  spentAt?: string;
  source?: string;
  day?: string;
};

export async function createExpense(db: Db, userId: string, input: ExpenseInput) {
  const amountCents = amountToCents(input.amount);
  if (amountCents == null) throw new HttpError(400, "amount", "请填写有效金额");
  const note = String(input.note || "").trim().slice(0, 120);
  const kind = normalizeKind(input.kind);
  const category = normalizeCategoryFor(kind, input.category)
    || (kind === "expense" ? inferCategory(note) : null);
  const spentAt = input.spentAt && !Number.isNaN(new Date(input.spentAt).getTime())
    ? new Date(input.spentAt).toISOString()
    : nowMsIso();
  const day = input.day || todayShanghai(new Date(spentAt));
  const id = randomUUID();
  const rows = await db.rows<Record<string, unknown>>(
    `INSERT INTO expenses (id, user_id, amount_cents, kind, note, category, spent_at, day, source, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,now()) RETURNING *`,
    [id, userId, amountCents, kind, note, category, spentAt, day, input.source || "form"],
  );
  return expenseView(rows[0]);
}

function expenseView(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  const cents = Number(row.amount_cents || 0);
  return {
    id: String(row.id),
    amount: (cents / 100).toFixed(2),
    amountCents: cents,
    kind: normalizeKind(row.kind),
    note: String(row.note || ""),
    category: row.category == null ? null : String(row.category),
    spentAt: row.spent_at instanceof Date ? row.spent_at.toISOString() : String(row.spent_at),
    day: String(row.day).slice(0, 10),
    source: String(row.source || "form"),
  };
}

export function createLedgerRouter({ db }: AppDeps) {
  const router = Router();

  router.get(
    "/expenses",
    asyncRoute(async (req, res) => {
      const user = authUser(req);
      const day = dayOf(req.query.day);
      const rawCategory = String(req.query.category || "").trim();
      const category = rawCategory
        ? (normalizeCategoryFor("expense", rawCategory) || normalizeCategoryFor("income", rawCategory))
        : null;
      const params: SqlParam[] = [user.id, day];
      let sql = `SELECT * FROM expenses WHERE user_id = $1 AND day = $2 AND deleted_at IS NULL`;
      if (req.query.kind === "expense" || req.query.kind === "income") {
        params.push(normalizeKind(req.query.kind));
        sql += ` AND kind = $${params.length}`;
      }
      if (category) {
        params.push(category);
        sql += ` AND category = $${params.length}`;
      }
      sql += ` ORDER BY spent_at DESC, created_at DESC`;
      const rows = await db.rows<Record<string, unknown>>(sql, params);
      const items = rows.map((row) => expenseView(row)).filter(Boolean);
      const expenseCents = items.filter((item) => item?.kind !== "income")
        .reduce((sum, item) => sum + (item?.amountCents || 0), 0);
      const incomeCents = items.filter((item) => item?.kind === "income")
        .reduce((sum, item) => sum + (item?.amountCents || 0), 0);
      return res.json({
        day,
        category: category || null,
        categories: [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES],
        expenseCategories: EXPENSE_CATEGORIES,
        incomeCategories: INCOME_CATEGORIES,
        totalYuan: (expenseCents / 100).toFixed(2),
        incomeYuan: (incomeCents / 100).toFixed(2),
        items,
      });
    }),
  );

  router.post(
    "/expenses",
    asyncRoute(async (req, res) => {
      const body = (req.body || {}) as Record<string, unknown>;
      const expense = await createExpense(db, authUser(req).id, {
        amount: body.amount,
        note: String(body.note || ""),
        category: body.category == null ? null : String(body.category),
        kind: body.kind == null ? undefined : String(body.kind),
        spentAt: body.spentAt == null ? undefined : String(body.spentAt),
        source: "form",
      });
      return res.status(201).json({ expense });
    }),
  );

  router.delete(
    "/expenses/:id",
    asyncRoute(async (req, res) => {
      const result = await db.query(
        "UPDATE expenses SET deleted_at = now() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
        [req.params.id, authUser(req).id],
      );
      if (!result.rowCount) throw new HttpError(404, "not_found", "没有这笔开销");
      return res.json({ ok: true });
    }),
  );

  return router;
}
