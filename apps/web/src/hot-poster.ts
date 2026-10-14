// 「热门榜」分享图（2026-10-14，`PLAN-20261014150805` 修订 2）—— 与「行程图」(`poster.ts`)、
// 「红黑榜分享图」(`redblack-poster.ts`)并列的第三个分享图出口。
//
// ★ 它为什么**不是**红黑榜那张图的第二份：两者的口径与版式都不同 ——
//   · 红黑榜图 = 两榜各 TOP N，**按评分**排，行里画的是**票**（一枚一枚贴纸）；
//   · 本图 = 一个榜，**按想看人数**排，行里画的是**热度**（数字 + 条形）+ 一枚口碑角标。
//   12,092 个「想看」画不成贴纸（那是 591 票才成立的画法），所以这里换成条形。
//
// ★ **竖版 3:4、不拉长**（用户 2026-10-14:「现在的 是不是不适合手机阅读」）：
//   根因是长宽比而不是清晰度，故这张图**单屏封顶** —— `HOT_POSTER_ROWS = 8` 行时正好
//   1080 × 1440（几何见 `hotPosterHeight`）；行数少了图就同比变矮，**不留白**。
//
// ★ 分层与另两张图同口径：本文件 = **模型 + 几何 + 绘制**，import 期不碰 DOM，
//   可被 node 单测直接 import。弹层 / 剪贴板 / 下载 = `components/HotBoardShareDialog.tsx`。
//
// ⚠ 刻意**不引 ECharts**（`components/charts/bars.tsx` 那条链 gzip 193.9 KB）：
//   条形是这一张 canvas 上的两条 `fillRect`，不需要图表库（理由与数字见 `hot-board.ts` 文件头）。

import { EDITION } from "./edition";
import type { HotRow } from "./hot-board";
import { hotTotals } from "./hot-board";
import {
  ACCENT_H,
  COLORS as C,
  CREDIT_BY,
  FOOTER_H,
  PAD,
  POSTER_W,
  SITE,
  drawAccentBars,
  drawRule,
  fitText,
  posterFont as font,
  posterPixels,
  roundRectPath,
} from "./poster-brush";
import { dateInfo } from "./util";

/** 单屏行数 —— **8 行正好拼出 1080 × 1440（3:4）**：10 + 236 + 8×135 + 104 + 10 = 1440。
 *  ⚠ 改行高 / 头高必须同步看一眼这个等式，否则默认出图就不再是那个比例。 */
export const HOT_POSTER_ROWS = 8;

/** 一行的高度 */
const ROW_H = 135;
/** 头部高度（届次 + 大标题 + 副标题 + 一条分隔线） */
const HEADER_H = 236;
/** 一行都没有时那块空白的高度（画一句说明） */
const EMPTY_H = 160;

/* 行内横向分区（都是**左对齐的起点**，评分那一列例外 —— 它右对齐到 `SCORE_RIGHT`） */
const RANK_X = PAD;
const THUMB_X = 140;
const THUMB_W = 74;
const THUMB_H = 111;
const THUMB_R = 10;
const TITLE_X = 236;
/** 片名可用宽度 —— 右边界让给「想看人数」那一列 */
const TITLE_W = 400;
const WANT_X = 660;
/** 评分列右对齐到这里 */
const SCORE_RIGHT = POSTER_W - PAD;
/** 条形的高度（片名下方那根） */
const BAR_H = 10;
const BAR_W = 400;

/** 分享图上的一行 —— 只看必要字段（`HotRow` 是页面用的形状，这里不重复它的全部字段）。 */
export interface HotPosterRow {
  key: string;
  title: string;
  /** 想看人数（本图的排序依据，也是行里的主角） */
  want: number;
  /** 口碑评分（与页面角标**同一处实现**`redblack.ts::scoreOf`）；一票没有 = `null` */
  score: number | null;
  red: number;
  black: number;
  /** 影片海报相对路径 —— 目录里有才带（缺图走占位块，**不编路径**） */
  poster?: string;
}

export interface HotPosterModel {
  eyebrow: string;
  title: string;
  subtitle: string;
  rows: HotPosterRow[];
  /** 一行都没有时画这一句 */
  emptyText: string;
  credit: { site: string; by: string };
  /** 头部 / 尾部画不画 —— **几何**（`hotPosterHeight`）与绘制都读它，不能各存一份 */
  showHeader: boolean;
  showFooter: boolean;
}

export interface HotPosterInput {
  /** 榜单行 —— **必须已按想看降序**（`hot-board.ts::buildHotRows` 的输出），
   *  也已经按单元切好（切分与展示名由调用方给，见 `unitName`）。 */
  rows: readonly HotRow[];
  /** 这一张图讲的**单元展示名**（`HotRow.unitName`）；空串 = 全部单元（全站）。 */
  unitName?: string;
  /** 取前几名。**不传 = `HOT_POSTER_ROWS`（8，正合 3:4）**；`<= 0` = 不截断（会拉长，慎用）。 */
  topN?: number;
  /** 画不画头部。**不传 = 画**。 */
  showHeader?: boolean;
  /** 画不画尾部署名。**不传 = 画**。 */
  showFooter?: boolean;
  /** 出图日期 —— **注入**而不是读时钟，否则单测断不了文案 */
  today: Date;
}

function isoDate(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * 构建分享图模型。
 *
 * ⚠ 头部**没有**那组大数字格（红黑榜图有）：本图封顶 8 行、整个高度只有 1440，
 *   与其挤一格数字，不如把那三个数写进副标题 —— 信息一条不少，版面还留得住。
 */
export function buildHotPosterModel(input: HotPosterInput): HotPosterModel {
  const unitName = (input.unitName ?? "").trim();
  const topN = input.topN ?? HOT_POSTER_ROWS;
  const showHeader = input.showHeader ?? true;
  const showFooter = input.showFooter ?? true;
  const candidates = input.rows;
  // ⚠ `topN <= 0` = 不截断；不足这么多行时自然「全列」，不补零
  const shown = topN > 0 ? candidates.slice(0, topN) : candidates;
  // ⚠ 头部的三个数说的是**整个范围**（切分后的全部行），不是「印出来的那几行」：
  //   它要与页面上那个 hero 说的是同一件事（那边也没截断）。拿 `shown` 去汇总的话，
  //   选「前 5」时头部会印出「全站 5 部」—— 把「只印 5 行」说成「全站只有 5 部」。
  const totals = hotTotals(candidates);
  const scope = unitName || "全站";
  return {
    eyebrow: `${EDITION.replace("-", " ").toUpperCase()} · 热度 × 口碑`,
    title: unitName ? `${unitName} 热门榜` : "热门榜",
    // 日期走全站唯一口径（`OCT 14`），与另两张分享图同一写法
    subtitle: `${dateInfo(isoDate(input.today)).label} · ${scope} ${totals.films} 部 · ${totals.want.toLocaleString("zh-CN")} 人想看 · ${totals.votes} 枚贴纸`,
    rows: shown.map((row) => ({
      key: row.key,
      title: row.title,
      want: row.want,
      score: row.score,
      red: row.red,
      black: row.black,
      poster: row.poster,
    })),
    emptyText: unitName
      ? `${unitName} 这个单元还没有人标记想看 —— 换个单元试试。`
      : "还没有人标记想看 —— 去影片页点一下「想看」吧。",
    credit: { site: SITE, by: CREDIT_BY },
    showHeader,
    showFooter,
  };
}

/** 分享图总高（逻辑像素）—— 行数 / 头尾开关直接决定高度。
 *  ⚠ 只写这一个函数：`drawHotPoster` 按它设画布，两处各算一份必然出现
 *    「算出来 1440 高、实际画了 1600」，而多出来的内容**被裁掉且不报错**。 */
export function hotPosterHeight(model: HotPosterModel): number {
  const body = model.rows.length ? model.rows.length * ROW_H : EMPTY_H;
  return (
    ACCENT_H +
    (model.showHeader ? HEADER_H : 0) +
    body +
    (model.showFooter ? FOOTER_H : 0) +
    ACCENT_H
  );
}

/* ---------------- 绘制 ---------------- */

/** 行内海报缩略图（最左那一列）—— 与另两张分享图同一份加载语义（缺图 / 失败即静默跳过）。 */
function drawThumb(
  ctx: CanvasRenderingContext2D,
  row: HotPosterRow,
  top: number,
  images: ReadonlyMap<string, HTMLImageElement>,
): void {
  const y = top + (ROW_H - THUMB_H) / 2;
  const img = row.poster ? images.get(row.poster) : undefined;
  if (img) {
    ctx.save();
    roundRectPath(ctx, THUMB_X, y, THUMB_W, THUMB_H, THUMB_R);
    ctx.clip();
    ctx.drawImage(img, THUMB_X, y, THUMB_W, THUMB_H);
    ctx.restore();
    return;
  }
  // 占位块 + 片名首字（纯色空块读起来像 bug，首字足以认出是哪一部）
  ctx.fillStyle = C.card;
  roundRectPath(ctx, THUMB_X, y, THUMB_W, THUMB_H, THUMB_R);
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.stroke();
  const head = row.title.trim().charAt(0);
  if (head) {
    ctx.font = font(24, 700);
    ctx.fillStyle = C.muted;
    ctx.textAlign = "center";
    ctx.fillText(head, THUMB_X + THUMB_W / 2, y + THUMB_H / 2 + 8);
    ctx.textAlign = "left";
  }
}

/** 一行：名次 · 海报 · 片名 + 热度条 · 想看人数 · 口碑角标。 */
function drawRow(
  ctx: CanvasRenderingContext2D,
  row: HotPosterRow,
  rank: number,
  top: number,
  peak: number,
  images: ReadonlyMap<string, HTMLImageElement>,
): void {
  // 行与行之间的细分隔线（第一行不画：它上面就是头部那条 rule）
  if (rank > 1) {
    ctx.fillStyle = C.line;
    ctx.fillRect(PAD, top, POSTER_W - PAD * 2, 1);
  }

  ctx.font = font(40, 700);
  ctx.fillStyle = rank <= 3 ? C.red2 : C.muted;
  ctx.fillText(`${rank}`.padStart(2, "0"), RANK_X, top + 82);

  ctx.font = font(33, 600);
  ctx.fillStyle = C.ink;
  ctx.fillText(fitText(ctx, row.title, TITLE_W), TITLE_X, top + 60);

  // 热度条：宽度按**榜首**归一 —— 它只回答「相对第一名多大」，绝对值在右边那串数里
  const ratio = peak > 0 ? Math.max(0.02, Math.min(1, row.want / peak)) : 0;
  ctx.fillStyle = C.card;
  roundRectPath(ctx, TITLE_X, top + 78, BAR_W, BAR_H, BAR_H / 2);
  ctx.fill();
  if (ratio > 0) {
    ctx.fillStyle = C.red;
    roundRectPath(ctx, TITLE_X, top + 78, Math.max(BAR_H, BAR_W * ratio), BAR_H, BAR_H / 2);
    ctx.fill();
  }

  // 想看人数：数字大、后缀小（读完一眼是数字，不是被「人想看」这三个字挡住）
  ctx.font = font(38, 700);
  ctx.fillStyle = C.ink;
  const want = row.want.toLocaleString("zh-CN");
  ctx.fillText(want, WANT_X, top + 68);
  const wantW = ctx.measureText(want).width;
  ctx.font = font(20, 500);
  ctx.fillStyle = C.muted;
  ctx.fillText(" 人想看", WANT_X + wantW, top + 68);

  // 口碑角标：评分与红黑数一起给 —— 只给评分的话，读的人看不出它由多少票算出来
  ctx.textAlign = "right";
  ctx.font = font(38, 700);
  ctx.fillStyle = row.score === null ? C.muted : C.note;
  ctx.fillText(row.score === null ? "—" : `${row.score} 分`, SCORE_RIGHT, top + 64);
  ctx.font = font(20, 500);
  ctx.fillStyle = C.muted;
  ctx.fillText(`红 ${row.red} · 黑 ${row.black}`, SCORE_RIGHT, top + 98);
  ctx.textAlign = "left";

  drawThumb(ctx, row, top, images);
}

/** 头部：届次 +（右对齐）署名 + 大标题 + 副标题 + 一条分隔线。 */
function drawHeader(ctx: CanvasRenderingContext2D, model: HotPosterModel): void {
  const maxTextW = POSTER_W - PAD * 2;
  const y = ACCENT_H;

  ctx.font = font(19, 600);
  ctx.fillStyle = C.muted;
  ctx.fillText(model.eyebrow, PAD, y + 52);

  // 署名**头部也来一处**（与红黑榜图同一手法）：长图被截一半转发时，底部那行常常跟着丢掉
  ctx.textAlign = "right";
  ctx.font = font(19, 500);
  ctx.fillStyle = C.muted;
  ctx.fillText(model.credit.by, POSTER_W - PAD, y + 52);
  ctx.textAlign = "left";

  ctx.font = font(56, 700);
  ctx.fillStyle = C.ink;
  ctx.fillText(fitText(ctx, model.title, maxTextW), PAD, y + 126);

  ctx.font = font(24, 500);
  ctx.fillStyle = C.ink2;
  ctx.fillText(fitText(ctx, model.subtitle, maxTextW), PAD, y + 172);

  drawRule(ctx, y + 200, maxTextW);
}

/** 把模型画到给定画布上（画布尺寸由本函数按模型设好，调用方不必预先设）。 */
export function drawHotPoster(
  canvas: HTMLCanvasElement,
  model: HotPosterModel,
  images: ReadonlyMap<string, HTMLImageElement>,
): void {
  const h = hotPosterHeight(model);
  const px = posterPixels(POSTER_W, h);
  // ⚠ 写 width/height 会**清空画布并重置 transform**，两者必须成对
  canvas.width = px.width;
  canvas.height = px.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  // ⚠ 变换用「物理像素 / 逻辑尺寸」而不是那个浮点倍率：画布尺寸是取过整的，直接用倍率
  //    会在右下角留下一条不足 1px 的透明缝（深底图上就是一条亮线）
  ctx.scale(px.width / POSTER_W, px.height / h);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, POSTER_W, h);
  drawAccentBars(ctx, POSTER_W, h);

  if (model.showHeader) drawHeader(ctx, model);

  let y = ACCENT_H + (model.showHeader ? HEADER_H : 0);
  if (model.rows.length) {
    const peak = model.rows[0].want;
    model.rows.forEach((row, i) => {
      drawRow(ctx, row, i + 1, y, peak, images);
      y += ROW_H;
    });
  } else {
    ctx.font = font(26, 500);
    ctx.fillStyle = C.muted;
    ctx.fillText(model.emptyText, PAD, y + 96);
  }

  // 页脚（绝对定位：内容再长也不会把它顶出画面）
  if (model.showFooter) {
    const footTop = h - ACCENT_H - FOOTER_H;
    drawRule(ctx, footTop + 24, POSTER_W - PAD * 2);
    ctx.textAlign = "center";
    ctx.font = font(24, 600);
    ctx.fillStyle = C.ink2;
    ctx.fillText(model.credit.site, POSTER_W / 2, footTop + 62);
    ctx.font = font(20, 400);
    ctx.fillStyle = C.muted;
    ctx.fillText(model.credit.by, POSTER_W / 2, footTop + 90);
    ctx.textAlign = "left";
  }
}
