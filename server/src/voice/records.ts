import { createHash, randomUUID } from "node:crypto";
import { env } from "../env.js";
import { HttpError } from "../errors.js";
import { json, readJson, type Db, type Executor } from "../db/pool.js";
import { deepseekChat } from "../wellness/logic/llm.js";
import { assertCanCall, recordUsage, recordMetric } from "../usage/quota.js";
import { handleChat, type ChatResponse } from "../chat/router.js";
import { wellnessGate } from "../wellness/chat.js";
import { saveMessage } from "../wellness/repo.js";
import { todayShanghai } from "../wellness/logic/time.js";

export type VoiceCommand = { text: string; day: string; action: "record" | "complete_task" | "done"; title?: string; deadline?: string };
export type Interpretation = { commands: VoiceCommand[]; clarification: string };
const TOOL = { type: "function" as const, function: {
  name: "prepare_records", description: "忠实解析普通话、英语、粤语记录，不执行写入。",
  parameters: { type: "object", properties: {
    clarification: { type: "string", description: "缺少金额/数量/时间或无法判断是否要记录时，提出澄清问题，不猜测。" },
    commands: { type: "array", maxItems: 8, items: { type: "object", properties: {
      text: { type: "string", description: "单项标准中文记录指令。金额、计量用阿拉伯数字。任务新建必须用 加任务：标题；支出用 花了32元 午饭；收入用 工资到账8000元。不得编造热量、体重或消耗。" },
      day: { type: "string", description: "该记录日期 YYYY-MM-DD；任务新建日期为今天，未来时间放deadline。" },
      action: { type: "string", enum: ["record", "complete_task", "done"] },
      title: { type: "string", description: "完成已有任务或明确补记Done的标题，保留用户原意。" },
      deadline: { type: "string", description: "仅任务新建的明确截止时间，ISO 8601 带 +08:00；未提供则空字符串。" },
    }, required: ["text", "day", "action"] } },
  }, required: ["commands", "clarification"] },
} };

export function validateInterpretation(raw: Record<string, unknown>): Interpretation {
  const clarification = typeof raw.clarification === "string" ? raw.clarification.slice(0, 500) : "";
  if (!Array.isArray(raw.commands) || raw.commands.length > 8) throw new HttpError(502, "voice_understanding", "这句话没有理解清楚，请修改文字后重试");
  const commands = raw.commands.map((item: unknown) => {
    const c = item as VoiceCommand;
    if (!c || typeof c.text !== "string" || !c.text.trim() || c.text.length > 1000 ||
      !["record", "complete_task", "done"].includes(c.action) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(c.day) || Number.isNaN(Date.parse(c.day)) || new Date(c.day).toISOString().slice(0, 10) !== c.day ||
      (c.action !== "record" && (typeof c.title !== "string" || !c.title.trim() || c.title.length > 80)) ||
      (c.deadline && (!/\+08:00$/.test(c.deadline) || Number.isNaN(Date.parse(c.deadline))))) {
      throw new HttpError(502, "voice_understanding", "识别内容缺少明确的记录信息，请修改后重试");
    }
    return c;
  });
  return { commands: clarification ? [] : commands, clarification: clarification || (!commands.length ? "想记下什么？可以补充任务内容、数量或金额。" : "") };
}

export async function interpret(db: Db, userId: string, text: string): Promise<Interpretation> {
  if (!env.deepseekKey) throw new HttpError(503, "voice_model_unconfigured", "服务器尚未配置语音记录理解服务，请联系管理员");
  await assertCanCall(db, userId);
  let parsed: Interpretation | undefined;
  await deepseekChat({ kind: "voice_understanding", tools: [TOOL], toolChoice: { type: "function", function: { name: "prepare_records" } },
    messages: [
      { role: "system", content: `你是Task记录解析器。今天是${todayShanghai()}，时区Asia/Shanghai。只调用prepare_records一次，不给咨询建议。
输入可能为普通话、English、粤语或混说。忠实翻译成标准中文单项记录。所有中文/英文数字转阿拉伯数字。蚊=元、三十二蚊五=32.5元。数量/币种/日期不可猜测，缺失则commands=[]并clarification追问。只接受人民币收支，其他币种询问人民币金额，不当作元。
涵盖任务新建、完成已有任务、明确补记Done、运动、饮食、喝水、入睡起床/睡眠时长、收入支出。Routine日常勾选用record text="routine 标题"，沿用已有记录链路。每项独立command，同类多项也拆分。不能将食物克重变金额或将金钱变水量。食物不编造未给出的克重或热量，可保留一碗/一杯。运动消耗由现有工具算。
任务新建 text=加任务：标题，title保留标题，deadline仅在明确时填写。完成已有任务action=complete_task，补记已完成action=done；不可把无匹配的完成当新待办。title不含“我完成了”等前缀。完成的日期写day。
“我睡了/我醒了”保留该指令，跨夜睡眠转换成明确时钟对（23:00睡07:00醒），day取醒来日。明确时长可用“睡了8小时”。
医疗、紧急症状或专业咨询应翻译成中文原意单独record，让现有拒答系统处理；不得改写成健康记录。不是记录请求则clarification询问。` },
      { role: "user", content: text },
    ], onUsage: (usage, kind, status) => recordUsage(db, userId, kind, usage, status),
    onTool: (name, args) => { if (name === "prepare_records" && !parsed) parsed = validateInterpretation(args); return "已解析，请停止。"; },
  });
  if (!parsed) throw new HttpError(502, "voice_understanding", "没有理解到记录内容，请修改文字后重试");
  return parsed;
}

function scopedDb(executor: Executor): Db {
  return { ...executor,
    one: async <T>(sql: string, params: Parameters<Executor["query"]>[1] = []) => (await executor.query<T>(sql, params)).rows[0],
    rows: async <T>(sql: string, params: Parameters<Executor["query"]>[1] = []) => (await executor.query<T>(sql, params)).rows,
    tx: async fn => fn(executor), end: async () => {},
  };
}

async function completeTask(db: Db, userId: string, command: VoiceCommand): Promise<ChatResponse> {
  const row = await db.one<{ state: unknown }>("SELECT state FROM user_app_state WHERE user_id = $1 FOR UPDATE", [userId]);
  const state = readJson<Record<string, unknown>>(row?.state, { version: 1, todo: [], done: [], ideas: [], feedback: [], projects: [] });
  const todo = (Array.isArray(state.todo) ? state.todo : []) as Array<Record<string, unknown>>;
  const matches = todo.filter(task => String(task.title).trim() === command.title?.trim());
  if (command.action === "complete_task" && matches.length !== 1) {
    return { reply: matches.length > 1 ? "找到多条同名任务，请在 UpLoop 中选择要完成的那条。" : `没有找到「${command.title}」。如果是补记，请说「补记完成：${command.title}」。`, cards: [], intent: "clarify", day: command.day };
  }
  const task = (command.action === "complete_task" ? matches[0] : undefined) || { id: randomUUID(), title: command.title, difficulty: "easy", project: "未分类" };
  if (command.action === "complete_task" && task.plan) {
    const plan = task.plan as {stages?: Array<{steps?: Array<{done?: boolean; title?: string}>}>};
    const current = (plan.stages || []).flatMap(stage => stage.steps || []).find(step => !step.done);
    if (current) return { reply: `「${command.title}」还有当前一步「${current.title}」，请在任务清单完成；全部步骤做完后父任务会自动完成。`, cards: [], intent: "task", day: command.day };
  }
  const done = Array.isArray(state.done) ? state.done : [];
  const next = { ...state, todo: command.action === "complete_task" ? todo.filter(t => t.id !== task.id) : todo,
    done: [...done, { ...task, completed: command.day === todayShanghai() ? Date.now() : Date.parse(`${command.day}T12:00:00+08:00`), reviewNote: "" }] };
  await db.query(`INSERT INTO user_app_state (user_id, state, updated_at) VALUES ($1,$2::jsonb,date_trunc('milliseconds',now()))
    ON CONFLICT (user_id) DO UPDATE SET state=EXCLUDED.state, updated_at=EXCLUDED.updated_at`, [userId, json(next)]);
  return { reply: `完成了「${command.title}」。`, cards: [{ type: "task", text: command.title }], intent: "task", day: command.day };
}

/** One transaction covers all record writes and the idempotency receipt. Failed
 * batches roll back; duplicate submissions return the committed receipt. */
export async function recordConfirmed(db: Db, userId: string, requestId: string, text: string,
  prepare: typeof interpret = interpret, messageSource = "voice") {
  const hash = createHash("sha256").update(text).digest("hex");
  const existing = await db.one<{ input_hash: string; result: unknown }>("SELECT input_hash, result FROM voice_requests WHERE user_id=$1 AND request_id=$2", [userId, requestId]);
  const check = (receipt: { input_hash: string; result: unknown }) => {
    if (receipt.input_hash !== hash) throw new HttpError(409, "voice_request_conflict", "内容已改变，请重新发送");
    return readJson<ChatResponse>(receipt.result, { reply: "正在处理，请稍后重试", cards: [], intent: "pending", day: todayShanghai() });
  };
  if (existing) return check(existing);
  const gate = wellnessGate(text);
  const plan = gate ? { commands: [{ text, day: todayShanghai(), action: "record" as const }], clarification: "" } : await prepare(db, userId, text);
  // Medical/refusal must win even in a mixed-language/multi-record utterance.
  const gatedCommand = plan.commands.find(c => wellnessGate(c.text));
  if (gatedCommand) plan.commands = [gatedCommand];
  return db.tx(async tx => {
    const scoped = scopedDb(tx);
    const inserted = await scoped.one(`INSERT INTO voice_requests (user_id,request_id,input_hash) VALUES ($1,$2,$3)
      ON CONFLICT DO NOTHING RETURNING request_id`, [userId, requestId, hash]);
    if (!inserted) {
      const receipt = await scoped.one<{ input_hash: string; result: unknown }>("SELECT input_hash,result FROM voice_requests WHERE user_id=$1 AND request_id=$2", [userId, requestId]);
      if (!receipt) throw new HttpError(409, "voice_retry", "记录状态正在更新，请重试");
      return check(receipt);
    }
    // Serialise task mutations for this account, including an initially empty state.
    await scoped.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
    await scoped.query("SELECT user_id FROM user_app_state WHERE user_id=$1 FOR UPDATE", [userId]);
    const results: ChatResponse[] = [];
    for (const command of plan.commands) {
      const result = command.action === "record"
        ? await handleChat({ db: scoped }, { userId, text: command.text, day: command.day, source: messageSource, persistMessages: false })
        : await completeTask(scoped, userId, command);
      results.push(result);
      if (command.action !== "record") {
        await recordMetric(scoped, userId, "voice_task", { action: command.action, recorded: result.cards.length > 0 });
      }
      // Attach an explicit deadline to the task just created by handleChat.
      if (command.deadline && result.intent === "task" && result.cards.length && command.action === "record") {
        const row = await scoped.one<{ state: unknown }>("SELECT state FROM user_app_state WHERE user_id=$1 FOR UPDATE", [userId]);
        const state = readJson<Record<string, unknown>>(row?.state, {});
        const todo = state.todo as Array<Record<string, unknown>> | undefined;
        if (todo?.length) {
          todo[todo.length - 1].deadline = command.deadline;
          await scoped.query("UPDATE user_app_state SET state=$1::jsonb, updated_at=date_trunc('milliseconds',now()) WHERE user_id=$2", [json(state), userId]);
        }
      }
    }
    const response: ChatResponse = { reply: plan.clarification || results.map(r => r.reply).join("\n\n"),
      cards: results.flatMap(r => r.cards), intent: results.map(r => r.intent).join("+") || "clarify", day: todayShanghai() };
    // Save the utterance the user actually typed/spoke once, not the internal
    // translated commands. A single assistant message contains the batch result.
    await saveMessage(scoped, userId, "user", text, response.day, { source: messageSource, requestId });
    await saveMessage(scoped, userId, "assistant", response.reply, response.day,
      { source: messageSource, requestId, intent: response.intent, cards: response.cards });
    await scoped.query("UPDATE voice_requests SET result=$1::jsonb WHERE user_id=$2 AND request_id=$3", [json(response), userId, requestId]);
    return response;
  });
}
