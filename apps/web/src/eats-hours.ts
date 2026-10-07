// 「吃喝」页的营业状态判定(2026-10-05,`PLAN-20261005205733`)。
//
// ★ 为什么要有这一层:`hours` 是原表(腾讯文档《BIFF吃喝》)的**自由文本**,写法五花八门 ——
//   `11:00-21:00` / `17:30-2:30`(跨午夜) / `24小时营业` / `周二-周日11:00-21:00`(限星期) /
//   `8:00-21:30 · （周五周六休息）` / `12:00-23:00（10/6休息）`(定日休) /
//   `11:00-21:00 · 15:00-17:00休息 · 20:00LAST ORDER`(午休 + 最后点单) /
//   `周一到周五08:00-19:00 · 周末09:00 ~ 19:00`(一天内两段日程)。
//   页面要「只看现在开着的」,就得把这几种都认出来。
//
// ★ 判定口径(用户 2026-10-05 裁决):**按釜山时间算,且只在能确定开着时才说「营业中」** ——
//   认不出来的写法一律 `unknown`,宁可不显示也不编结论(与 `EatsPage.tsx` 原有注释同一立场)。
//   所以调用方看到 `unknown` **不该**当作「开着」,也不该当作「打烊」。
//
// ★ 为什么不用 `Intl` + `timeZone: "Asia/Seoul"`:韩国自 1988 年起不实行夏令时,KST 恒为 UTC+9,
//   手算偏移比依赖 ICU 时区数据更可预测(也免掉单测环境里 ICU 版本差异的坑)。
//
// ⚠ 本模块是**纯函数**,import 期不碰 DOM / localStorage(单测跑在 node 环境)。

export type OpenState = "open" | "closed" | "unknown";

interface KstParts {
  /** 0 = 周日 … 6 = 周六 */
  weekday: number;
  /** 当天 0 点起的分钟数 */
  minutes: number;
  month: number;
  day: number;
}

/** 一个时间区间。**跨午夜时 `end` 已 +1440**(如 `17:30-2:30` → 1050…1590)。 */
interface OpenWindow {
  /** `null` = 每天都适用;否则只在集合内的星期生效(按**开始那天**算)。 */
  days: Set<number> | null;
  start: number;
  end: number;
}

interface Schedule {
  /** `24小时营业` */
  always: boolean;
  /** 营业窗口(已剔除午休) */
  windows: OpenWindow[];
  /** 午休等中途休息 —— 落在里面算打烊 */
  breaks: OpenWindow[];
  /** 整日闭店的星期 */
  closedDays: Set<number>;
  /** 条款里出现「节假日」→ 公休日无法离线枚举,只能回 `unknown` */
  holidayRisk: boolean;
  /** `M/D休息` 的定日闭店 */
  dateClosures: Array<[number, number]>;
  /** 有没归类掉的 `休息` / 语法认不出来 → 整条 `unknown` */
  unresolved: boolean;
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MINUTES_PER_DAY = 24 * 60;

const WEEKDAY_CHAR: Record<string, number> = { 日: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

/** `H:MM[-~—–至到]H:MM`。`24:00` 也吃(算成 1440,即当天结束)。 */
const RANGE_SOURCE = "(\\d{1,2}):(\\d{2})\\s*(?:-|~|—|–|至|到)\\s*(\\d{1,2}):(\\d{2})";

/** `M/D休息` */
const DATE_CLOSURE = /(\d{1,2})\s*\/\s*(\d{1,2})\s*休息/g;

function kstParts(now: Date): KstParts {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS);
  return {
    weekday: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function minutesOf(hour: string, minute: string): number {
  return Number(hour) * 60 + Number(minute);
}

/** 全角冒号 / 波浪号 / 括号先归一 ——括号里装的正是「周日休息」这类条款。 */
function normalize(hours: string): string {
  return hours
    .replace(/：/g, ":")
    .replace(/[～〜]/g, "~")
    .replace(/[（(]/g, " ")
    .replace(/[）)]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** `周X` → `周Y` 的展开(含两端)。`周二-周日` → [2,3,4,5,6,0]。 */
function expandWeekdays(from: number, to: number): number[] {
  const days: number[] = [];
  for (let step = 0; step < 7; step += 1) {
    const day = (from + step) % 7;
    days.push(day);
    if (day === to) return days;
  }
  return [from];
}

/** 把文本里的星期限定抽干净,剩下的交给调用方判断是不是「休息」条款。 */
function extractWeekdays(text: string): { days: number[]; rest: string; holiday: boolean } {
  const days: number[] = [];
  // 顺序要紧:`周X到周Y` 必须先于 `周末` 与单个 `周X` 被吃掉
  let rest = text.replace(
    /周\s*([一二三四五六日])\s*(?:到|至|-|~|—|–)\s*周?\s*([一二三四五六日])/g,
    (_all, from: string, to: string) => {
      days.push(...expandWeekdays(WEEKDAY_CHAR[from], WEEKDAY_CHAR[to]));
      return " ";
    },
  );
  rest = rest.replace(/周末/g, () => {
    days.push(0, 6);
    return " ";
  });
  rest = rest.replace(/周\s*([一二三四五六日])/g, (_all, day: string) => {
    days.push(WEEKDAY_CHAR[day]);
    return " ";
  });
  const holiday = rest.includes("节假日");
  rest = rest.replace(/节假日/g, " ");
  return { days, rest, holiday };
}

function parseSegment(raw: string): Schedule {
  const schedule: Schedule = {
    always: false,
    windows: [],
    breaks: [],
    closedDays: new Set(),
    holidayRisk: false,
    dateClosures: [],
    unresolved: false,
  };

  // 逐个扫区间:紧跟 `休息` 的是午休,其余是营业窗口。顺手把已消费的文本抠掉,
  // 剩下的只可能是「星期限定 / 整日闭店条款 / LAST ORDER 这类说明」。
  const ranges: Array<{ start: number; end: number; isBreak: boolean }> = [];
  let leftover = "";
  let cursor = 0;
  const scanner = new RegExp(RANGE_SOURCE, "g");
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(raw)) !== null) {
    leftover += raw.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const after = raw.slice(cursor);
    const isBreak = /^\s*休息/.test(after);
    if (isBreak) cursor += after.indexOf("休息") + 2;
    ranges.push({
      start: minutesOf(match[1], match[2]),
      end: minutesOf(match[3], match[4]),
      isBreak,
    });
  }
  leftover += raw.slice(cursor);

  // 定日闭店:`10/6休息`。先抽掉,免得剩下的 `休息` 被当成认不出来。
  leftover = leftover.replace(DATE_CLOSURE, (_all, month: string, day: string) => {
    schedule.dateClosures.push([Number(month), Number(day)]);
    return " ";
  });

  const { days, rest, holiday } = extractWeekdays(leftover);
  const stripped = rest.replace(/\s+/g, "");
  if (stripped.includes("休息")) {
    // 条款只剩 `休息` 且给出了星期 → 整日闭店;只有「节假日休息」则没法判断
    if (stripped === "休息" && days.length > 0) {
      for (const day of days) schedule.closedDays.add(day);
      schedule.holidayRisk = holiday;
    } else if (stripped === "休息" && holiday) {
      schedule.holidayRisk = true;
    } else {
      schedule.unresolved = true;
    }
  }
  // 剩下的非空文本(如 `LAST ORDER`)是说明不是日程,不算认不出来

  const selector = days.length > 0 && !stripped.includes("休息") ? new Set(days) : null;
  for (const range of ranges) {
    // 跨午夜(`17:30-2:30`、`11:00-4:00`)→ 结束推到次日
    const end = range.end <= range.start ? range.end + MINUTES_PER_DAY : range.end;
    const window: OpenWindow = { days: selector, start: range.start, end };
    if (range.isBreak) schedule.breaks.push(window);
    else schedule.windows.push(window);
  }
  return schedule;
}

function parseHours(hours: string): Schedule {
  const text = normalize(hours);
  const merged: Schedule = {
    always: /24\s*小时营业/.test(text),
    windows: [],
    breaks: [],
    closedDays: new Set(),
    holidayRisk: false,
    dateClosures: [],
    unresolved: false,
  };
  if (!text) return merged;
  // `·` 分段(`11:00-21:00 · 15:00-17:00休息 · 20:00LAST ORDER`),每段各判各的
  for (const segment of text.split(/[·・|]/)) {
    const part = parseSegment(segment);
    merged.windows.push(...part.windows);
    merged.breaks.push(...part.breaks);
    for (const day of part.closedDays) merged.closedDays.add(day);
    merged.holidayRisk ||= part.holidayRisk;
    merged.dateClosures.push(...part.dateClosures);
    merged.unresolved ||= part.unresolved;
  }
  return merged;
}

/** 某个窗口在「第 `day` 天的第 `minutes` 分钟」是否覆盖此刻。
 *  ⚠ 参数名刻意不叫 `window` —— 那会盖住全局 `window`,读的人容易以为自己看错了。 */
function covers(slot: OpenWindow, day: number, minutes: number): boolean {
  if (slot.days && !slot.days.has(day)) return false;
  return minutes >= slot.start && minutes < slot.end;
}

/** 釜山时间的 `HH:MM` —— 页面要写「以哪一刻为准」,别让它自己再算一次 UTC+9。 */
export function kstClock(now: Date): string {
  const { minutes } = kstParts(now);
  const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
  const minute = String(minutes % 60).padStart(2, "0");
  return `${hour}:${minute}`;
}

/**
 * 这家店「此刻」是不是开着。`now` 是绝对时刻,内部换算成釜山时间。
 *
 * @returns `open` 确定营业中;`closed` 确定打烊 / 休息;`unknown` 没法判断(没写营业时间,
 *   或写法认不出来,或条款含「节假日」)。
 */
export function openStateAt(hours: string, now: Date): OpenState {
  const schedule = parseHours(hours);
  // 任何一处认不出来就整条 `unknown` —— 保守优先于「猜一个开着」
  if (schedule.unresolved) return "unknown";

  const kst = kstParts(now);
  if (schedule.dateClosures.some(([month, day]) => month === kst.month && day === kst.day)) return "closed";
  if (schedule.always) return "open";
  if (schedule.closedDays.has(kst.weekday)) return "closed";
  // 周末已被上一条挡掉;工作日撞上「节假日」只能不下结论
  if (schedule.holidayRisk) return "unknown";
  if (schedule.windows.length === 0) return "unknown";

  // 跨午夜的窗口属于**开始那天**,所以昨天的窗口要拿「今天 + 24h」再判一次
  const isCovered = (slot: OpenWindow) =>
    covers(slot, kst.weekday, kst.minutes) ||
    covers(slot, (kst.weekday + 6) % 7, kst.minutes + MINUTES_PER_DAY);

  if (!schedule.windows.some(isCovered)) return "closed";
  if (schedule.breaks.some(isCovered)) return "closed";
  return "open";
}
