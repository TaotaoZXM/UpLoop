import { env } from "../../env.js";
import { isPeak } from "./pricing.js";

export type TokenUsage = {
  prompt: number;
  completion: number;
  cached: number;
  miss: number;
  peak: boolean;
};

export type ChatMessage = {
  role: string;
  content: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
  reasoning_content?: string | null;
};

type ToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export class LlmError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readUsage(raw: Record<string, unknown> | undefined, at: Date): TokenUsage {
  const usage = raw || {};
  const prompt = Number(usage.prompt_tokens || 0);
  const completion = Number(usage.completion_tokens || 0);
  const details = (usage.prompt_tokens_details || {}) as { cached_tokens?: number };
  let cached = Number(usage.prompt_cache_hit_tokens ?? details.cached_tokens ?? 0);
  let miss = Number(usage.prompt_cache_miss_tokens ?? 0);
  if (cached + miss === 0) miss = prompt;
  if (cached + miss > prompt && prompt > 0 && !usage.prompt_cache_miss_tokens) {
    miss = Math.max(prompt - cached, 0);
  }
  return { prompt, completion, cached, miss, peak: isPeak(at) };
}

export async function deepseekChat(input: {
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: unknown;
  kind: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  onUsage: (usage: TokenUsage, kind: string, status: "ok" | "error" | "timeout") => void | Promise<void>;
  onTool: (name: string, args: Record<string, unknown>) => string;
}) {
  if (!env.deepseekKey) throw new LlmError(503, "服务器没有配置 DEEPSEEK_API_KEY");
  const fetchImpl = input.fetchImpl || fetch;
  const messages = [...input.messages];
  let final = "";
  for (let round = 0; round < 3; round += 1) {
    const at = new Date();
    let response: Response;
    try {
      response = await fetchImpl(`${env.deepseekBase}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.deepseekKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: env.deepseekModel,
          messages,
          tools: input.tools,
          tool_choice: input.toolChoice,
          thinking: { type: "disabled" },
          max_tokens: input.maxTokens ?? 800,
        }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      await input.onUsage({ prompt: 0, completion: 0, cached: 0, miss: 0, peak: isPeak(at) }, input.kind, "timeout");
      if (round === 0) continue;
      throw new LlmError(504, "模型超时，这句话没有记上");
    }
    const json = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
      usage?: Record<string, unknown>;
      choices?: Array<{ message?: ChatMessage & { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
    };
    if (!response.ok) {
      await input.onUsage(readUsage(json.usage, at), input.kind, "error");
      if (round === 0 && [429, 500, 502, 503].includes(response.status)) continue;
      const message = response.status === 401 ? "DEEPSEEK_API_KEY 无效" : "模型没有回应，这句话没有记上";
      throw new LlmError(response.status === 401 ? 502 : 502, message);
    }
    await input.onUsage(readUsage(json.usage, at), input.kind, "ok");
    const message = json.choices?.[0]?.message;
    if (!message) throw new LlmError(502, "模型没有返回内容");
    const calls = message.tool_calls || [];
    if (!calls.length) {
      final = message.content || "";
      break;
    }
    messages.push({
      role: "assistant",
      content: message.content || "",
      tool_calls: calls,
      reasoning_content: message.reasoning_content || undefined,
    });
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      const result = input.onTool(call.function.name, args);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
    input.toolChoice = undefined;
  }
  return final;
}

// WP2.4: SEARCH_TOOL removed — consult paths are closed and knowledge.ts is not migrated.
export const PARSE_TOOL = {
  type: "function" as const,
  function: {
    name: "parse_foods",
    description: "把饮食描述拆成食材名和克重。不要填写热量。",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              grams: { type: "number" },
              portion_hint: { type: "string" },
            },
            required: ["name", "grams"],
          },
        },
      },
      required: ["items"],
    },
  },
};
