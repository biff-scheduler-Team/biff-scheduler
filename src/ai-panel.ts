// 智能排片弹层 —— **AI 单通道**(本地确定性求解引擎已于 2026-09-10 整体下线,见 PLAN-20260910143516)。
// 从 `library.ts` 拆出(2026-09-10,PLAN-20260910232833):本文件 = AI 面板**全部 UI**,
// 与 `ai.ts`(隐藏 Prompt + 打包 + 调用 + 输出校验,纯逻辑、不碰 DOM)配对。
//
// 隐私承诺的落点(见 ai.ts 文件头):
//   · 三件套(baseUrl / model / key)与用户偏好只落 `localStorage["biff.ai.v1"]`;
//   · 请求由浏览器直连用户填的 baseURL,本站 /api/* 一行不改、不新增任何代理;
//   · UI 只显示掩码 key(maskKey),完整 key 不出现在任何 title / 文本节点里。
// 弹层内改状态必须**就地重绘**(renderAll 不管 #modal-root,见 CONVENTIONS §二)。
//
// ⚠ 本文件**不反向依赖 library.ts** —— 只 `import type { FilmNode, LibraryCtx }`(类型导入被擦除),
//   「去影片库打标」的落点由调用方经 `AiPanelOpts.onGoTag` 注入。

import type { Group, Priority, Screening } from "./types";
import { dateInfo, el, fmtMinRange, groupByDate } from "./util";
import { venueShort } from "./legend";
import { priTag } from "./pick";
import { fieldBox } from "./form";
import { PILL_IDLE, PILL_ON } from "./chips";
import { BTN_ABORT, BTN_DISABLED, BTN_MINI, BTN_PRIMARY } from "./ui";
import { closeModal, openModal } from "./modal";
import { addGroupPicks, codesOfGroup, setCurrentGroup, store } from "./state";
import type { EngineFilm } from "./score";
import type { FilmNode, LibraryCtx } from "./library";
import {
  AI_PRESETS,
  AI_TIMEOUT_MS,
  AiError,
  aiErrorText,
  aiReady,
  buildPayload,
  callLLM,
  clearAiCfg,
  defaultAiCfg,
  loadAiCfg,
  loadAiDates,
  maskKey,
  payloadLimitFor,
  parseAiResult,
  planMerge,
  saveAiCfg,
  saveAiDates,
  type AiCfg,
  type AiPayload,
  type AiPlan,
  type AiPlanDrop,
  type AiPlanOption,
  type AiPlanPick,
  type AiPlanReject,
} from "./ai";

/* ---- 智能排片 ▸(AI 排片 → 采纳为 A/B 方案) ----
 * 入口就在「影片库」tab 上 → `fromLibrary = true`:无片单模式提示里的
 * 「← 返回影片库打标」只需关掉排片弹层(抽屉本来就在后面,不再叠一层)。 */
export interface AiPanelOpts {
  /** 返回上一层(影片库 / 我的选片)时刷新其列表 —— 并入方案后「已选 N 场」计数要跟上。 */
  onReturn?: () => void;
  /** 本弹层是从**影片库**开出来的(而非「我的选片」)—— 只影响无片单模式里
   *  「去影片库打标」按钮的文案与落点。 */
  fromLibrary?: boolean;
  /** 「去影片库打标」的落点(已先 `closeModal()`)—— 由 library 注入,避免反向依赖。 */
  onGoTag: () => void;
}

export function openEngineDialog(filmList: FilmNode[], ctx: LibraryCtx, opts: AiPanelOpts): void {
  // 检查是否有任何有排期的影片(无论是否打标)—— 若整个 festival 都没排期则早退
  const anyHasShow = filmList.some((n) => n.shows.length > 0);
  const box = el("div", "grid gap-3");
  if (!anyHasShow) {
    box.appendChild(
      el(
        "div",
        "text-13 text-muted py-[10px] px-[2px] leading-[1.7]",
        "当前没有任何已发布排期,无法排片 —— 排期数据就绪后再来。"
      )
    );
    openModal("智能排片 · AI 建议行程", box, false, opts.onReturn);
    return;
  }
  // wanted / noFilmList 计算搬到 aiPanel 内 —— 因为「强制无片单」是面板内的 toggle,
  // 切换时必须重新计算 wanted 并刷新整个面板。openEngineDialog 只负责早退 + 弹层挂载。
  box.appendChild(aiPanel(filmList, ctx, store.settings.transitMin, opts));
  openModal("智能排片 · AI 建议行程", box, true, opts.onReturn);
}

/* 按钮字面量已收敛到 `ui.ts`(BTN_PRIMARY / BTN_ABORT / BTN_MINI / BTN_DISABLED)。 */

/** 配置表单的一行(标签 + 控件同行,提示另起一行)—— 骨架走 `form.ts::fieldBox` */
function aiField(label: string, hint: string): { box: HTMLElement; row: HTMLElement } {
  return fieldBox(label, hint);
}

/** `tag` 落到 `data-ai`,给无头验收脚本做稳定锚点(文案选择器易受改字影响) */
function aiInput(type: string, value: string, ph: string, tag: string): HTMLInputElement {
  const i = el("input", "border border-line rounded-8 px-2 py-[5px] text-13 w-[250px] max-w-full bg-card") as HTMLInputElement;
  i.type = type;
  i.value = value;
  i.placeholder = ph;
  i.autocomplete = "off";
  i.spellcheck = false;
  i.dataset.ai = tag;
  return i;
}

/* ---- AI 排片面板 ----
 *  `noFilmList` = 无片单模式(一部都没打标 **或** 用户手动勾了「强制无片单」开关;
 *  候选池 = 全部有排期的影片,怎么排看偏好文字)。
 *  **wanted 与 noFilmList 都在本面板内重算** —— 因为「强制无片单」开关 / 档位变化都会影响
 *  候选池,搬出本函数就要么用全局 store(又多一个状态)、要么传引用,都不如闭包内重算直接。
 *  **多方案**(2026-09-10 加,见 PLAN-20260910162000):模型返回 1~3 个候选方案(按用户优先级
 *  排序),`resultCard` 每个方案一张**可折叠卡** + 独立「并入 A/B」—— 用户自己挑一个采用;
 *  日期 chips 的**上次选择**落 `biff.ai.dates.v1`(收窄日期 = 减少上下文)。 */
function aiPanel(filmList: FilmNode[], ctx: LibraryCtx, transitMin: number, opts: AiPanelOpts): HTMLElement {
  const fromLibrary = opts.fromLibrary ?? false;
  const wrap = el("div", "grid gap-[10px]");
  let cfg = loadAiCfg();
  let editing = false; // 「更换」= 已配置也展开表单
  let running = false;
  let plan: AiPlan | null = null;
  let errText = "";
  let showRaw = false;
  /** 每个候选方案(下标)已并入的方案 —— 用户自己挑,各方案互不影响 */
  const adopted = new Map<number, Group>();
  /** 每个候选方案的采纳回执 —— 并入是非破坏性操作,故不弹确认,改在结果卡上写清「加了 / 跳过了」几场 */
  const adoptNotes = new Map<number, string>();
  /** 结果卡里展开的候选方案下标 —— 默认只展开第一个(3 份完整场次清单一次性铺开太长) */
  const openOpts = new Set<number>([0]);
  let ctl: AbortController | null = null;
  let promptTa: HTMLTextAreaElement | null = null;
  /** 「强制无片单模式」开关 —— 默认 off,on 时忽略已打标影片,候选池 = 全部有排期影片。
   *  (PLAN-20260910145749 §8:tagged 非空时按现状是「有片单模式」,但用户可能希望 AI 完全自由选 —— 这时切到 on) */
  let forceNoFilmList = false;
  /** 日期范围:**记住上次选择**(2026-09-10 改,见 PLAN-20260910162000)—— 落 `biff.ai.dates.v1`;
   *  首次(无存档)仍为**全不选**(防误操作:开弹层直接点「开始」会把 10 天 700 场全量送给 LLM 白烧 token,
   *  空选时 `runBar` 按钮禁用 + 状态红字「至少要选一天」)。只送所选日期的场次 → 收窄日期 = 直接减少上下文。
   *  存档里已不存在的日期(数据换版)自动丢弃。 */
  const selDates = new Set<string>(loadAiDates().filter((d) => ctx.cat.dates.includes(d)));
  /** 日期选择变更的统一出口:落盘(记住) → 重绘(按钮态 / 计数 / 下一次 payload 一起跟上) */
  const commitDates = (): void => {
    saveAiDates(selDates);
    paint();
  };

  /** 重算「已定档」影片(`tagged`)—— 与 `openEngineDialog` 原口径一致:
   *  只收 priority ≠ null 的影片;`null`(= 未设 / 只点了场次)不参与。 */
  const taggedNow = (): EngineFilm[] => {
    const out: EngineFilm[] = [];
    for (const n of filmList) {
      const p = ctx.picks.get(n.key)?.priority;
      if (!p) continue;
      out.push({
        key: n.key,
        zh: n.zh,
        priority: p,
        rating: n.cats[0]?.rating ?? null,
        shows: n.shows,
      });
    }
    return out;
  };
  /** 重算候选池 —— paint 每次都跑,所以开关切换能即时反映到面板与后续 buildPayload。 */
  const wantedNow = (): { wanted: EngineFilm[]; noFilmList: boolean } => {
    const tagged = taggedNow();
    const noFilmList = tagged.length === 0 || forceNoFilmList;
    if (noFilmList) {
      return {
        wanted: filmList
          .filter((n) => n.shows.length > 0)
          .map((n) => ({
            key: n.key,
            zh: n.zh,
            priority: "wild" as Priority,
            rating: n.cats[0]?.rating ?? null,
            shows: n.shows,
          })),
        noFilmList: true,
      };
    }
    return { wanted: tagged, noFilmList: false };
  };

  /** 打包 —— 每次重算(日期选择或「强制无片单」切换都会变)。`dates` 同时是过滤条件与 `env.dates`:
   *  所选日期内一场都没有的影片整条不送(送过去模型也排不了)。 */
  const buildNow = (): AiPayload => {
    const { wanted } = wantedNow();
    // 上限按**当前配置的模型**上下文取 —— 8k 档模型配 120k 字符必然 400(见 ai.ts::payloadLimitFor)
    return buildPayload(
      wanted,
      ctx.cat,
      transitMin,
      store.settings.gvTalkMin,
      ctx.cat.dates.filter((d) => selDates.has(d)),
      payloadLimitFor(cfg.model)
    );
  };

  /** 实际送出去的影片清单(与 payload.films 同源)—— `parseAiResult` 取中文名 / 补「未纳入」都用它 */
  const sentFilmsOf = (p: AiPayload): EngineFilm[] => {
    const keys = new Set(p.films.map((f) => f.key));
    return wantedNow().wanted.filter((f) => keys.has(f.key));
  };

  /* ---- 隐私说明(恒显,配置前后都在) ---- */
  const privacyBar = (): HTMLElement => {
    const card = el("div", "rounded-8 border border-line-faint bg-hover px-3 py-[10px] grid gap-[5px]");
    card.appendChild(el("div", "text-12 font-bold text-ok", "API Key 只存在本地 · 不上传、不经手服务器"));
    const ul = el("div", "grid gap-[3px] text-12 text-ink-2 leading-[1.6]");
    for (const t of [
      "Key 只保存在你这台设备的浏览器里,不存在本站服务器,也不会进入任何发往本站的请求",
      "排片请求由浏览器直连你填写的模型服务商 —— 本站不经手,也无法看到你的 Key",
      "本站不提供、不转售模型服务:用你自己的额度,本站既不花你的钱也不赚你的钱",
      "浏览器本地为明文存储:公用电脑请勿保存;随时可点「清除 Key」",
    ]) {
      ul.appendChild(el("div", "", `· ${t}`));
    }
    card.appendChild(ul);
    return card;
  };

  /* ---- 无片单模式提示(仅 noFilmList 时渲染)----
   * 必须明说四件事:① 没打标也能排;② 候选池有多大(= 直接的成本);③ **先选片能显著收窄候选**;
   * ④ 并入后这些片在「我的选片」里是「未设」档位。
   * **引导先选片**(2026-09-10 加,见 PLAN-20260910163000):候选 270+ 部 / 700 场一次性送给 LLM
   * 又慢又贵,而用户在「影片库」打标十来部就能把上下文压到十分之一 —— 故给一个**直达按钮**,
   * 而不是只把「建议收窄日期」写成小字。 */
  const modeBar = (): HTMLElement => {
    const card = el("div", "rounded-8 border border-biff-line bg-biff-soft px-3 py-[10px] grid gap-[5px]");
    const { wanted } = wantedNow();
    const taggedCount = taggedNow().length;
    const headText =
      taggedCount === 0
        ? "还没有选片 —— 不打标也能排,但先打标更快更准"
        : "强制无片单模式:忽略已打标的影片";
    card.appendChild(el("div", "text-12 font-bold text-biff-ink", headText));
    const ul = el("div", "grid gap-[3px] text-12 text-ink-2 leading-[1.6]");
    for (const t of [
      taggedCount === 0
        ? `你还没给任何影片打「必看 / 备选 / 随缘」→ 本次把全部 ${wanted.length} 部有排期的影片都作为候选`
        : `你的「我的选片」里有 ${taggedCount} 部已打标的影片 → 本次**忽略这些**,把全部 ${wanted.length} 部有排期的影片都作为候选`,
      taggedCount === 0
        ? `**先选片更划算**:去「影片库」给想看的片点「必看 / 备选 / 随缘」,候选池会从 ${wanted.length} 部缩到你打标的那几部 —— 请求更快更省,排出来也更贴你的口味`
        : "想更省 token:取消上面的「强制无片单」开关,只把已打标的影片交给 AI",
      "怎么排**完全看下面「③ 你的排片偏好」** —— 例如「下午三点开始、晚上七点结束」「只看 BCC 的场」「每天最多 3 场」",
      "不填偏好也可以:会按评分与 GV(映后谈)优先挑一份紧凑行程",
      "并入方案后,这些片在「我的选片」里显示为「未设」档位(你没给它们打标,不会替你编一个)",
      "候选多 → 单次请求又慢又贵:至少先在「② 排哪几天」里收窄到你要的那几天",
    ]) {
      ul.appendChild(el("div", "", `· ${t}`));
    }
    card.appendChild(ul);
    // 直达打标入口:先关掉排片弹层(回到影片库 / 我的选片),再开影片库。
    // 从影片库进来的话**只关本层** —— 否则会在栈里叠出第二层一模一样的影片库(落点由 onGoTag 决定)。
    if (taggedCount === 0) {
      const go = el("button", BTN_PRIMARY, fromLibrary ? "← 返回影片库打标" : "去影片库打标 ▸");
      go.dataset.ai = "go-tag";
      go.dataset.tip = "在「影片库」给想看的片点「必看 / 备选 / 随缘」,再回来排片 —— 候选更少、请求更快、结果更准";
      go.addEventListener("click", () => {
        closeModal();
        opts.onGoTag();
      });
      card.appendChild(go);
    }
    return card;
  };

  /* ---- 「强制无片单」开关(仅 tagged 非空时显示)----
   * 让用户在「已打标的影片作强约束」」与「AI 自由选」之间切换,默认 off(尊重用户已打的档位)。
   * 切换时 wanted 重算,paint 立即反映到 modeBar / runBar / payload 计数(PLAN-20260910145749 §8)。
   * tagged 为 0 时返回 null —— 此时已是「真·无片单模式」,开关无意义。 */
  const forceToggleRow = (): HTMLElement | null => {
    const taggedCount = taggedNow().length;
    if (taggedCount === 0) return null;
    const row = el(
      "label",
      "flex items-center gap-[8px] cursor-pointer select-none rounded-8 border border-line bg-card px-3 py-[8px]"
    );
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = forceNoFilmList;
    cb.dataset.ai = "force-no-film-list";
    cb.className = "accent-biff w-[14px] h-[14px] cursor-pointer";
    cb.addEventListener("change", () => {
      forceNoFilmList = cb.checked;
      // 已有结果也作废:候选池已变,旧 picks/drops/rejected 都失去上下文
      plan = null;
      errText = "";
      adopted.clear();
      adoptNotes.clear();
      openOpts.clear();
      openOpts.add(0);
      paint();
    });
    const txt = el(
      "span",
      "text-13 text-ink-2",
      `强制无片单模式(忽略「我的选片」里已打标的 ${taggedCount} 部影片)`
    );
    row.append(cb, txt);
    return row;
  };

  /* ---- 态 A:未配置(或点了「更换」)---- */
  const cfgForm = (): HTMLElement => {
    const box = el("div", "grid gap-[10px] border border-line rounded-10 p-3");
    box.appendChild(el("div", "text-13 font-bold text-ink", "① 填入你自己的模型 API Key"));

    const f0 = aiField("服务商", "选中只预填 Base URL 与模型名,两项都可改;「自定义」留空自填");
    const sel = document.createElement("select");
    sel.className = "border border-line rounded-8 px-2 py-[5px] text-13 bg-card";
    for (const p of AI_PRESETS) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.label;
      sel.appendChild(o);
    }
    sel.value = AI_PRESETS.find((p) => p.baseUrl === cfg.baseUrl && p.model === cfg.model)?.id ?? "custom";
    sel.dataset.ai = "preset";
    f0.row.appendChild(sel);
    box.appendChild(f0.box);

    const f1 = aiField("Base URL", "OpenAI 兼容接口地址,通常以 /v1 结尾");
    const urlInp = aiInput("text", cfg.baseUrl, "https://api.deepseek.com/v1", "url");
    f1.row.appendChild(urlInp);
    box.appendChild(f1.box);

    const f2 = aiField("模型名", "服务商文档里的模型 ID");
    const modelInp = aiInput("text", cfg.model, "deepseek-chat", "model");
    f2.row.appendChild(modelInp);
    box.appendChild(f2.box);

    const f3 = aiField("API Key", "只写入本机浏览器;不会发往本站服务器,本站也读不到");
    const keyInp = aiInput("password", cfg.key, "sk-…", "key");
    const eye = el("button", BTN_MINI, "显示");
    eye.dataset.ai = "eye";
    eye.addEventListener("click", () => {
      const show = keyInp.type === "password";
      keyInp.type = show ? "text" : "password";
      eye.textContent = show ? "隐藏" : "显示";
    });
    f3.row.append(keyInp, eye);
    box.appendChild(f3.box);

    sel.addEventListener("change", () => {
      const p = AI_PRESETS.find((x) => x.id === sel.value);
      if (p && p.id !== "custom") {
        urlInp.value = p.baseUrl;
        modelInp.value = p.model;
      }
    });

    // 操作行:校验提示靠左、按钮组贴右(次要「取消」在左,主「保存到本机」贴右下角)——
    // 与设置弹层底部主按钮同一落位语言(PLAN-20260910135532 §二 态 A 草图即右对齐)。
    const actions = el("div", "flex gap-[10px] items-center flex-wrap");
    const save = el("button", BTN_PRIMARY, "保存到本机");
    save.dataset.ai = "save";
    const hint = el("span", "text-12 text-conf flex-1 min-w-0", "");
    save.addEventListener("click", () => {
      const next: AiCfg = {
        baseUrl: urlInp.value.trim(),
        model: modelInp.value.trim(),
        key: keyInp.value.trim(),
        userPrompt: cfg.userPrompt,
      };
      if (!aiReady(next)) {
        hint.textContent = "三项都要填:Base URL / 模型名 / API Key";
        return;
      }
      cfg = next;
      saveAiCfg(cfg);
      editing = false;
      paint();
    });
    const btns = el("div", "flex items-center gap-[10px] ml-auto");
    if (aiReady(cfg)) {
      const cancel = el("button", BTN_MINI, "取消");
      cancel.dataset.ai = "cancel";
      cancel.addEventListener("click", () => {
        editing = false;
        paint();
      });
      btns.appendChild(cancel);
    }
    btns.appendChild(save);
    actions.append(hint, btns);
    box.appendChild(actions);
    return box;
  };

  /* ---- 态 B:已配置 ---- */
  const readyBar = (): HTMLElement => {
    const bar = el("div", "flex items-center gap-[8px] flex-wrap rounded-8 border border-line-faint bg-hover px-3 py-[9px]");
    bar.appendChild(el("span", "text-13 font-bold text-ok", "✓ 已配置"));
    const preset = AI_PRESETS.find((p) => p.baseUrl === cfg.baseUrl && p.model === cfg.model);
    bar.appendChild(
      el("span", "text-12 text-ink-2 min-w-0 truncate", `${preset ? preset.label + " · " : ""}${cfg.model} · ${maskKey(cfg.key)}`)
    );
    bar.appendChild(el("span", "flex-1"));
    const edit = el("button", BTN_MINI, "更换");
    edit.dataset.ai = "edit";
    edit.dataset.tip = "改 Base URL / 模型 / Key";
    edit.addEventListener("click", () => {
      editing = true;
      paint();
    });
    const clr = el("button", BTN_MINI, "清除 Key");
    clr.dataset.ai = "clear";
    clr.dataset.tip = "删掉本机保存的 API Key(其它设置不受影响)";
    clr.addEventListener("click", () => {
      if (!window.confirm("清除本机保存的 API Key?(只删 Key;偏好文字与本次 AI 结果保留,仍可采纳)")) return;
      clearAiCfg();
      cfg = { ...defaultAiCfg(), userPrompt: cfg.userPrompt };
      // 结果与错误**不清**:那是已经花掉的额度换来的会话状态,与凭据无关 ——
      // 清 Key 之后照样可以「并入 A/B 方案」。
      editing = false;
      paint();
    });
    bar.append(edit, clr);
    return bar;
  };

  /* ---- ② 日期范围(记住上次选择;首次全不选)----
   * 只把选中日期的场次送给模型(收窄日期 = 直接减少上下文与费用)→ 配合「并入」可逐天排片、
   * 累积到同一方案。选择落 `biff.ai.dates.v1`,下次开弹层自动带回(见 PLAN-20260910162000)。 */
  const dateBar = (): HTMLElement => {
    const box = el("div", "grid gap-[6px]");
    const head = el("div", "flex items-baseline gap-[8px] flex-wrap");
    head.append(
      el("span", "text-13 font-bold text-ink", "② 排哪几天(记住上次选择)"),
      el("span", "text-12 text-muted", "只送选中日期的场次 —— 配合「并入」可一天天排,累积进同一方案")
    );
    box.appendChild(head);

    const row = el("div", "flex flex-wrap gap-[6px]");
    for (const d of ctx.cat.dates) {
      const { label, weekday } = dateInfo(d);
      const on = selDates.has(d);
      const b = el("button", (on ? PILL_ON : PILL_IDLE) + " tabular-nums", `${label} ${weekday}`);
      b.dataset.ai = `date-${d}`;
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.dataset.tip = on ? "点击取消这一天" : "点击加入这一天";
      b.addEventListener("click", () => {
        if (selDates.has(d)) selDates.delete(d);
        else selDates.add(d);
        commitDates();
      });
      row.appendChild(b);
    }
    box.appendChild(row);

    const foot = el("div", "flex items-center gap-[8px] flex-wrap");
    const all = el("button", BTN_MINI, "全选");
    all.dataset.ai = "date-all";
    all.addEventListener("click", () => {
      for (const d of ctx.cat.dates) selDates.add(d);
      commitDates();
    });
    const none = el("button", BTN_MINI, "全不选");
    none.dataset.ai = "date-none";
    none.addEventListener("click", () => {
      selDates.clear();
      commitDates();
    });
    // 状态靠左、操作靠右(与同面板 readyBar / resultCard 同一语言);操作组整体 ml-auto,
    // 窄屏 flex-wrap 折行后仍贴右缘。
    foot.appendChild(
      el(
        "span",
        selDates.size === 0 ? "text-12 font-semibold text-conf" : "text-12 text-muted",
        selDates.size === 0 ? "至少要选一天才能排片" : `已选 ${selDates.size} / ${ctx.cat.dates.length} 天`
      )
    );
    const btns = el("div", "flex items-center gap-[8px] ml-auto");
    btns.append(all, none);
    foot.appendChild(btns);
    box.appendChild(foot);
    return box;
  };

  const promptArea = (): HTMLElement => {
    const box = el("div", "grid gap-[6px]");
    const head = el("div", "flex items-baseline gap-[8px] flex-wrap");
    head.append(
      el("span", "text-13 font-bold text-ink", "③ 你的排片偏好(可选)"),
      el("span", "text-12 text-muted", "不重叠 / 跨馆转场 / 每片一场 / 你写明的时间限定 均不可违背")
    );
    box.appendChild(head);
    const ta = el(
      "textarea",
      "border border-line rounded-8 px-2 py-[7px] text-13 leading-[1.6] w-full min-h-[76px] resize-y bg-card focus:border-biff"
    ) as HTMLTextAreaElement;
    ta.value = cfg.userPrompt;
    ta.maxLength = 500;
    ta.dataset.ai = "prompt";
    ta.placeholder =
      "例:21 号 17:00 开始看、看到最晚那场(含跨午夜);上午不看;只看 BCC;每部片优先选带 GV 的场";
    promptTa = ta;
    const count = el("span", "text-11 text-meta tabular-nums");
    const upd = (): void => {
      count.textContent = `${ta.value.length}/500 字`;
    };
    ta.addEventListener("input", upd);
    upd();
    // 口语化时间会被模型归一到 24h 数字(下午五点 = 17:00)。为避免误读,推荐写「17:00 开始看」这种结构化形式 —— 见 PLAN-20260910145749
    const tip = el(
      "div",
      "text-12 text-meta leading-[1.55]",
      "口语化时间(如「下午五点」)会被自动归一到 24h;为避免误读,推荐写「17:00 开始看」这种结构化形式。"
    );
    tip.dataset.ai = "prompt-tip";
    // 字数计数靠左、操作靠右 —— 与日期条底部同一语言(状态左 / 操作右)
    const foot = el("div", "flex items-center gap-[8px]");
    foot.appendChild(count);
    foot.appendChild(el("span", "flex-1"));
    const reset = el("button", BTN_MINI, "清空");
    reset.dataset.ai = "prompt-reset";
    reset.addEventListener("click", () => {
      ta.value = "";
      upd();
    });
    foot.appendChild(reset);
    box.append(ta, tip, foot);
    return box;
  };

  const runBar = (): HTMLElement => {
    const bar = el("div", "flex items-center gap-[10px] flex-wrap");
    const p = buildNow();
    const noDate = selDates.size === 0;
    const btn = el(
      "button",
      running ? BTN_ABORT : noDate ? BTN_DISABLED : BTN_PRIMARY,
      running ? "生成中… 点击中断" : "④ 开始 AI 排片"
    );
    btn.dataset.ai = "run";
    btn.disabled = noDate && !running;
    if (running) btn.addEventListener("click", () => ctl?.abort());
    else if (!noDate) btn.addEventListener("click", () => void run());
    bar.appendChild(btn);
    const info = el("span", "text-12 text-muted min-w-0");
    const scope = selDates.size === ctx.cat.dates.length ? "" : `(仅所选 ${selDates.size} 天)`;
    // 所选日期内无场次的影片不送 → 必须说出来,不能静默(与 truncated 分开计)
    const excluded = wantedNow().wanted.length - p.films.length - p.truncated;
    info.textContent = noDate
      ? "请至少选择一天"
      : p.truncated > 0
        ? `本次仅送 ${p.films.length} 部 / ${p.screenings.length} 场${scope}(超出长度上限,已按 随缘→备选 截断 ${p.truncated} 部,必看未丢)`
        : `本次送 ${p.films.length} 部 / ${p.screenings.length} 场${scope}${
            excluded > 0 ? ` · 另有 ${excluded} 部在所选日期无场次` : ""
          } · 最多等 ${Math.round(AI_TIMEOUT_MS / 1000)} 秒`;
    bar.appendChild(info);
    return bar;
  };

  const errBox = (): HTMLElement => {
    const box = el("div", "rounded-8 border border-biff-line bg-biff-soft px-3 py-[10px] grid gap-[5px]");
    box.appendChild(el("div", "text-12 font-bold text-biff-ink", "AI 排片失败"));
    box.appendChild(el("div", "text-12 text-ink-2 leading-[1.6]", errText));
    return box;
  };

  /** 采纳按钮:把某个候选方案里不冲突的场次**追加**进 A / B(现有场次一律保留,不会覆盖)。 */
  const mkAdopt = (g: Group, idx: number, picks: AiPlanPick[]): HTMLElement => {
    const done = adopted.get(idx) === g;
    const b = el(
      "button",
      "border-0 rounded-7 px-[12px] py-[5px] text-12 font-bold whitespace-nowrap " +
        (done
          ? "text-muted bg-raised cursor-default"
          : "text-on-brand bg-[linear-gradient(135deg,var(--biff-red)_0%,var(--biff-red-2)_100%)] hover:brightness-[1.05]"),
      done ? `✓ 已并入 ${g} 方案` : `并入 ${g} 方案`
    );
    b.dataset.ai = `adopt-${g}`;
    b.dataset.aiAdopt = "1"; // 让方案头知道这一下是「采纳」而不是「折叠」
    b.dataset.tip = `把「方案 ${idx + 1}」里不冲突的场次追加到 ${g} 方案 —— 现有场次一律保留,不会覆盖`;
    if (done) b.disabled = true;
    else
      b.addEventListener("click", () => {
        // 用**实时**数据(codesOfGroup),不用 ctx.slots —— 后者是开弹层那一刻的快照。
        // 追加而非替换:planMerge 按网格同口径(effEndMin + 转场)剔掉重复/冲突的,其余才落库。
        const { add, skipped } = planMerge(ctx.cat, codesOfGroup(g), picks, store.settings.transitMin);
        if (add.length === 0) {
          adoptNotes.set(
            idx,
            skipped > 0
              ? `${g} 方案没有可加入的场次:${skipped} 场与现有行程重复或时段冲突`
              : `${g} 方案没有可加入的场次`
          );
          paint();
          return;
        }
        // 无片单模式(含「强制无片单」):用户从没给这些片打标 → 落库写「未设」,不替他编一个「随缘」
        const { noFilmList: isNF } = wantedNow();
        addGroupPicks(
          g,
          add.map((x) => ({ key: x.filmKey, code: x.code, priority: isNF ? null : x.priority }))
        );
        if (store.group !== g) setCurrentGroup(g);
        adopted.set(idx, g);
        adoptNotes.set(
          idx,
          `已并入 ${g} 方案 ${add.length} 场${skipped > 0 ? ` · 跳过 ${skipped} 场(与现有行程重复或冲突)` : ""}(原有场次未动)${
            isNF ? " · 档位记为「未设」" : ""
          }`
        );
        paint();
      });
    return b;
  };

  /** 一个候选方案:可折叠头(方案 N + 标题 + 计数 + 并入 A/B)+ 场次清单 + 剔除 / 未纳入明细。
   *  多方案时各自独立 —— 采纳其中一个不影响其它,用户自己挑(见 PLAN-20260910162000)。 */
  const optionCard = (opt: AiPlanOption, idx: number): HTMLElement => {
    const card = el("div", idx > 0 ? "border-t border-line-faint" : "");
    const open = openOpts.has(idx);
    const head = el(
      "div",
      "flex items-center gap-[8px] flex-wrap px-3 py-[10px] cursor-pointer select-none hover:bg-hover"
    );
    head.dataset.ai = `opt-${idx}`;
    head.dataset.tip = open ? "收起该方案的场次清单" : "展开该方案的场次清单";
    head.appendChild(el("span", "text-10 text-muted shrink-0", open ? "▼" : "▶"));
    head.appendChild(
      el("span", "text-11 font-extrabold text-on-brand bg-ink-solid rounded px-[7px] py-px whitespace-nowrap", `方案 ${idx + 1}`)
    );
    head.appendChild(el("div", "text-13 font-bold text-ink min-w-0 truncate", opt.title || `候选 ${idx + 1}`));
    head.appendChild(
      el(
        "div",
        "text-12 text-muted whitespace-nowrap tabular-nums",
        `${opt.picks.length} 场${opt.drops.length ? ` · 未纳入 ${opt.drops.length} 部` : ""}${
          opt.rejected.length ? ` · 剔除 ${opt.rejected.length} 场` : ""
        }`
      )
    );
    const acts = el("div", "flex items-center gap-[8px] ml-auto");
    acts.append(mkAdopt("A", idx, opt.picks), mkAdopt("B", idx, opt.picks));
    head.appendChild(acts);
    head.addEventListener("click", (ev) => {
      // 「并入 A/B」自带点击语义 —— 别让点采纳顺手把方案折起来
      if ((ev.target as HTMLElement).closest("[data-ai-adopt]")) return;
      if (openOpts.has(idx)) openOpts.delete(idx);
      else openOpts.add(idx);
      paint();
    });
    card.appendChild(head);

    const note = adoptNotes.get(idx);
    if (note) card.appendChild(el("div", "px-3 pb-[8px] text-12 font-semibold text-ok leading-[1.6]", note));
    if (opt.note) card.appendChild(el("div", "px-3 pb-[8px] text-12 text-ink-2 leading-[1.6]", `模型说明:${opt.note}`));

    if (open) {
      const list = el("div", "px-2 pb-1 max-h-[320px] overflow-y-auto");
      if (opt.picks.length === 0) {
        list.appendChild(el("div", "text-13 text-muted py-[10px] px-2", "该方案没有可用场次(见下方原因)"));
      }
      for (const [date, picks] of groupByDate(opt.picks, (p) => p.show.date)) {
        const { label, weekday } = dateInfo(date);
        list.appendChild(el("div", "text-11 font-bold text-meta pt-[9px] pb-[2px] px-2", `${label} ${weekday}`));
        for (const pk of picks) list.appendChild(aiPickRow(pk, ctx));
      }
      card.appendChild(list);
      const rej = aiRejectSection(opt.rejected);
      if (rej) card.appendChild(rej);
      const dr = aiDropSection(opt.drops);
      if (dr) card.appendChild(dr);
    }
    return card;
  };

  const resultCard = (): HTMLElement => {
    const p = plan!;
    const box = el("div", "border border-line-faint rounded-12 bg-card overflow-hidden");
    const head = el("div", "flex items-center gap-[10px] flex-wrap px-3 py-[10px] bg-hover");
    head.appendChild(
      el(
        "div",
        "text-12 text-ink-2 flex-1 min-w-0",
        p.options.length > 1
          ? `AI 给出 ${p.options.length} 个候选方案(按你的优先级排序)· 挑一个点「并入 A/B」`
          : "AI 给出 1 个建议方案 · 点「并入 A/B」采用"
      )
    );
    box.appendChild(head);
    if (p.note) box.appendChild(el("div", "px-3 pt-[9px] text-12 text-ink-2 leading-[1.6]", `模型说明:${p.note}`));
    p.options.forEach((opt, idx) => box.appendChild(optionCard(opt, idx)));

    const rawWrap = el("div", "border-t border-line-faint px-3 py-[8px]");
    const rawBtn = el("button", BTN_MINI, showRaw ? "收起原始返回" : "查看原始返回");
    rawBtn.dataset.ai = "raw";
    rawBtn.dataset.tip = "模型返回的原文(排查解析失败 / 换模型时用)";
    rawBtn.addEventListener("click", () => {
      showRaw = !showRaw;
      paint();
    });
    rawWrap.appendChild(rawBtn);
    if (showRaw) {
      const pre = el("pre", "mt-[8px] max-h-[200px] overflow-auto rounded-8 bg-hover p-[10px] text-11 leading-[1.5] whitespace-pre-wrap break-all text-ink-2 m-0");
      pre.textContent = p.raw;
      rawWrap.appendChild(pre);
    }
    box.appendChild(rawWrap);
    return box;
  };

  const paint = (): void => {
    const { noFilmList: isNF } = wantedNow();
    const parts: HTMLElement[] = isNF ? [privacyBar(), modeBar()] : [privacyBar()];
    if (!aiReady(cfg) || editing) {
      parts.push(cfgForm());
    } else {
      // 「强制无片单」开关:仅当 tagged 非空时显示(已是「真·无片单」时不显示)
      const ft = forceToggleRow();
      if (ft) parts.push(ft);
      parts.push(readyBar(), dateBar(), promptArea(), runBar());
    }
    if (errText) parts.push(errBox());
    if (plan) parts.push(resultCard());
    wrap.replaceChildren(...parts);
  };

  const run = async (): Promise<void> => {
    if (running || selDates.size === 0) return; // 一天都没选 → 不送空清单给模型
    if (promptTa) {
      cfg = { ...cfg, userPrompt: promptTa.value }; // 以输入框现值落盘,不依赖 blur 时序
      saveAiCfg(cfg);
    }
    const { noFilmList: isNF } = wantedNow();
    const payload = buildNow(); // 每次按当前日期选择重算
    running = true;
    errText = "";
    plan = null;
    adopted.clear();
    adoptNotes.clear();
    openOpts.clear();
    openOpts.add(0);
    showRaw = false;
    ctl = new AbortController();
    paint();
    try {
      const raw = await callLLM(cfg, payload, ctl.signal, { noFilmList: isNF });
      plan = parseAiResult(raw, ctx.cat, sentFilmsOf(payload), transitMin);
    } catch (e) {
      if (!(e instanceof AiError && e.kind === "aborted")) errText = aiErrorText(e);
    } finally {
      running = false;
      ctl = null;
      paint();
    }
  };

  paint();
  return wrap;
}

/** AI 结果的「本地复检剔除」区 —— 模型给的场次里无效/重复/冲突的部分,必须明示(不静默吞) */
function aiRejectSection(rej: AiPlanReject[]): HTMLElement | null {
  if (!rej.length) return null;
  const wrap = el("div", "border-t border-line-faint px-3 py-[10px] grid gap-[6px]");
  wrap.appendChild(el("div", "text-11 font-bold text-conf", `本地复检剔除 ${rej.length} 场(模型建议不可用)`));
  const chips = el("div", "flex flex-wrap gap-[6px]");
  for (const r of rej) {
    const c = el("span", "inline-flex items-center gap-[5px] min-w-0 rounded-6 bg-card border border-line-faint px-[7px] py-[3px]");
    c.append(
      el("span", "text-11 font-bold text-faint tabular-nums shrink-0", r.code),
      el("span", "text-12 text-ink-2 truncate", r.why)
    );
    c.dataset.tip = `${r.code} — ${r.why}`;
    chips.appendChild(c);
  }
  wrap.appendChild(chips);
  return wrap;
}

/** AI 结果的「未纳入」区 —— 原因来自模型自述 + 本地补齐(「AI 未排入」),故不用 DROP_LABEL 的三分类 */
function aiDropSection(drops: AiPlanDrop[]): HTMLElement | null {
  if (!drops.length) return null;
  const wrap = el("div", "border-t border-line-faint px-3 py-[10px] grid gap-[7px]");
  wrap.appendChild(el("div", "text-11 font-bold text-meta", `未纳入 ${drops.length} 部`));
  const chips = el("div", "flex flex-wrap gap-[6px]");
  for (const d of drops) {
    const c = el("span", "inline-flex items-center gap-[5px] min-w-0 max-w-full rounded-6 bg-card border border-line-faint px-[7px] py-[3px]");
    c.appendChild(el("span", "text-12 text-ink shrink-0", d.zh));
    if (d.why) c.appendChild(el("span", "text-11 text-meta truncate", `· ${d.why}`));
    c.dataset.tip = d.why ? `${d.zh} — ${d.why}` : d.zh;
    chips.appendChild(c);
  }
  wrap.appendChild(chips);
  return wrap;
}

/** 紧凑行里的影院名 —— 走 `venues.json` 的短名(`legend.ts::venueShort`)。
 *  这些行都带 `truncate` 且列窄,全名会被裁成「Busan Cinema …」,同一影院各厅糊成一串。
 *  查不到场馆(未登记厅 / 旧 JSON)时回退 `venue_display` 全名。 */
function venueLabelOf(ctx: LibraryCtx, s: Screening): string {
  const v = ctx.cat.venueById.get(s.venue_id);
  return v ? venueShort(v) : s.venue_display;
}

/** 一场 AI 建议:左列「时间」深色半加粗(扫日程用),右列片名 + 档位 Tag + code / 影院(次级灰,第二行)。
 *  整行可点 → 跳到该场在时间轴上的位置(与影片库场次行同一个出口)。 */
function aiPickRow(p: AiPlanPick, ctx: LibraryCtx): HTMLElement {
  const row = el(
    "div",
    "grid grid-cols-[84px_minmax(0,1fr)] gap-[10px] items-start px-2 py-[7px] rounded-7 cursor-pointer hover:bg-hover"
  );
  row.dataset.tip = "跳到该场在时间轴上的位置";
  row.appendChild(
    el(
      "div",
      "tabular-nums whitespace-nowrap text-13 font-semibold text-ink pt-px",
      `${fmtMinRange(p.show.start_time, p.show.end_time)}`
    )
  );
  const main = el("div", "min-w-0 grid gap-[2px]");
  const top = el("div", "flex items-center gap-[6px] min-w-0");
  top.append(
    el("span", "text-13 font-semibold text-ink truncate", p.zh),
    priTag(p.priority, "shrink-0"),
    el("span", "ml-auto shrink-0 tabular-nums text-11 font-bold text-faint", p.show.code)
  );
  main.append(top, el("div", "text-12 text-meta truncate", venueLabelOf(ctx, p.show)));
  row.appendChild(main);
  row.addEventListener("click", () => ctx.onLocate(p.code));
  return row;
}
