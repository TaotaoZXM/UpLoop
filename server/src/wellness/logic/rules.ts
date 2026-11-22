/**
 * WP2.4: kept isEmergency / isMedical / medicalReply / isConsult / isRemovedAudio
 * and the fixed replies. Removed classifySupplement, isMinor, isTrainingPlan,
 * wantsCitation, SUPPLEMENT_REFUSE and DOCTOR_LINE (all had no callers in the
 * recording-only Wellness flow). answers.ts and knowledge.ts were not migrated.
 */
export const MEDICAL_REPLY = "抱歉我解答不了医疗问题";
export const EMERGENCY_LINE = "请尽快就医";
export const CONSULT_REPLY =
  "健康这边只做记录，不提供减脂、皮质醇或补剂咨询。\n要不要记一笔？可以说今天吃了什么、做了什么运动、喝了多少水，或「我睡了」「我醒了」。";
export const RECORD_ONLY_REPLY = "健康这边只做记录。直接说吃了什么、运动多久、喝了多少水，或「我睡了」「我醒了」。";
export const REMOVED_AUDIO_REPLY =
  "这里没有冥想、呼吸训练或助眠音乐。健康只记录睡眠时长，以及入睡和起床时间。要记的话，可以说「我睡了」或「我醒了」。";

const EMERGENCY = /胸痛|胸口|胸闷|晕倒|晕厥|大出血|昏迷|呼吸困难|喘不上气|心梗|中风|抽搐/;

export function isEmergency(text: string) {
  return EMERGENCY.test(text);
}

export function isMedical(text: string) {
  const t = text.replace(/\s+/g, "");
  if (/剧痛|刺痛|肿胀|肿了|持续不缓解/.test(t)) return true;
  if (/酸/.test(t) && !/剧痛|刺痛|肿胀|肿了|不缓解/.test(t) && !EMERGENCY.test(t)) {
    // 普通延迟性酸痛不拦。其余规则仍可能命中。
  } else if (/酸痛|很酸/.test(t) && !EMERGENCY.test(t)) {
    return false;
  }
  if (/我是不是|是不是得了|算不算.*(病|炎|癌)/.test(t)) return true;
  if (/皮质醇过高|库欣|甲减|甲亢/.test(t)) return true;
  if (/失眠很久|长期失眠|慢性失眠|失眠半年|失眠几个月|老是失眠|一直失眠|安眠药|吃安眠/.test(t)) return true;
  if (/在吃.{0,8}药|吃了.{0,8}药|停药|剂量|二甲双胍|降压药|抗凝|处方/.test(t)) return true;
  if (/化验|体检|尿酸|血糖\s*\d|肌酐|转氨酶|核磁|影像|化验单/.test(t)) return true;
  if (/术后|痛风|腰椎间盘|糖尿病|高血压|康复期/.test(t)) return true;
  if (/怀孕|孕期|哺乳|孕妇/.test(t)) return true;
  if (/抑郁症|焦虑症|暴食|催吐|厌食|进食障碍|想自杀|自残/.test(t)) return true;
  if (EMERGENCY.test(t)) return true;
  if (/疼|痛|晕|出血|心慌|心悸|头晕|发烧|发热/.test(t) && /怎么办|什么原因|怎么回事|严不严重|要不要紧|正常吗/.test(t)) {
    if (/酸/.test(t) && !/剧痛|刺痛|肿胀/.test(t)) return false;
    return true;
  }
  return false;
}

export function medicalReply(text: string) {
  if (isEmergency(text)) return `${MEDICAL_REPLY}\n${EMERGENCY_LINE}`;
  return MEDICAL_REPLY;
}

export function isRemovedAudio(text: string) {
  return /冥想|正念|呼吸训练|呼吸练习|助眠|睡眠音乐|白噪音|雨声/.test(text.replace(/\s+/g, ""));
}

export function isConsult(text: string) {
  const t = text.replace(/\s+/g, "");
  if (isRemovedAudio(t)) return false;
  if (/减脂|减肥|瘦身|怎么瘦|如何瘦|怎样瘦|瘦小腿|瘦腿|瘦手臂|瘦肚子|局部减脂|局部瘦|燃脂|怎么减/.test(t)) return true;
  if (/皮质醇|肾上腺疲劳/.test(t)) return true;
  if (/增肌|训练计划|课表|训练处方|一周.*组|每周.*组|练到力竭|蛋白质.*(每天|多少)|每天.*蛋白质|训练频率|大重量|轻重量|怎么练|如何练/.test(t)) return true;
  if (/补剂|保健品|肌酸|蛋白粉|乳清|咖啡因|褪黑素|褪黑激素|丙氨酸|左旋肉碱|肉碱|藤黄|共轭亚油酸|绿茶提取物/.test(t)) return true;
  if (/出处|依据|参考文献|哪篇|文献/.test(t)) return true;
  return false;
}
