// AI 排片 —— 浏览器**直连**用户自填的模型服务商(OpenAI 兼容 `/chat/completions`)。
//
// ★★ 隐私契约(动这个文件前先读)★★
//   API Key 只落 `localStorage["biff.ai.v1"]`,**永不进入任何发往本站 `/api/*` 的请求**。
//   本站没有、也不得新增任何 LLM 代理 endpoint —— 一旦有代理,「Key 不上服务器」这句承诺即为假。
//   请求 = `fetch(用户填的 baseURL + "/chat/completions")`,Key 只放 Authorization header;
//   不写进 URL query、不写进 body、不进 console、不落任何 DOM 属性。
//   UI 只显示掩码(见 `maskKey`)。
//
// 职责划分:本文件 = 隐藏主 Prompt + 打包 + 调用 + **输出校验**(纯逻辑,不碰 DOM);
//   UI 全部在 `library.ts::aiPanel`。

import type { Catalog, Priority, Screening } from "./types";
import { computeConflicts, type Slot } from "./conflict";
import { effEndMin, talkOnOf } from "./gv";
import { filmNodeKey, fmtEndClock, hmsToMin } from "./util";
import type { EngineFilm } from "./engine";

/* ================= 隐藏主 Prompt(界面不展示、不可编辑) =================
 * 设计取舍:① 只要 code,不要片名/时间 —— 幻觉面最小,前端按 code 反查权威数据;
 * ② 硬约束编号 C1–C6,便于模型自查,也便于把校验失败原因映射回具体条款;
 * ③ 跨午夜显式说明 —— 模型对「29:35」几乎必然理解错,故打包时已换成「次日 05:35」文本;
 * ④ 强制 dropped 带原因 —— 让 must 不静默消失,每部未排入的片都有可读理由;
 * ⑤ C6 把用户偏好里的「排除 / 时间限定」升为硬约束,并加「中文时间表达归一」——
 *   修「写了『下午五点开始看』却被排 16:00 场」的漏排:模型拿到『下午五点』『早上十点』
 *   『晚上七点』『上午不看』这类口语化写法时,必须先归一到 24h 数字(下午 = 12~17、
 *   晚上 = 18~23、上午 = 06~11),再按 C1–C6 判定;本地复检**不**做这一步
 *   (prompt 层归一是稳的最小路径;不要在本地解析自然语言偏好 —— NLU 复杂度远超收益)。
 *   (C5 的「优先选更早场次」只在**未被 C6 排除**的候选里生效,不得借它绕过 C6)。 */
const SYSTEM_PROMPT = [
  "你是电影节排片助手,为一位观众在硬约束下挑选场次。",
  "",
  "【输入】两条清单:",
  "1) films[]:{key(影片唯一标识), zh(中文名), orig(原始片名), priority(档位:must=必看 / maybe=备选 / wild=随缘), rating(豆瓣评分)}",
  "2) screenings[]:{code(场次唯一标识), film_key(所属影片的 key), date(YYYY-MM-DD), start(开始 HH:MM),",
  "   end(结束,可能写作「次日 05:35」= 跨午夜), venue(影厅代码), gv(该场是否含映后谈)}",
  "env:{transit_min(跨影厅转场缓冲分钟), gv_talk_min(映后谈时长), dates(本次只在这些日期内排片;screenings 已按此过滤)}",
  "",
  "【硬约束 —— 任何情况下不得违反】",
  "C1 每部影片最多选 1 场。",
  "C2 同一天内任意两场不得时间重叠;若两场影厅(venue)不同,前一场结束后必须再留出 transit_min 分钟转场。",
  "   标着「次日 HH:MM」的场次占用次日凌晨,与次日早晨的场次同样按此判定。",
  "C3 只能使用 screenings[] 里出现过的 code,禁止编造、禁止改写、禁止大小写变换。",
  "C4 优先级:must 尽力全覆盖(实在排不下才可放弃,并在 dropped 里说明原因);maybe 在硬约束内尽量多排;",
  "   wild 只在完全不影响 must/maybe 时才考虑。",
  "C5 同一部影片有多场可选时,优先选 gv=true 的场次;同为 GV 或同为非 GV 时,优先选时间更早的场次。",
  "C6 用户偏好里的「排除 / 时间限定」类要求,与 C1–C5 同等效力,任何情况下不得违反 —— 例如:",
  "   「17:00 才开始看」「X 点前结束」「上午不看片」「不接受午夜场」「只看某几家影院」「只看某几天」。",
  "   凡落在排除范围内的场次一律不得选入 picks,只能放进 dropped 并写明原因;",
  "   哪怕该片当天仅此一场、或它是 must,也不得破例 —— 宁可放弃它,也绝不排到用户明确排除的时段。",
  "",
  "【C6 时间窗口的归一与判定 —— 这是「下午五点开始看」被误读为「16:00 开始 OK」的根因,务必严守】",
  "  · 「X 点开始看 / X 点之后才开始 / X 点前不看」一律归一为「start ≥ X:00」;",
  "    start_time < X:00 的场次**严格排除**,不得借 C5 的「优先选更早」或「该片仅此一场」绕过。",
  "  · 「X 点前结束」= 该场 end ≤ X:00(若 end 跨午夜写成「次日 HH:MM」,先换算到当日分钟再比)。",
  "  · 「看到最后一场 / 排到当日最晚 / 看完当日」= 排到当日最晚 end(含跨午夜 end > 24:00 的场次),",
  "    不得因为「看完太晚」或「跨午夜」就保守缩范围;跨午夜场属于正常候选。",
  "  · 「上午不看 / 下午不看 / 晚上不看」按 06~11 / 12~17 / 18~23 排除对应时段场次。",
  "  · 「不要午夜场」= 22:00 ≤ start < 次日 06:00 的场次排除。",
  "  · 「只看某几家影院 / 某几天」= venue / date 不在白名单内的场次排除。",
  "",
  "【中文偏好写法对照(高频口语表达 → 正确语义)—— 拿到用户偏好后先按本表归一,再开始求解】",
  "  · 「下午 N 点开始看」= 「N+12 点开始看」(下午 = 12~17;「下午五点」= 17:00,不是 05:00);",
  "  · 「早上 / 上午 N 点」= 「N 点」(上午 = 06~11);「晚上 N 点」= 「N+12 点」(晚上 = 18~23);",
  "  · 「看到最后 / 看到最后一场 / 看到最晚 / 看完当日」= 排到当日(含跨午夜)最晚 end 的场次;",
  "  · 「排满 / 排到结束」= 范围够宽时**应当**贪心排满,不要只挑 1 场就停;",
  "  · 「不要午夜场」= 22:00 ≤ start < 次日 06:00 的场次排除;",
  "  · 「上午不看 / 下午不看」= 对应时段全排除;",
  "  · 「每部片优先选带 GV 的场」= 同片多场时 GV 场优于非 GV(与 C5 一致);",
  "  · 「集中在某几家影院 / 只看 BCC」= venue 不在该白名单的场次排除。",
  "",
  "【输出】只输出一个 JSON 对象,不要任何解释文字,不要 Markdown 代码围栏:",
  '{"plans":[{"title":"<方案名,不超过 14 字>","picks":["<code>", ...],"dropped":[{"key":"<影片 key>","why":"<不超过 20 字的放弃原因>"}],"note":"<不超过 60 字的策略说明>"}],"note":"<不超过 60 字的整体说明>"}',
  "plans = **1~3 个候选方案**(用户会自己挑一个,故必须按「最贴合用户优先级」→「次优取舍」从高到低排列):",
  "  · 方案一 = 最优先满足用户偏好与档位优先级(must > maybe > wild)的那一份;",
  "  · 若还存在明显不同的合理取舍(更紧凑 / 覆盖更多 must / 更少跨馆转场 / 结束更晚),再给方案二、方案三;",
  "  · 只有一种合理排法时给 1 个即可 —— 不要为凑数硬造雷同方案;",
  "  · 每个方案各自满足 C1–C6,picks 各自按日期与开始时间升序排列;可排场次为空则该方案 picks 为空数组。",
].join("\n");

/* ================= 配置:三件套全可配 + 预设 ================= */

export interface AiCfg {
  /** OpenAI 兼容 baseURL,末尾可带或不带 `/`(调用时统一去掉) */
  baseUrl: string;
  model: string;
  /** 用户的 API Key —— **只落本地 localStorage** */
  key: string;
  /** 用户自定义偏好(注入为独立的 user 消息,受硬约束守卫) */
  userPrompt: string;
}

export interface AiPreset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
}

/** 预设(仅预填 baseUrl/model,不预设 Key)。`custom` 留空供完全手填。 */
export const AI_PRESETS: AiPreset[] = [
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { id: "moonshot", label: "Moonshot(Kimi)", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { id: "siliconflow", label: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "deepseek-ai/DeepSeek-V3" },
  { id: "custom", label: "自定义", baseUrl: "", model: "" },
];

/** Key 独立一个 LS 键 —— 不并入 `biff.settings.v1`:① 「清除 Key」语义干净;② 不被设置序列化顺手带走。 */
const LS_AI = "biff.ai.v1";

export function defaultAiCfg(): AiCfg {
  return { baseUrl: AI_PRESETS[0].baseUrl, model: AI_PRESETS[0].model, key: "", userPrompt: "" };
}

export function loadAiCfg(): AiCfg {
  const base = defaultAiCfg();
  try {
    const raw = localStorage.getItem(LS_AI);
    if (!raw) return base;
    const o = JSON.parse(raw) as Partial<AiCfg>;
    return {
      baseUrl: typeof o.baseUrl === "string" ? o.baseUrl : base.baseUrl,
      model: typeof o.model === "string" ? o.model : base.model,
      key: typeof o.key === "string" ? o.key : "",
      userPrompt: typeof o.userPrompt === "string" ? o.userPrompt : "",
    };
  } catch {
    return base;
  }
}

export function saveAiCfg(c: AiCfg): void {
  try {
    localStorage.setItem(LS_AI, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

export function clearAiCfg(): void {
  try {
    localStorage.removeItem(LS_AI);
  } catch {
    /* ignore */
  }
}

/** AI 面板「排哪几天」的**上次选择** —— 独立 LS 键(与 cfg 一样只落本机,不上服务器)。
 *  首次无存档 → 返回空数组(UI 侧即「全不选」);存档里的日期已不存在(数据换版)由 UI 侧过滤。 */
const LS_AI_DATES = "biff.ai.dates.v1";

export function loadAiDates(): string[] {
  try {
    const raw = localStorage.getItem(LS_AI_DATES);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

export function saveAiDates(dates: Iterable<string>): void {
  try {
    localStorage.setItem(LS_AI_DATES, JSON.stringify([...dates]));
  } catch {
    /* ignore */
  }
}

/** 三件套齐了才算「已配置」 */
export function aiReady(c: AiCfg): boolean {
  return c.key.trim() !== "" && c.baseUrl.trim() !== "" && c.model.trim() !== "";
}

/** 掩码:`sk-abcdef…xyz9` → `sk-…xyz9`(短 key 只出圆点)。UI 只允许展示这个。 */
export function maskKey(k: string): string {
  const t = k.trim();
  if (!t) return "";
  if (t.length <= 8) return "•".repeat(t.length);
  return `${t.slice(0, 3)}…${t.slice(-4)}`;
}

/* ================= 打包(只送已定档影片,控 token) ================= */

/** 序列化上限 —— 超了按 wild → maybe 丢片,must 永不丢 */
const PAYLOAD_LIMIT = 120_000;

export interface AiPayloadFilm {
  key: string;
  zh: string;
  orig: string;
  priority: Priority;
  rating: number | null;
}

export interface AiPayloadShow {
  code: string;
  film_key: string;
  date: string;
  start: string;
  /** 显示口径(`fmtEndClock`):跨午夜印「次日 05:35」,绝不把 24+ 制的 "29:35" 丢给模型 */
  end: string;
  venue: string;
  gv: boolean;
}

export interface AiPayload {
  films: AiPayloadFilm[];
  screenings: AiPayloadShow[];
  env: { transit_min: number; gv_talk_min: number; dates: string[] };
  /** 因超长被丢弃的影片数(>0 时 UI 必须明示) */
  truncated: number;
}

function origOf(cat: Catalog, key: string): string {
  if (!key.startsWith("cat:")) return "";
  const id = key.slice(4);
  const f = cat.films.find((x) => x.id === id);
  return f ? f.title_orig : "";
}

const PRI_RANK: Record<Priority, number> = { must: 0, maybe: 1, wild: 2 };

/** 打包:入参 `films` 只应含**已定档**(priority ≠ null)的影片 —— 「未设档位」不参与排片。
 *  `dates` = **本次考虑并送给模型的日期**(面板上的日期范围选择)——场次按它过滤,
 *  所选日期内一场都没有的影片**整条不送**(送过去模型也排不了,白烧 token);
 *  `env.dates` 同步为所选日期,模型据此知道只需在这些天里排。
 *  默认由 UI 决定(2026-09-10 起为「**记住上次选择**」,见 PLAN-20260910162000),
 *  此处不再预设 —— `dates=[]` 是合法入参(调用前应自行守卫)。 */
export function buildPayload(
  films: EngineFilm[],
  cat: Catalog,
  transitMin: number,
  gvTalkMin: number,
  dates: string[]
): AiPayload {
  const ordered = [...films].sort((a, b) => PRI_RANK[a.priority] - PRI_RANK[b.priority]);
  const dateSet = new Set(dates);
  const filmsOut: AiPayloadFilm[] = [];
  const showsOut: AiPayloadShow[] = [];
  for (const f of ordered) {
    const inRange = f.shows.filter((s) => dateSet.has(s.date));
    if (inRange.length === 0) continue;
    filmsOut.push({ key: f.key, zh: f.zh, orig: origOf(cat, f.key), priority: f.priority, rating: f.rating });
    for (const s of inRange) {
      showsOut.push({
        code: s.code,
        film_key: f.key,
        date: s.date,
        start: s.start_time,
        end: fmtEndClock(effEndMin(s, talkOnOf(s.code))),
        venue: s.venue_id,
        gv: s.is_gv,
      });
    }
  }
  let truncated = 0;
  while (
    filmsOut.length > 0 &&
    JSON.stringify({ films: filmsOut, screenings: showsOut }).length > PAYLOAD_LIMIT
  ) {
    let idx = -1;
    for (let i = filmsOut.length - 1; i >= 0; i--) {
      if (filmsOut[i].priority !== "must") {
        idx = i;
        break;
      }
    }
    if (idx < 0) break; // 只剩 must → 宁可略微超长,也不丢必看
    const key = filmsOut[idx].key;
    filmsOut.splice(idx, 1);
    for (let i = showsOut.length - 1; i >= 0; i--) {
      if (showsOut[i].film_key === key) showsOut.splice(i, 1);
    }
    truncated++;
  }
  return {
    films: filmsOut,
    screenings: showsOut,
    env: { transit_min: transitMin, gv_talk_min: gvTalkMin, dates },
    truncated,
  };
}

/* ================= 调用 ================= */

export const AI_TIMEOUT_MS = 120_000;

export type AiErrorKind =
  | "aborted"
  | "timeout"
  | "cors"
  | "auth"
  | "forbidden"
  | "notfound"
  | "badrequest"
  | "ratelimit"
  | "server"
  | "empty"
  | "parse";

export class AiError extends Error {
  constructor(readonly kind: AiErrorKind, message: string) {
    super(message);
    this.name = "AiError";
  }
}

/** 错误 → 用户可读文案(六类失败路径各有说法,别都糊成「失败了」) */
export function aiErrorText(e: unknown): string {
  if (!(e instanceof AiError)) return "未知错误,请重试。";
  switch (e.kind) {
    case "aborted":
      return "已中断。";
    case "timeout":
      return `超过 ${Math.round(AI_TIMEOUT_MS / 1000)} 秒未返回 —— 可能是模型太慢或网络不通,可换更快的模型再试。`;
    case "cors":
      return "请求发不出去(浏览器被跨域/CORS 拦截)。该服务商可能不允许浏览器直连 —— 请换一家服务商,或填自建的网关地址。本站不提供代理,以免 Key 经手服务器。";
    case "auth":
      return "401 认证失败:API Key 无效或已过期。请检查 Key(注意别把 Key 的前后空格粘进来)。";
    case "forbidden":
      return "403 无权限:该 Key 不能调用这个模型,或账户欠费/未开通。";
    case "notfound":
      return "404 找不到接口:请检查 Base URL(应以 /v1 结尾)与模型名是否正确。";
    case "badrequest":
      return "400 请求被拒:通常是模型名不存在或该模型不支持对话接口。";
    case "ratelimit":
      return "429 触发限流或余额不足:稍后再试,或换一个 Key。";
    case "server":
      return "服务商返回了错误(5xx)或非 JSON 响应,稍后再试。";
    case "empty":
      return "模型返回了空内容。";
    case "parse":
      return "模型没有返回可解析的 JSON。可点「查看原始返回」排查(多半是模型太小,换个更强的模型)。";
  }
}

async function readErr(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 300);
  } catch {
    return "";
  }
}

/** 发起一次排片请求,返回模型原始文本。
 *  `outer` 供 UI 的「中断」按钮使用;超时与中断在 catch 里区分。
 *  `opts.noFilmList` = **无片单模式**(用户一部片都没打标,候选池是「全部有排期的影片 + 档位按随缘」)
 *  —— 此时必须额外告诉模型「没有片单,按用户偏好排」,否则 C4 的措辞会让它因为「没有 must/maybe」而交白卷。 */
export async function callLLM(
  cfg: AiCfg,
  payload: AiPayload,
  outer?: AbortSignal,
  opts?: { noFilmList?: boolean }
): Promise<string> {
  const url = cfg.baseUrl.trim().replace(/\/+$/, "") + "/chat/completions";
  const ctl = new AbortController();
  let timedOut = false;
  const onOuter = (): void => ctl.abort();
  if (outer) {
    if (outer.aborted) ctl.abort();
    else outer.addEventListener("abort", onOuter, { once: true });
  }
  const timer = window.setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, AI_TIMEOUT_MS);

  const parts = ["【影片清单与场次清单(JSON)】", JSON.stringify(payload), ""];
  if (opts?.noFilmList) {
    parts.push(
      "【本次模式:无片单】",
      "用户没有指定任何必看/备选影片(films[] 的 priority 全是 wild,只表示「可自由挑选」,不代表用户想看它)。",
      "请完全按下面的用户偏好,从 screenings[] 里挑出一份**最大化覆盖时间窗口**的行程:",
      "· 偏好给了时间范围(如「17:00 开始、看到最后一场」「下午三点开始、晚上七点结束」)→ 这是硬边界:",
      "  范围外的场次一律不选,「下午 N 点」=「N+12 点」(下午五点 = 17:00,不是 05:00);",
      "· 范围够宽时应当**贪心排满 —— 不要只挑 1 场就停**;除非当日窗口确实窄到只能装 1 场",
      "  (例如 17:00 开始、且最晚 end 也在 19:00 前),否则至少排 4 场以上;",
      "· 「看到最后 / 排到最晚 / 看完当日」= 排到当日(含跨午夜)最晚 end 的场次,不要因为",
      "  「看完太晚」或「跨午夜」就保守缩范围 —— 跨午夜场属于正常候选;",
      "· 「不要为了凑数选明知看不完的组合」指:**看完该场需要撑到次日 06:00 之后且中间无",
      "  30 分钟以上的休息窗口**;不要把「看得很晚(22:00 后结束)」等同于「看不完」;",
      "· 偏好没给时间范围 → 挑评分更高、含 GV(映后谈)更多的场次,组成紧凑行程;",
      "· 不要因为「没有必看片」而返回空 picks —— 至少给出一份可行行程。",
      ""
    );
  }
  parts.push(
    "【用户的附加偏好】",
    "· 「排除 / 时间限定」类(几点才开始看、几点前结束、上午不看、不要午夜场、只看某几家影院、只看某几天)",
    "  = 硬约束(C6),必须严格遵守:范围外的场次一律不得选入 picks,只能放进 dropped 并写明原因;",
    "· 「尽量 / 优先 / 最好」类是软倾向,在硬约束内尽量满足即可;",
    "· 若偏好与 C1–C5 的时段判定冲突,以 C1–C5 为准。",
    cfg.userPrompt.trim() ||
      (opts?.noFilmList
        ? "(用户未填写偏好 —— 请按评分与 GV 优先,挑一份时间紧凑、转场少的行程)"
        : "(用户未填写附加偏好,请仅按硬约束与档位优先级排片)")
  );
  const userMsg = parts.join("\n");

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key.trim()}` },
      body: JSON.stringify({
        model: cfg.model.trim(),
        temperature: 0.2, // 排片是约束求解,不是创作
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMsg },
        ],
      }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const detail = await readErr(res);
      const kind: AiErrorKind =
        res.status === 401
          ? "auth"
          : res.status === 403
            ? "forbidden"
            : res.status === 404
              ? "notfound"
              : res.status === 429
                ? "ratelimit"
                : res.status === 400
                  ? "badrequest"
                  : "server";
      throw new AiError(kind, detail);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new AiError("server", "响应不是 JSON");
    }
    const text = readContent(json);
    if (!text.trim()) throw new AiError("empty", "");
    return text;
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (timedOut) throw new AiError("timeout", "");
    if (ctl.signal.aborted) throw new AiError("aborted", "");
    throw new AiError("cors", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener("abort", onOuter);
  }
}

function readContent(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const msg = (choices[0] as { message?: unknown }).message;
  if (!msg || typeof msg !== "object") return "";
  const c = (msg as { content?: unknown }).content;
  return typeof c === "string" ? c : "";
}

/* ================= 输出校验(不信任模型) ================= */

export interface AiPlanPick {
  code: string;
  filmKey: string;
  zh: string;
  priority: Priority;
  show: Screening;
}

export interface AiPlanDrop {
  filmKey: string;
  zh: string;
  why: string;
}

export interface AiPlanReject {
  code: string;
  why: string;
}

/** 一个**候选方案** —— 模型可给 1~3 个(按用户优先级从高到低),由用户自己挑一个并入 A/B。 */
export interface AiPlanOption {
  /** 方案名(模型给的短标题,如「必看全覆盖」「最紧凑」);模型没给时 UI 退回「候选 N」 */
  title: string;
  picks: AiPlanPick[];
  drops: AiPlanDrop[];
  /** 本地复检剔除的场次(无效 code / 同片重复 / 时段冲突)—— UI 要明示条数 */
  rejected: AiPlanReject[];
  note: string;
}

export interface AiPlan {
  /** 候选方案(1~3 个,已按用户优先级从高到低排列) */
  options: AiPlanOption[];
  /** 模型整体说明(可选,不针对某一个方案) */
  note: string;
  raw: string;
}

function tryParse(s: string): { ok: true; val: unknown } | { ok: false } {
  try {
    return { ok: true, val: JSON.parse(s) as unknown };
  } catch {
    return { ok: false };
  }
}

/** 容错提取首个**括号平衡**的 JSON 对象(剥 ```json 围栏、忽略前后废话) */
function extractJson(raw: string): unknown {
  const t = raw.trim();
  const direct = tryParse(t);
  if (direct.ok) return direct.val;
  const start = t.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const r = tryParse(t.slice(start, i + 1));
        return r.ok ? r.val : undefined;
      }
    }
  }
  return undefined;
}

function readCodes(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === "string") out.push(x.trim());
    else if (x && typeof x === "object") {
      const c = (x as { code?: unknown }).code;
      if (typeof c === "string") out.push(c.trim());
    }
  }
  return out.filter((c) => c !== "");
}

function readDrops(v: unknown): { key: string; why: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { key: string; why: string }[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const o = x as { key?: unknown; film_key?: unknown; why?: unknown; reason?: unknown };
    const key = typeof o.key === "string" ? o.key : typeof o.film_key === "string" ? o.film_key : "";
    if (!key) continue;
    const why = typeof o.why === "string" ? o.why : typeof o.reason === "string" ? o.reason : "";
    out.push({ key, why: why.slice(0, 40) });
  }
  return out;
}

function slotsOf(picks: { code: string; show: Screening }[]): Slot[] {
  return picks.map((p) => ({
    code: p.code,
    date: p.show.date,
    start: hmsToMin(p.show.start_time),
    end: effEndMin(p.show, talkOnOf(p.code)),
    venue: p.show.venue_id,
  }));
}

/** 该 code 是否与已留场次冲突 —— **复用 `conflict.ts::computeConflicts`**,
 *  口径与网格完全一致(`effEndMin` + 同馆 0 / 跨馆 transitMin)。
 *  不信任模型的自我约束:模型算错 → 方案一进网格就红一片。
 *
 *  ★ 必须把**候选场次本身**一起丢进去算:computeConflicts 只报「入参里互相冲突的 code」,
 *  只传已留场次的话,候选 code 永远不在 codeSet 里 → 这个函数会永远返回 false(实测踩过)。 */
function conflictsWith(
  kept: { code: string; show: Screening }[],
  cand: { code: string; show: Screening },
  transitMin: number
): boolean {
  const res = computeConflicts(slotsOf([...kept, cand]), (a, b) => (a === b ? 0 : transitMin));
  for (const r of res.values()) if (r.codeSet.has(cand.code)) return true;
  return false;
}

/** 「并入」方案时的取舍 —— **纯逻辑,不写状态**(写入走 `state.ts::addGroupPicks`)。
 *  目标方案已有场次**一律保留**,只从 AI 建议里挑出能真正加进去的:
 *   ① 该片在目标方案里已有场次 → 跳过(每片一场,不重复排);
 *   ② 该 code 已在目标方案里 → 跳过(幂等:重复采纳同一份建议不会长出重复场次);
 *   ③ 与目标方案现有场次时段冲突 → 跳过(口径同网格:`effEndMin` + 同馆 0 / 跨馆 transitMin);
 *   ④ 其余留下,并**计入 kept** —— 同批建议内部也保持互不冲突。
 *  `skipped` 交回 UI 回执(「已加入 N 场 · 跳过 M 场」),不静默吞。 */
export function planMerge(
  cat: Catalog,
  existingCodes: string[],
  picks: AiPlanPick[],
  transitMin: number
): { add: AiPlanPick[]; skipped: number } {
  const kept: { code: string; show: Screening }[] = [];
  const keptCodes = new Set<string>();
  const keptFilms = new Set<string>();
  for (const code of existingCodes) {
    const s = cat.byCode.get(code);
    if (!s || keptCodes.has(code)) continue;
    keptCodes.add(code);
    keptFilms.add(filmNodeKey(cat, s));
    kept.push({ code, show: s });
  }
  const add: AiPlanPick[] = [];
  let skipped = 0;
  for (const p of picks) {
    if (keptCodes.has(p.code) || keptFilms.has(p.filmKey)) {
      skipped++;
      continue;
    }
    if (conflictsWith(kept, { code: p.code, show: p.show }, transitMin)) {
      skipped++;
      continue;
    }
    kept.push({ code: p.code, show: p.show });
    keptCodes.add(p.code);
    keptFilms.add(p.filmKey);
    add.push(p);
  }
  return { add, skipped };
}

/** **单个候选方案**的解析 + 校验 + 冲突剔除。`films` = 送出去的那批(用于补齐「未纳入」与取中文名)。
 *  模型给的 `plans[]` 里每一项、以及旧格式的顶层对象,都走这里 —— 复检口径只有一份。 */
function parseOnePlan(
  src: unknown,
  cat: Catalog,
  films: EngineFilm[],
  transitMin: number
): AiPlanOption {
  const o = (src ?? {}) as { picks?: unknown; dropped?: unknown; note?: unknown; title?: unknown };

  const zhOf = new Map<string, string>();
  const prioOf = new Map<string, Priority>();
  for (const f of films) {
    zhOf.set(f.key, f.zh);
    prioOf.set(f.key, f.priority);
  }

  const rejected: AiPlanReject[] = [];
  const cand: { code: string; filmKey: string; zh: string; priority: Priority; show: Screening }[] = [];
  const seen = new Set<string>();
  for (const code of readCodes(o.picks)) {
    const s = cat.byCode.get(code);
    if (!s) {
      rejected.push({ code, why: "无效 code(清单里没有这一场)" });
      continue;
    }
    const key = filmNodeKey(cat, s);
    if (!prioOf.has(key)) {
      // 只送已定档影片 → 清单外的 code 一律不认(「未设档位」不参与排片)。
      // 否则模型随手给一部没打标的片,会被静默排进方案里。
      rejected.push({ code, why: "该影片未打标(不在本次清单内)" });
      continue;
    }
    if (seen.has(key)) {
      rejected.push({ code, why: "同一部影片已选了其它场次" });
      continue;
    }
    seen.add(key);
    cand.push({
      code,
      filmKey: key,
      zh: zhOf.get(key) ?? s.title_zh ?? s.title_en,
      priority: prioOf.get(key) ?? "wild",
      show: s,
    });
  }

  // 按日期 → 开始时间升序,贪心留场:与已留场次冲突者剔除(确定性:早场优先保留)
  cand.sort(
    (a, b) =>
      a.show.date.localeCompare(b.show.date) || a.show.start_time.localeCompare(b.show.start_time)
  );
  const kept: typeof cand = [];
  for (const c of cand) {
    if (conflictsWith(kept, c, transitMin)) {
      rejected.push({ code: c.code, why: "与已保留场次时段冲突" });
      continue;
    }
    kept.push(c);
  }

  // 未纳入:模型自述的 dropped ∪ 「送出去但没排进来且模型没说明」的片
  const drops: AiPlanDrop[] = [];
  const dropSeen = new Set<string>();
  for (const d of readDrops(o.dropped)) {
    if (dropSeen.has(d.key)) continue;
    dropSeen.add(d.key);
    drops.push({ filmKey: d.key, zh: zhOf.get(d.key) ?? d.key, why: d.why || "AI 未说明原因" });
  }
  const inPlan = new Set(kept.map((p) => p.filmKey));
  for (const f of films) {
    if (f.priority === "wild") continue; // 随缘不自动排,也不提示
    if (inPlan.has(f.key) || dropSeen.has(f.key)) continue;
    dropSeen.add(f.key);
    drops.push({ filmKey: f.key, zh: f.zh, why: "AI 未排入" });
  }

  return {
    title: typeof o.title === "string" ? o.title.trim().slice(0, 30) : "",
    picks: kept,
    drops,
    rejected,
    note: typeof o.note === "string" ? o.note.slice(0, 200) : "",
  };
}

/** 解析 + 校验:支持**多方案**返回(`{"plans":[…]}`),并兼容旧的单方案(`{"picks":[…]}`)。
 *  ① 每个方案各自跑 `parseOnePlan`(本地复检,不信任模型自我约束);
 *  ② 去掉与前面**完全雷同**的方案(签名 = 场次 code 集合;模型偶尔把同一份排法抄 2~3 遍);
 *  ③ 最多保留 3 个 —— 再多用户也挑不过来,且响应更长更贵。 */
export function parseAiResult(
  raw: string,
  cat: Catalog,
  films: EngineFilm[],
  transitMin: number
): AiPlan {
  const obj = extractJson(raw);
  if (!obj || typeof obj !== "object") throw new AiError("parse", "");
  const o = obj as { plans?: unknown; note?: unknown };
  const legacy = !Array.isArray(o.plans) || o.plans.length === 0;
  const rawPlans: unknown[] = legacy ? [obj] : (o.plans as unknown[]);

  const seenSig = new Set<string>();
  const options: AiPlanOption[] = [];
  for (const rp of rawPlans) {
    if (options.length >= 3) break;
    const parsed = parseOnePlan(rp, cat, films, transitMin);
    const sig = parsed.picks
      .map((x) => x.code)
      .sort()
      .join(",");
    if (options.length > 0 && seenSig.has(sig)) continue; // 雷同方案只留第一个
    seenSig.add(sig);
    options.push(parsed);
  }
  if (options.length === 0) options.push(parseOnePlan({}, cat, films, transitMin)); // 兜底:plans 全是空对象
  return {
    options,
    note: legacy ? "" : typeof o.note === "string" ? o.note.slice(0, 200) : "",
    raw,
  };
}
