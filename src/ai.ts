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
import { PRI_RANK } from "./pick";
import { SYSTEM_PROMPT } from "./ai-prompt";
import type { EngineFilm } from "./score";

/* 隐藏主 Prompt 已外移到 `ai-prompt.ts`(纯文本常量,见该文件头的设计取舍)。 */

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

/** 序列化上限(字符)兜底 —— 超了按 wild → maybe 丢片,must 永不丢。
 *  ⚠ 上限**按模型上下文档位取**(见 `payloadLimitFor`):固定 120k 对 `moonshot-v1-8k`
 *  这类 8k 上下文模型必然 400,而截断逻辑永远够不着。 */
const PAYLOAD_LIMIT = 120_000;

/** 按模型名里的上下文档位(`8k` / `32k` / `128k` …)推算可安全序列化的字符上限。
 *  中文约 1 字符 ≈ 1 token,JSON 里多为 ASCII,故取「上下文 token 数 × 1.5」作字符预算,
 *  再为 SYSTEM_PROMPT 与输出留出余量。识别不出档位时退回默认上限(不改变现有行为)。 */
export function payloadLimitFor(model: string): number {
  const m = model.toLowerCase();
  const hit = /(\d+)\s*k/.exec(m);
  const ctxK = hit ? Number(hit[1]) : 0;
  if (ctxK && ctxK <= 8) return 12_000;
  if (ctxK && ctxK <= 32) return 60_000;
  if (ctxK && ctxK >= 128) return 240_000;
  return PAYLOAD_LIMIT;
}

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
  dates: string[],
  /** 序列化字符上限(按模型上下文档位,见 `payloadLimitFor`);省略 = 默认上限 */
  limit: number = PAYLOAD_LIMIT
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
    JSON.stringify({ films: filmsOut, screenings: showsOut }).length > limit
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
  | "offline"
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
    case "offline":
      return "当前处于离线状态(浏览器报告无网络)—— 请连上网络后再试。排期 / 片单本身离线可用,只有 AI 排片需要联网。";
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
        max_tokens: 4096, // 约束输出规模:防跑飞 / 控成本(方案文本远小于此)
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
    // 先判「离线」再判 CORS:断网时 fetch 抛的是同一个 TypeError,旧实现会误导用户去换服务商
    if (typeof navigator !== "undefined" && navigator.onLine === false) throw new AiError("offline", "");
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

/** 容错提取首个**括号平衡**的 JSON 值(剥 ```json 围栏、忽略前后废话)。
 *  顶层既可能是对象 `{…}` 也可能是数组 `[…]`(模型偶尔只回方案数组),
 *  故用括号栈同时支持两种,且字符串内的括号不计数。 */
function extractJson(raw: string): unknown {
  const t = raw.trim();
  const direct = tryParse(t);
  if (direct.ok) return direct.val;
  const start = t.search(/[[{]/);
  if (start < 0) return undefined;
  const stack: string[] = [];
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
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return undefined; // 括号不匹配 → 放弃
      if (stack.length === 0) {
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
      // 数字 code 也收(模型偶发输出 `{"code":4}`);收进来才能走「无效 code」的 rejected 回执,
      // 而不是被静默丢弃、用户看不到任何解释。
      else if (typeof c === "number" && Number.isFinite(c)) out.push(String(c));
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

  // 顶层形态三选一:① `{"plans":[…], "note":…}`(新)② `{"picks":[…]}`(旧单方案)③ `[…]`(纯数组)
  let rawPlans: unknown[];
  let note = "";
  if (Array.isArray(obj)) {
    rawPlans = obj;
  } else {
    const o = obj as { plans?: unknown; note?: unknown };
    const legacy = !Array.isArray(o.plans) || o.plans.length === 0;
    rawPlans = legacy ? [obj] : (o.plans as unknown[]);
    note = legacy ? "" : typeof o.note === "string" ? o.note.slice(0, 200) : "";
  }

  const seenSig = new Set<string>();
  const options: AiPlanOption[] = [];
  for (const rp of rawPlans) {
    if (options.length >= 3) break;
    const parsed = parseOnePlan(rp, cat, films, transitMin);
    // 签名 = 场次 code 集合(**不含标题 / 未纳入名单**)—— 与 tests/ai-parse.test.ts 的
    // 「雷同方案只保留第一个」契约一致:模型常把同一份排法换个标题抄 2~3 遍。
    const sig = parsed.picks
      .map((x) => x.code)
      .sort()
      .join(",");
    if (options.length > 0 && seenSig.has(sig)) continue; // 雷同方案只留第一个
    seenSig.add(sig);
    options.push(parsed);
  }
  if (options.length === 0) options.push(parseOnePlan({}, cat, films, transitMin)); // 兜底:plans 全是空对象
  return { options, note, raw };
}
