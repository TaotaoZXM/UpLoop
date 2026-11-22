/* Sentence reading for the AI assistant: one spoken or typed sentence -> title, date, time, scene.
   Pure helpers only; the conversation UI lives in assistant.js. */
(function () {
  "use strict";
  const B = (window.Task = window.Task || {});
  const esc = value => (B.escape ? B.escape(String(value ?? "")) : String(value ?? ""));
  const pad = n => String(n).padStart(2, "0");
  const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const fromKey = key => { const [y, m, d] = String(key).split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const clone = value => JSON.parse(JSON.stringify(value));
  const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
  const SCENES = { work: "工作", life: "生活" };
  const dayText = key => { const d = fromKey(key); return (d.getMonth() + 1) + "月" + d.getDate() + "日"; };
  const dayLong = key => dayText(key) + " 周" + WEEK[fromKey(key).getDay()];
  const minutesText = m => m >= 240 ? "半天" : m >= 60 ? (m % 60 ? Math.floor(m / 60) + " 小时 " + (m % 60) + " 分" : m / 60 + " 小时") : m + " 分钟";
  // A single step of 240 min reads as 半天; a total must stay exact (330 min is 5 小时 30 分, not 半天).
  const totalText = m => m >= 60 ? Math.floor(m / 60) + " 小时" + (m % 60 ? " " + (m % 60) + " 分" : "") : m + " 分钟";

  /* ---------- reading the sentence (pure, unit-tested) ---------- */
  const CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const num = s => {
    if (/^\d+$/.test(s)) return Number(s);
    if (s === "十") return 10;
    if (s.length === 1) return CN[s];
    if (s[0] === "十") return 10 + CN[s[1]];
    if (s[1] === "十") return CN[s[0]] * 10 + (s[2] ? CN[s[2]] : 0);
    return NaN;
  };
  const validDate = (y, m, d) => { const t = new Date(y, m - 1, d); return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d; };
  const NUM = "(\\d{1,2}|[零〇一二两三四五六七八九十]{1,3})";
  const TAIL = "(?:之前|以前|前|之内|以内|内|截止|截至)?";
  const DAY_WORDS = { 大后天: 3, 后天: 2, 明天: 1, 明日: 1, 明早: 1, 明晚: 1, 明晨: 1, 今天: 0, 今日: 0, 今晚: 0, 今早: 0, 今晨: 0 };
  const WD = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 };
  const addMonths = (d, n) => { const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate(); return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last)); };

  /** Finds one date phrase. Returns { date: Date|null, rest } where rest is the sentence without that phrase. */
  function readDate(source, now) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monday = addDays(today, -((today.getDay() + 6) % 7)), sunday = addDays(monday, 6);
    const rules = [
      // 2027年1月3日, 11月20日, 十一月二十号
      [new RegExp("(?:在|于)?(?:(\\d{4})年)?" + NUM + "月" + NUM + "[日号]" + TAIL), m => {
        const month = num(m[2]), day = num(m[3]); let year = m[1] ? Number(m[1]) : today.getFullYear();
        if (!validDate(year, month, day)) return null;
        let d = new Date(year, month - 1, day);
        if (!m[1] && d < today) { year += 1; if (!validDate(year, month, day)) return null; d = new Date(year, month - 1, day); }
        return d;
      }],
      // 3天后, 两周后, 一个月后
      [new RegExp("(?:在|于)?" + NUM + "(?:个)?(天|日|周|星期|礼拜|月)后"), m => {
        const n = num(m[1]); if (!(n >= 0)) return null;
        return m[2] === "月" ? addMonths(today, n) : addDays(today, /天|日/.test(m[2]) ? n : n * 7);
      }],
      [/(大后天|后天|明天|明日|明早|明晚|明晨|今天|今日|今晚|今早|今晨)(?:之前|以前|前|之内|以内|内|截止|截至)?/, m => addDays(today, DAY_WORDS[m[1]])],
      // 周五, 下周三, 这个周日; "每周一" is a repeat rule, not a deadline
      [new RegExp("(每)?(下下|下|这个?|本)?(?:周|星期|礼拜)([一二三四五六日天])" + TAIL), m => {
        if (m[1]) return null;
        let d = addDays(monday, WD[m[3]]);
        if (m[2] === "下下") d = addDays(d, 14); else if (m[2] === "下") d = addDays(d, 7); else if (d < today) d = addDays(d, 7);
        return d;
      }],
      [new RegExp("(下个?)?(?:这个?|本)?周末" + TAIL), m => m[1] ? addDays(sunday, 7) : sunday],
      // "下周去办签证", "本周内": the end of that week. "周报" and "本周报告" are not matched.
      [new RegExp("(下个?|本|这个?)(?:周|星期|礼拜)(?=[内前之完交做去办发开写整买约到要，,、。\\s]|$)" + TAIL), m => m[1][0] === "下" ? addDays(sunday, 7) : sunday],
      // 月底, 下个月底, 11月底
      [new RegExp("(?:" + NUM + "月|(下个月|下月|本月|这个月|这月))[底末]" + TAIL), m => {
        if (m[2]) return new Date(today.getFullYear(), today.getMonth() + (/^下/.test(m[2]) ? 2 : 1), 0);
        const month = num(m[1]); if (!(month >= 1 && month <= 12)) return null;
        return new Date(today.getFullYear() + (month < today.getMonth() + 1 ? 1 : 0), month, 0);
      }],
      [new RegExp("月[底末]" + TAIL), () => new Date(today.getFullYear(), today.getMonth() + 1, 0)],
      // 20号前; "3号线" is a subway line
      [new RegExp("(?<![月\\d零〇一二两三四五六七八九十])(?:在|于)?" + NUM + "[日号](?![楼线院区层门])" + TAIL), m => {
        const day = num(m[1]); if (!(day >= 1 && day <= 31)) return null;
        const d = new Date(today.getFullYear(), today.getMonth() + (day < today.getDate() ? 1 : 0), day);
        return d.getDate() === day ? d : null;
      }]
    ];
    for (const [pattern, resolve] of rules) {
      const m = pattern.exec(source); if (!m) continue;
      const date = resolve(m); if (!date) continue;
      return { date, rest: source.slice(0, m.index) + " " + source.slice(m.index + m[0].length) };
    }
    return { date: null, rest: source };
  }

  const clock = (period, hour, minute) => {
    if (!(hour >= 0 && hour <= 24) || !(minute >= 0 && minute <= 59)) return "";
    if (/下午|傍晚|晚/.test(period || "") && hour < 12) hour += 12;
    else if (period === "中午" && hour < 11) hour += 12;
    else if (period === "凌晨" && hour === 12) hour = 0;
    else if (!period && hour >= 1 && hour <= 6) hour += 12; // "三点开会" means 15:00
    return hour > 23 ? "" : pad(hour) + ":" + pad(minute);
  };
  const PERIOD = "(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|晚间)?";
  /** Finds one clock time such as 下午三点半, 8:30, 晚上8点20分. */
  function readTime(source, hint) {
    const colon = new RegExp(PERIOD + "(\\d{1,2})[:：](\\d{2})" + TAIL).exec(source);
    if (colon) { const time = clock(colon[1] || hint, Number(colon[2]), Number(colon[3])); if (time) return { time, rest: source.slice(0, colon.index) + " " + source.slice(colon.index + colon[0].length) }; }
    const word = new RegExp(PERIOD + NUM + "点钟?(半|整|(\\d{1,2})分?)?" + TAIL).exec(source);
    if (word) {
      const hour = num(word[2]), minute = word[3] === "半" ? 30 : word[4] ? Number(word[4]) : 0;
      // "多睡一点" is not one o'clock, and "第三点" is not 15:00
      const vague = (!word[1] && !hint && hour === 1 && !word[3]) || source[word.index - 1] === "第";
      const time = vague ? "" : clock(word[1] || hint, hour, minute);
      if (time) return { time, rest: source.slice(0, word.index) + " " + source.slice(word.index + word[0].length) };
    }
    return { time: "", rest: source };
  }
  const SCENE_WORDS = {
    work: /客户|会议|开会|周报|月报|季报|日报|汇报|报告|报价|合同|发票|简历|面试|项目|方案|需求|评审|上线|代码|PPT|文档|老板|同事|领导|公司|工作|出差|预算|财报|审批|招聘|复盘|述职|排期|对接/gi,
    life: /旅行|旅游|度假|买|快递|打扫|做饭|家务|妈妈|爸爸|父母|孩子|医院|体检|缴费|水电|房租|签证|健身|跑步|洗衣|整理房间|搬家|收拾|超市|吃饭|驾照|银行|宠物|遛狗/g
  };
  /** The scene whose keywords appear most often; "" when nothing matches or two scenes tie. */
  function readScene(text) {
    const scores = Object.entries(SCENE_WORDS).map(([key, pattern]) => [key, (String(text).match(pattern) || []).length]).sort((a, b) => b[1] - a[1]);
    return scores[0][1] > 0 && scores[0][1] > scores[1][1] ? scores[0][0] : "";
  }
  // Spoken lead-ins only. Real verbs such as 准备 / 整理 stay in the title.
  const FILLER = /^[，,、；;：:。.！!\s]*(?:我(?:一定要|必须要|必须|需要|打算|准备|想要|想|要|得)|一定要|必须要|必须|需要|想要|要|得|请帮我|帮我|麻烦|提醒我|记得|别忘了|别忘记|记着)+/;
  const tidy = value => {
    const s = String(value).replace(/\s+/g, " ").trim().replace(FILLER, "").replace(/^[，,、；;：:。.！!\s]+/, "").replace(/[，,、；;。.！!\s]+$/, "");
    return Array.from(s).slice(0, 80).join("");
  };
  /** One spoken or typed sentence -> { title, date: "YYYY-MM-DD"|"", time: "HH:MM"|"", scenario: "work"|"life"|"" }. */
  function read(text, now) {
    now = now || new Date();
    const original = String(text || "").replace(/\s+/g, " ").trim();
    const when = readDate(original, now);
    // 今晚 / 明早 are dates, but they also say which half of the day a bare "8点" means.
    const hint = /[今明]晚/.test(original) ? "晚上" : /[今明][早晨]/.test(original) ? "早上" : "";
    const at = readTime(when.rest, hint);
    let date = when.date ? ymd(when.date) : "";
    if (at.time && !date) {
      const [h, m] = at.time.split(":").map(Number), t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
      date = ymd(t > now ? t : addDays(t, 1));
    }
    const rest = tidy(at.rest);
    return { title: Array.from(rest).length >= 2 ? rest : tidy(original), date, time: at.time, scenario: readScene(original) };
  }
  /** Last day to start so the remaining work (4h of effort per day) plus waiting still fits before the deadline. */
  function latestStart(plan, deadline) {
    if (!deadline) return "";
    const open = stepsOf(plan).filter(step => !step.done);
    const minutes = open.reduce((sum, step) => sum + step.minutes, 0), waiting = open.reduce((sum, step) => sum + (step.waitDays || 0), 0);
    return ymd(addDays(fromKey(deadline), -(Math.max(0, Math.ceil(minutes / 240) - 1) + waiting)));
  }
  const stepsOf = plan => (plan?.stages || []).flatMap(stage => stage.steps || []);
  /* ---------- choices offered by the assistant ---------- */
  const hm = d => pad(d.getHours()) + ":" + pad(d.getMinutes());
  const dayName = d => "周" + WEEK[d.getDay()] + " " + dayText(ymd(d));
  /** Quick day choices. "future": 今天 / 明天 / 本周日 / 下周日. "past": 今天 / 昨天 / 前天. Each key appears once. */
  function dateOptions(now, kind) {
    const base = now || new Date(), t = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    if (kind === "past") return [["今天", t], ["昨天", addDays(t, -1)], ["前天", addDays(t, -2)]].map(([label, d]) => ({ key: ymd(d), label, sub: dayName(d) }));
    const sunday = addDays(t, (7 - t.getDay()) % 7), tomorrow = addDays(t, 1), list = [["今天", t], ["明天", tomorrow]];
    if (sunday > tomorrow) list.push(["本周日", sunday]);
    list.push(["下周日", addDays(sunday, 7)]);
    return list.map(([label, d]) => ({ key: ymd(d), label, sub: dayName(d) }));
  }
  /** Quick time-of-day choices for a day. Deadlines drop times already gone today; finished events drop times still ahead. */
  function timeOptions(key, now, kind) {
    const base = now || new Date(), isToday = key === ymd(base), here = hm(base);
    if (kind === "past") {
      const list = [["08:00", "早上"], ["12:00", "中午"], ["15:00", "下午"], ["18:00", "傍晚"], ["21:00", "晚上"]]
        .filter(([time]) => !isToday || time <= here).map(([time, sub]) => ({ key: time, label: time, sub }));
      return isToday ? [{ key: here, label: "刚刚", sub: here }, ...list] : list;
    }
    return [["10:00", "上午"], ["12:00", "中午"], ["15:00", "下午"], ["18:00", "下班前"], ["21:00", "晚上"], ["23:59", "当天结束"]]
      .filter(([time]) => !isToday || time > here).map(([time, sub]) => ({ key: time, label: time === "23:59" ? "23:59" : time, sub }));
  }
  /** "明天 周三 15:30" style text for a stored date/time pair. */
  function whenText(key, time, now) {
    if (!key) return "";
    const base = now || new Date(), diff = Math.round((fromKey(key) - new Date(base.getFullYear(), base.getMonth(), base.getDate())) / 864e5);
    const rel = { "-2": "前天", "-1": "昨天", 0: "今天", 1: "明天", 2: "后天" }[diff];
    return (rel || dayText(key)) + " 周" + WEEK[fromKey(key).getDay()] + (time ? " " + time : "");
  }
  // A single step of 240 min reads as 半天; a total must stay exact (330 min is 5 小时 30 分, not 半天).
  B.guide = { read, readScene, latestStart, dateOptions, timeOptions, whenText, totalText, minutesText, dayText, dayLong, stepsOf, SCENES, ymd, fromKey, addDays };
})();
