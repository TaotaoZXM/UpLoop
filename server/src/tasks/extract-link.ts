/**
 * Turn a pasted webpage URL into structured event drafts for conversational
 * task creation.
 *
 * Official-account (mp.weixin.qq.com) and Xiaohongshu/Rednote pages often
 * require a login, app, or anti-bot check, so fetching them from the server
 * may return an empty or blocked page. In that case we tell the user in
 * Chinese and let them paste the text or continue with a normal sentence.
 * We only fetch public http(s) URLs, never internal/localhost/metadata
 * addresses, and we cap time and size.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { Router } from "express";
import { isIP } from "node:net";
import { asyncRoute } from "../http.js";
import { authUser } from "../auth/session.js";
import { HttpError } from "../errors.js";
import { env } from "../env.js";
import { assertCanCall, recordUsage } from "../usage/quota.js";
import { deepseekChat, LlmError, type ChatMessage } from "../wellness/logic/llm.js";
import type { AppDeps } from "../types.js";

export const EXTRACT_FETCH_MS = 8000;
export const EXTRACT_MAX_BYTES = 512 * 1024;
export const EXTRACT_MAX_TEXT = 12000;
export const EXTRACT_MAX_EVENTS = 8;
export const EXTRACT_MAX_REDIRECTS = 3;

const URL_RE = /https?:\/\/[^\s<>"'）】)\]}>，。；、]+/gi;
const PRIORITY = new Set(["urgent-important", "important", "urgent", "other"]);
const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "ip6-localhost",
  "ip6-loopback",
]);

export type ExtractedEvent = {
  title: string;
  date: string;
  time: string;
  scene: "life" | "work" | "";
  priority: string;
  project: string;
  repeat: boolean | null;
  repeatDays: number;
  review: boolean | null;
  steps: string[];
  confidence: "high" | "low";
  summary: string;
};

export type LookupFn = (host: string) => Promise<Array<{ address: string; family: number }>>;
export type FetchFn = typeof fetch;

export function extractHttpUrls(text: string): string[] {
  const found: string[] = [];
  const input = String(text || "");
  for (const raw of input.match(URL_RE) || []) {
    const cleaned = raw.replace(/[.,;:!?，。；：！？)、】》]+$/g, "");
    if (cleaned && !found.includes(cleaned)) found.push(cleaned);
  }
  return found;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inCidr(ip: string, base: string, bits: number): boolean {
  const a = ipv4ToInt(ip), b = ipv4ToInt(base);
  if (a == null || b == null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

export function isPrivateOrLocalAddress(address: string): boolean {
  let ip = String(address || "").trim().toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (ip === "::1" || ip === "::" || ip === "0:0:0:0:0:0:0:1") return true;
  if (ip.includes(":")) {
    // Unique-local, link-local, multicast, IPv4-mapped already handled.
    if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80") || ip.startsWith("ff")) return true;
    return false;
  }
  if (inCidr(ip, "0.0.0.0", 8)) return true;
  if (inCidr(ip, "10.0.0.0", 8)) return true;
  if (inCidr(ip, "127.0.0.0", 8)) return true;
  if (inCidr(ip, "169.254.0.0", 16)) return true;
  if (inCidr(ip, "172.16.0.0", 12)) return true;
  if (inCidr(ip, "192.168.0.0", 16)) return true;
  if (inCidr(ip, "100.64.0.0", 10)) return true;
  if (inCidr(ip, "224.0.0.0", 4)) return true;
  return false;
}

export function isBlockedHostname(host: string): boolean {
  const hostname = String(host || "").trim().toLowerCase().replace(/\.$/, "");
  if (!hostname) return true;
  if (BLOCKED_HOSTS.has(hostname)) return true;
  if (hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
  const ipType = isIP(hostname);
  if (ipType === 4 || ipType === 6) return isPrivateOrLocalAddress(hostname);
  return false;
}

export async function assertPublicHttpUrl(raw: string, lookup: LookupFn = defaultLookup): Promise<URL> {
  let url: URL;
  try {
    url = new URL(String(raw || "").trim());
  } catch {
    throw new HttpError(400, "bad_url", "这不是一个有效的网页链接。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "bad_url", "只支持 http 或 https 的公开网页链接。");
  }
  if (url.username || url.password) {
    throw new HttpError(400, "bad_url", "不能打开带账号信息的链接。");
  }
  if (url.href.length > 2000) {
    throw new HttpError(400, "bad_url", "这个链接太长了。");
  }
  if (isBlockedHostname(url.hostname)) {
    throw new HttpError(400, "blocked_url", "不能打开内网或本机地址，请粘贴公开网页链接。");
  }
  const addresses = await lookup(url.hostname);
  if (!addresses.length || addresses.some((row) => isPrivateOrLocalAddress(row.address))) {
    throw new HttpError(400, "blocked_url", "不能打开内网或本机地址，请粘贴公开网页链接。");
  }
  return url;
}

async function defaultLookup(host: string): Promise<Array<{ address: string; family: number }>> {
  const result = await dnsLookup(host, { all: true });
  return result.map((row) => ({ address: row.address, family: row.family }));
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

export function htmlToText(html: string): { title: string; text: string } {
  const raw = String(html || "");
  const withoutDanger = raw
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ");
  const pick = (re: RegExp) => {
    const m = withoutDanger.match(re);
    return m ? decodeEntities(m[1].replace(/\s+/g, " ").trim()) : "";
  };
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i)
    || pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i)
    || pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["'][^>]*>/i);
  const description = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i)
    || pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  const text = decodeEntities(
    withoutDanger
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h1|h2|h3|li|tr|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  );
  const combined = [title, description, text].filter(Boolean).join("\n");
  return { title: title.slice(0, 200), text: combined.slice(0, EXTRACT_MAX_TEXT) };
}

const BLOCKED_PAGE_HINT = /验证|安全验证|请登录|掃碼|扫码登录|请在微信|打开小红书|open in (the )?app|captcha|access denied/i;

export function looksBlockedOrEmpty(title: string, text: string, status: number): string | null {
  if (status === 401 || status === 403) {
    return "这个页面需要登录，或限制了抓取（公众号、小红书常常这样）。你可以把活动文字贴过来，或用一句话告诉我要做什么。";
  }
  const compact = `${title}\n${text}`.replace(/\s+/g, " ").trim();
  if (!compact || compact.length < 40) {
    return "没能读到页面里的活动内容。公众号和小红书常常需要登录或打开 App。你可以把文字贴过来，或用一句话告诉我要做什么。";
  }
  if (BLOCKED_PAGE_HINT.test(compact) && compact.length < 400) {
    return "这个页面像是登录或验证页，没能读到活动信息。你可以把文字贴过来，或用一句话告诉我要做什么。";
  }
  return null;
}

export async function fetchPublicPage(
  rawUrl: string,
  deps: { fetchImpl?: FetchFn; lookup?: LookupFn } = {},
): Promise<{ url: string; status: number; title: string; text: string }> {
  const fetchImpl = deps.fetchImpl || fetch;
  let current = await assertPublicHttpUrl(rawUrl, deps.lookup);
  let status = 0;
  let body = "";
  for (let hop = 0; hop <= EXTRACT_MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await fetchImpl(current.href, {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
          "User-Agent": "Mozilla/5.0 (compatible; TaskEventExtract/1.0)",
        },
        signal: AbortSignal.timeout(EXTRACT_FETCH_MS),
      });
    } catch {
      throw new HttpError(504, "fetch_timeout", "打开链接超时了。你可以把活动文字贴过来，或用一句话告诉我要做什么。");
    }
    status = response.status;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.get("location");
      if (!location) throw new HttpError(502, "fetch_failed", "这个链接没有返回有效页面。你可以把活动文字贴过来，或用一句话告诉我要做什么。");
      const next = new URL(location, current);
      current = await assertPublicHttpUrl(next.href, deps.lookup);
      continue;
    }
    const type = String(response.headers.get("content-type") || "").toLowerCase();
    if (type && !/text\/html|application\/xhtml|text\/plain|application\/xml|text\/xml|application\/json/.test(type)) {
      throw new HttpError(422, "unsupported_page", "这个链接不是可阅读的网页。你可以把活动文字贴过来，或用一句话告诉我要做什么。");
    }
    const length = Number(response.headers.get("content-length") || 0);
    if (length > EXTRACT_MAX_BYTES) {
      throw new HttpError(413, "too_large", "这个页面太大，没能完整读取。你可以把活动文字贴过来，或用一句话告诉我要做什么。");
    }
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > EXTRACT_MAX_BYTES) {
      throw new HttpError(413, "too_large", "这个页面太大，没能完整读取。你可以把活动文字贴过来，或用一句话告诉我要做什么。");
    }
    body = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    break;
  }
  if (!body && ![200, 203].includes(status)) {
    const blocked = looksBlockedOrEmpty("", "", status);
    throw new HttpError(422, "fetch_failed", blocked || "打不开这个链接。你可以把活动文字贴过来，或用一句话告诉我要做什么。");
  }
  const parsed = htmlToText(body);
  const blocked = looksBlockedOrEmpty(parsed.title, parsed.text, status);
  if (blocked) throw new HttpError(422, "blocked_page", blocked);
  return { url: current.href, status, title: parsed.title, text: parsed.text };
}

function clip(value: unknown, max: number): string {
  return Array.from(String(value ?? "").trim()).slice(0, max).join("");
}

function validDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return "";
  return value;
}

function validTime(value: string): string {
  const m = String(value || "").trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return "";
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function asSteps(extra: string[], listed: unknown): string[] {
  const out: string[] = [];
  const add = (item: unknown) => {
    const text = clip(item, 30);
    if (text && !out.includes(text)) out.push(text);
  };
  extra.forEach(add);
  if (Array.isArray(listed)) listed.forEach(add);
  return out.slice(0, 12);
}

export function mapExtractedEvent(raw: unknown): ExtractedEvent | null {
  const row = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
  const title = clip(row.title || row.name, 80);
  if (!title) return null;
  const scene = row.scene === "work" || row.scene === "life" ? row.scene : "";
  const priority = typeof row.priority === "string" && PRIORITY.has(row.priority) ? row.priority : "";
  const extra = [
    clip(row.location, 30) ? `到场：${clip(row.location, 24)}` : "",
    clip(row.signup, 30) ? `报名：${clip(row.signup, 24)}` : "",
    clip(row.organizer, 30) ? `主办：${clip(row.organizer, 24)}` : "",
  ].filter(Boolean);
  const repeat = row.repeat === true ? true : row.repeat === false ? false : null;
  let repeatDays = 0;
  if (repeat === true) {
    const n = Number(row.repeatDays);
    repeatDays = Number.isInteger(n) && n >= 1 && n <= 365 ? n : 7;
  }
  const review = row.review === true ? true : row.review === false ? false : null;
  const summary = clip(row.summary || row.description, 160);
  return {
    title,
    date: validDate(String(row.date || "")),
    time: validTime(String(row.time || row.deadlineTime || "")),
    scene,
    priority,
    project: clip(row.project, 40),
    repeat,
    repeatDays,
    review,
    steps: asSteps(extra, row.steps),
    confidence: row.confidence === "low" ? "low" : "high",
    summary,
  };
}

export function mapExtractedEvents(raw: unknown): ExtractedEvent[] {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === "object" && Array.isArray((raw as { events?: unknown }).events) ? (raw as { events: unknown[] }).events : []);
  const events: ExtractedEvent[] = [];
  for (const item of list) {
    const mapped = mapExtractedEvent(item);
    if (mapped) events.push(mapped);
    if (events.length >= EXTRACT_MAX_EVENTS) break;
  }
  return events;
}

export const EXTRACT_LINK_RULES = `你从用户粘贴的网页正文里提取「活动 / 事件 / 待办」，供任务应用使用。只依据正文，不编造未出现的时间、地点、主办方或报名方式。

今天日期在输入的 today 字段（上海时区）。日期用 YYYY-MM-DD，时间用 HH:MM（24小时制）。scene 只能是 life 或 work，看不准就留空，禁止使用 rest 或其他值。priority 仅在正文明确优先级时填写 urgent-important、important、urgent、other 之一，否则留空。project、repeat、review 同样看不准就留空或 null，不要猜测。

把地点、主办、报名方式分别放进 location、organizer、signup，必要时再写进 steps。多个彼此独立的活动就拆成多条；同一活动的多场次若信息不足可只保留最近一场。没有活动就返回空数组。

只输出 JSON，不要解释或 Markdown：
{"events":[{"title":"活动或任务名","date":"","time":"","scene":"","priority":"","project":"","repeat":null,"repeatDays":0,"review":null,"location":"","organizer":"","signup":"","steps":[],"summary":"一句话摘要","confidence":"high"}]}`;

function parseModelJson(text: string): unknown {
  const json = String(text || "").replace(/^\s*```(?:json)?\s*/, "").replace(/\s*```\s*$/, "").trim();
  return JSON.parse(json);
}

export async function extractEventsFromPage(input: {
  url: string;
  note?: string;
  today: string;
  title: string;
  text: string;
  chat?: typeof deepseekChat;
  onUsage: Parameters<typeof deepseekChat>[0]["onUsage"];
}): Promise<ExtractedEvent[]> {
  const note = clip(String(input.note || "").replace(URL_RE, " ").replace(/\s+/g, " "), 500);
  const user = JSON.stringify({ url: input.url, today: input.today, note, pageTitle: input.title, pageText: input.text });
  const messages: ChatMessage[] = [
    { role: "system", content: EXTRACT_LINK_RULES },
    { role: "user", content: user },
  ];
  const chat = input.chat || deepseekChat;
  let last = "";
  let reason = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    last = await chat({
      messages,
      kind: "task_link_extract",
      maxTokens: 2000,
      onTool: () => "",
      onUsage: input.onUsage,
    });
    try {
      const events = mapExtractedEvents(parseModelJson(last));
      if (!events.length) throw new Error("empty");
      return events;
    } catch (error) {
      reason = error instanceof Error ? error.message : "invalid";
      messages.push(
        { role: "assistant", content: last },
        { role: "user", content: "请只返回合法 JSON，events 为数组。没有活动就返回 {\"events\":[]}。title 必填。" },
      );
    }
  }
  if (reason === "empty") return [];
  throw new HttpError(502, "invalid_extract", "没能整理出可用的活动信息。你可以把文字贴过来，或用一句话告诉我要做什么。");
}

export function createExtractLinkRouter(deps: AppDeps, hooks: { fetchImpl?: FetchFn; lookup?: LookupFn; chat?: typeof deepseekChat } = {}) {
  const router = Router();
  router.post("/tasks/extract-link", asyncRoute(async (req, res) => {
    const userId = authUser(req).id;
    const text = String(req.body?.note || req.body?.text || req.body?.url || "").trim();
    const listed = extractHttpUrls(text);
    const rawUrl = String(req.body?.url || listed[0] || "").trim();
    if (!rawUrl) throw new HttpError(400, "bad_url", "请先粘贴一个 http 或 https 网页链接。");
    if (!env.deepseekKey) throw new HttpError(503, "ai_unconfigured", "还没有配置 AI，暂时不能从链接整理活动。你可以把文字贴过来，或用一句话告诉我要做什么。");
    const profile = await deps.db.one<{ cloud_consent: boolean }>("SELECT * FROM user_profile WHERE user_id = $1 LIMIT 1", [userId]);
    if (!profile?.cloud_consent) throw new HttpError(403, "cloud_consent", "请先在账户设置中同意云端 AI 处理");
    const page = await fetchPublicPage(rawUrl, { fetchImpl: hooks.fetchImpl, lookup: hooks.lookup });
    await assertCanCall(deps.db, userId);
    try {
      const events = await extractEventsFromPage({
        url: page.url,
        note: text,
        today: new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }),
        title: page.title,
        text: page.text,
        chat: hooks.chat,
        onUsage: (usage, kind, status) => recordUsage(deps.db, userId, kind, usage, status),
      });
      if (!events.length) {
        throw new HttpError(422, "no_events", "没能从这篇网页里辨认出活动信息。你可以把内容贴过来，或用一句话告诉我要做什么。");
      }
      return res.json({ events, source: "ai" });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof LlmError) throw new HttpError(error.status || 502, "ai_failed", error.message || "模型没有回应，你可以把文字贴过来，或用一句话告诉我要做什么。");
      throw error;
    }
  }));
  return router;
}
