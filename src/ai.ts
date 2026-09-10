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
 * ② 硬约束编号 C1–C5,便于模型自查,也便于把校验失败原因映射回具体条款;
 * ③ 跨午夜显式说明 —— 模型对「29:35」几乎必然理解错,故打包时已换成「次日 05:35」文本;
 * ④ 强制 dropped 带原因 —— 与本地引擎的「未纳入原因」体验对齐,不让 must 静默消失。 */
const SYSTEM_PROMPT = [
  "你是电影节排片助手,为一位观众在硬约束下挑选场次。",
  "",
  "【输入】两条清单:",
  "1) films[]:{key(影片唯一标识), zh(中文名), orig(原始片名), priority(档位:must=必看 / maybe=备选 / wild=随缘), rating(豆瓣评分)}",
  "2) screenings[]:{code(场次唯一标识), film_key(所属影片的 key), date(YYYY-MM-DD), start(开始 HH:MM),",
  "   end(结束,可能写作「次日 05:35」= 跨午夜), venue(影厅代码), gv(该场是否含映后谈)}",
  "env:{transit_min(跨影厅转场缓冲分钟), gv_talk_min(映后谈时长), dates(影展全部日期)}",
  "",
  "【硬约束 —— 任何情况下不得违反】",
  "C1 每部影片最多选 1 场。",
  "C2 同一天内任意两场不得时间重叠;若两场影厅(venue)不同,前一场结束后必须再留出 transit_min 分钟转场。",
  "   标着「次日 HH:MM」的场次占用次日凌晨,与次日早晨的场次同样按此判定。",
  "C3 只能使用 screenings[] 里出现过的 code,禁止编造、禁止改写、禁止大小写变换。",
  "C4 优先级:must 尽力全覆盖(实在排不下才可放弃,并在 dropped 里说明原因);maybe 在硬约束内尽量多排;",
  "   wild 只在完全不影响 must/maybe 时才考虑。",
  "C5 同一部影片有多场可选时,优先选 gv=true 的场次;同为 GV 或同为非 GV 时,优先选时间更早的场次。",
  "",
  "【输出】只输出一个 JSON 对象,不要任何解释文字,不要 Markdown 代码围栏:",
  '{"picks":["<code>", ...], "dropped":[{"key":"<影片 key>","why":"<不超过 20 字的放弃原因>"}], "note":"<不超过 60 字的整体策略说明>"}',
  "picks 按日期与开始时间升序排列;若无任何可排场次则 picks 为空数组。",
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

/** 打包:入参 `films` 只应含**已定档**(priority ≠ null)的影片 —— 与本地引擎口径一致。 */
export function buildPayload(
  films: EngineFilm[],
  cat: Catalog,
  transitMin: number,
  gvTalkMin: number,
  dates: string[]
): AiPayload {
  const ordered = [...films].sort((a, b) => PRI_RANK[a.priority] - PRI_RANK[b.priority]);
  const filmsOut: AiPayloadFilm[] = [];
  const showsOut: AiPayloadShow[] = [];
  for (const f of ordered) {
    filmsOut.push({ key: f.key, zh: f.zh, orig: origOf(cat, f.key), priority: f.priority, rating: f.rating });
    for (const s of f.shows) {
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
 *  `outer` 供 UI 的「中断」按钮使用;超时与中断在 catch 里区分。 */
export async function callLLM(
  cfg: AiCfg,
  payload: AiPayload,
  outer?: AbortSignal
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

  const userMsg = [
    "【影片清单与场次清单(JSON)】",
    JSON.stringify(payload),
    "",
    "【用户的附加偏好 —— 请在上述硬约束内尽量满足;若与硬约束冲突,以硬约束为准】",
    cfg.userPrompt.trim() || "(用户未填写附加偏好,请仅按硬约束与档位优先级排片)",
  ].join("\n");

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

export interface AiPlan {
  picks: AiPlanPick[];
  drops: AiPlanDrop[];
  /** 本地复检剔除的场次(无效 code / 同片重复 / 时段冲突)—— UI 要明示条数 */
  rejected: AiPlanReject[];
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

/** 解析 + 校验 + 冲突剔除。`films` = 送出去的那批(用于补齐「未纳入」与取中文名)。 */
export function parseAiResult(
  raw: string,
  cat: Catalog,
  films: EngineFilm[],
  transitMin: number
): AiPlan {
  const obj = extractJson(raw);
  if (!obj || typeof obj !== "object") throw new AiError("parse", "");
  const o = obj as { picks?: unknown; dropped?: unknown; note?: unknown };

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
      // 只送已定档影片 → 清单外的 code 一律不认(与本地引擎「未设不参与」一致)。
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
    if (f.priority === "wild") continue; // 随缘不自动排,也不提示(与本地引擎一致)
    if (inPlan.has(f.key) || dropSeen.has(f.key)) continue;
    dropSeen.add(f.key);
    drops.push({ filmKey: f.key, zh: f.zh, why: "AI 未排入" });
  }

  return {
    picks: kept,
    drops,
    rejected,
    note: typeof o.note === "string" ? o.note.slice(0, 200) : "",
    raw,
  };
}
