// 红黑榜分享图(2026-09-22)—— 「分享文案」/「看片计划海报」之外的又一个出口。
//
// ★ 分层与 `poster.ts` 同口径:本文件 = **模型 + 几何 + 绘制**,import 期不碰 DOM,
//   可被 node 单测直接 import(所以日历 / 日期都靠注入,不读系统时钟)。
//   弹层 / 剪贴板 / 下载 = `components/RedBlackShareDialog.tsx`。
//
// ★ 三类内容,一次说清(用户 2026-09-22 定):
//   ① **总数榜 / 红榜 / 黑榜 各 TOP10** —— 判据**逐字复用页面那三个档位**(`redblack.ts::sortByCounts`),
//      不另立一套排名规则:分享图上看到的顺序必须与页面上点同档位时看到的一致。
//   ② **我贴过的** —— **不限条数**(贴了多少列多少),每行给「我贴的那一色 + 全站红黑数」。
//   ③ 底部署名:网站 + 作者。
//
// ★ 与 `poster.ts` 共用 `poster-brush.ts` 的配色 / 字体 / 圆角 / 超采样 / 品牌红条 ——
//   同一个应用出的两张分享图应当像一家人(§5 口径单一来源)。

import type { FilmNode } from "./app/model";
import { EDITION } from "./edition";
import {
  ACCENT_H,
  COLORS as C,
  FOOTER_H,
  PAD,
  POSTER_W,
  SCALE,
  SCALE_DOWN_H,
  drawAccentBars,
  drawRule,
  fitText,
  posterFont as font,
  roundRectPath,
} from "./poster-brush";
import { blobPath } from "./sticker-shape";
import {
  boardFilms,
  sortByCounts,
  sortMetric,
  type CrowdCounts,
  type SortMode,
  type StickerBoard,
} from "./redblack";

/** 每个榜取前几名 */
export const TOP_N = 10;

/** 网站署名 —— 与页面页脚同源(`App.tsx` 的页脚也用这个域名)。 */
export const SITE = "biff.lcandy.co";
/** 作者署名 —— 与页面页脚**逐字一致**(`App.tsx`:「by @gaaiyeoi 和 by @lcandy2」)。
 *  ⚠ 两个 handle 都是**GitHub 账号名**(不是提交者显示名 `citron`):图片上没有链接,
 *    印一个搜不到的显示名等于没署名。改这里必须同步 `App.tsx` 的页脚。 */
export const CREDIT_BY = "by @gaaiyeoi 和 by @lcandy2";

export interface RbPosterRow {
  key: string;
  /** 片名(中文优先,与页面卡片一致) */
  title: string;
  /** 英文名,可能为空 */
  en: string;
  /** 全站红 / 黑票数 */
  red: number;
  black: number;
  /** 我贴的那一色;没贴过 = null */
  mine: "red" | "black" | null;
}

export interface RbPosterBoard {
  mode: SortMode;
  /** 「总数榜」/「红榜」/「黑榜」 */
  label: string;
  /** 口径说明,例如「按红贴纸数」 */
  hint: string;
  rows: RbPosterRow[];
}

export interface RbPosterModel {
  eyebrow: string;
  title: string;
  subtitle: string;
  /** 全站聚合(与页面 hero 的大字同一份数字) */
  site: { total: number; red: number; black: number; films: number };
  /** 我的(与页面 hero 那行小字同一份数字) */
  mine: { marked: number; placed: number; quota: number };
  boards: RbPosterBoard[];
  /** 我贴过的 —— 不限条数 */
  myTitle: string;
  myHint: string;
  myRows: RbPosterRow[];
  credit: { site: string; by: string };
}

export interface RbPosterInput {
  films: readonly FilmNode[];
  crowd: CrowdCounts;
  board: StickerBoard;
  /** 页面 hero 那份「全站」统计 —— **传进来而不是重算**,分享图与页面才会是同一些数字 */
  site: { total: number; red: number; black: number };
  /** 页面 hero 那份「我的」统计 */
  mine: { marked: number; placed: number; quota: number };
  /** 出图日期 —— **注入**而不是读时钟:否则单测断不了文案 */
  today: Date;
}

const BOARDS: ReadonlyArray<{ mode: SortMode; label: string; hint: string }> = [
  { mode: "total", label: "总数榜", hint: "按红 + 黑贴纸数" },
  { mode: "red", label: "红榜", hint: "按红贴纸数" },
  { mode: "black", label: "黑榜", hint: "按黑贴纸数" },
];

function isoDate(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function toRow(film: FilmNode, crowd: CrowdCounts, board: StickerBoard): RbPosterRow {
  const c = crowd.get(film.key);
  return {
    key: film.key,
    title: film.zh,
    // ⚠ 与页面卡片同一条**展示**规则(`RbCard`):中英名相同时不重复画一遍 ——
    //   排期里只有英文名的片(「In Winter」这类)否则会上下两行一模一样
    en: film.en && film.en !== film.zh ? film.en : "",
    red: c?.red ?? 0,
    black: c?.black ?? 0,
    // 一部只有一枚贴纸(`MAX_PER_FILM = 1`),取第一枚就是「我贴的那一色」
    mine: board.get(film.key)?.[0]?.type ?? null,
  };
}

/**
 * 构建分享图模型。
 *
 * ⚠ 两条**展示**规则(不是排名规则,故不写在 `sortByCounts` 里):
 *  ① **该榜指标为 0 的片不进该榜** —— 黑榜里列一堆「黑 0」毫无意义;票不够 10 部时榜就短一些。
 *     ⚠ 按**每榜各自的指标**筛(`redblack.ts::sortMetric`),不是笼统的「有没有票」:
 *       只看「总数大于 0」的话,一部 3 红 0 黑 的片会照样出现在黑榜里。
 *  ② 三榜都取**前 `TOP_N`**;「我贴过的」那一节**不截断**。
 */
export function buildRbPosterModel(input: RbPosterInput): RbPosterModel {
  const { films, crowd, board, site, mine, today } = input;
  const candidates = boardFilms(films);

  const boards: RbPosterBoard[] = BOARDS.map((entry) => {
    const rows = sortByCounts(
      candidates.filter((film) => sortMetric(crowd.get(film.key), entry.mode) > 0),
      crowd,
      entry.mode,
    )
      .slice(0, TOP_N)
      .map((film) => toRow(film, crowd, board));
    return { ...entry, rows };
  }).filter((entry) => entry.rows.length > 0);

  // 我贴过的:按**全站总数**降序(与页面默认档同口径),并列按目录序 —— `sortByCounts` 自带稳定序
  const myRows = sortByCounts(
    candidates.filter((film) => (board.get(film.key)?.length ?? 0) > 0),
    crowd,
    "total",
  ).map((film) => toRow(film, crowd, board));

  return {
    eyebrow: `${EDITION.replace("-", " ").toUpperCase()} · 观影红黑榜`,
    title: "红黑榜",
    subtitle: `${isoDate(today)} · ${candidates.length} 部有排期的影片`,
    site: { ...site, films: candidates.length },
    mine,
    boards,
    myTitle: `我贴过的 ${myRows.length} 部`,
    myHint: "圆点是我贴的那一色 · 右侧是全站红黑数",
    myRows,
    credit: { site: SITE, by: CREDIT_BY },
  };
}

/* ---------------- 几何 ---------------- */

const HEADER_H = 396;
const SECTION_H = 96;
const ROW_H = 76;
/** 三榜的空档(「我贴过的」那一节之前留白多一点) */
const BLOCK_GAP = 32;
/** 一行右侧那条红黑比例条的尺寸 */
const BAR_W = 208;
const BAR_H = 8;
/** 数值列(右侧)的宽度 —— 比例条与文字都靠它右对齐 */
const VALUE_W = 232;

/** 分享图总高(逻辑像素,含上下品牌红条)—— 行数决定高度,故必须与 `drawRbPoster` 同源。
 *  ⚠ 两处各算一份必然出现「算出来 3000 高、实际画了 3200」,而画布是按它设的 →
 *    多出来的内容**被裁掉且不报错**(最难查的一类),所以只写这一个函数。 */
export function rbPosterHeight(model: RbPosterModel): number {
  let h = ACCENT_H + HEADER_H;
  for (const b of model.boards) h += BLOCK_GAP + SECTION_H + b.rows.length * ROW_H;
  if (model.myRows.length) h += BLOCK_GAP + SECTION_H + model.myRows.length * ROW_H;
  return h + FOOTER_H + ACCENT_H;
}

/* ---------------- 绘制 ---------------- */

/** 右侧的「红 N · 黑 N」—— 分段上色,故逐段画(整串一个颜色就丢了红黑的可读性)。 */
function drawCounts(ctx: CanvasRenderingContext2D, row: RbPosterRow, right: number, baseline: number): void {
  ctx.font = font(24, 600);
  const segs: Array<[string, string]> = [
    ["红 ", C.muted],
    [`${row.red}`, C.red2],
    [" · 黑 ", C.muted],
    [`${row.black}`, C.ink2],
  ];
  const total = segs.reduce((w, [t]) => w + ctx.measureText(t).width, 0);
  let x = right - total;
  for (const [text, color] of segs) {
    ctx.fillStyle = color;
    ctx.fillText(text, x, baseline);
    x += ctx.measureText(text).width;
  }
}

/** 右侧那条比例条:红 / 黑按票数占比切分。全黑或全红时就是一条纯色。 */
function drawRatioBar(ctx: CanvasRenderingContext2D, row: RbPosterRow, right: number, top: number): void {
  const sum = row.red + row.black;
  if (sum <= 0) return;
  const left = right - BAR_W;
  const redW = Math.round((row.red / sum) * BAR_W);
  ctx.fillStyle = C.red;
  roundRectPath(ctx, left, top, BAR_W, BAR_H, BAR_H / 2);
  ctx.fill();
  if (redW < BAR_W) {
    // 黑的那段从右往左贴,保证整条仍是圆角矩形
    ctx.save();
    roundRectPath(ctx, left, top, BAR_W, BAR_H, BAR_H / 2);
    ctx.clip();
    ctx.fillStyle = C.ink2;
    ctx.fillRect(left + redW, top, BAR_W - redW, BAR_H);
    ctx.restore();
  }
}

/** 一行:排名 / 我在这一部贴的那一色 + 片名(中英)+ 右侧全站红黑数 + 比例条。 */
function drawRow(
  ctx: CanvasRenderingContext2D,
  row: RbPosterRow,
  rank: number,
  top: number,
  withMine: boolean,
): void {
  const right = POSTER_W - PAD;
  const valueLeft = right - VALUE_W;

  // 左侧标记:榜内是名次;「我贴过的」那一节换成我贴的那一色小贴纸(用户口径)
  if (withMine && row.mine) {
    const size = 24;
    const isRed = row.mine === "red";
    ctx.save();
    ctx.translate(PAD, top + ROW_H / 2 - size / 2);
    ctx.fillStyle = isRed ? C.red : C.stickerBlack;
    blobPath(ctx, size);
    ctx.fill();
    if (!isRed) {
      // 深底上的黑贴纸必须靠一圈亮边才认得出(见 `poster-brush.ts::COLORS.stickerBlack`)
      ctx.strokeStyle = C.ink2;
      ctx.lineWidth = 1.5;
      blobPath(ctx, size);
      ctx.stroke();
    }
    ctx.restore();
  } else {
    ctx.font = font(28, 700);
    ctx.fillStyle = rank <= 3 ? C.red2 : C.muted;
    ctx.fillText(`${rank}`.padStart(2, "0"), PAD, top + ROW_H / 2 + 10);
  }

  const titleX = PAD + 64;
  const titleW = valueLeft - titleX - 24;
  let ty = top + 34;
  ctx.font = font(29, 600);
  ctx.fillStyle = C.ink;
  ctx.fillText(fitText(ctx, row.title, titleW), titleX, ty);
  if (row.en) {
    ty += 26;
    ctx.font = font(20, 400);
    ctx.fillStyle = C.muted;
    ctx.fillText(fitText(ctx, row.en, titleW), titleX, ty);
  }

  drawCounts(ctx, row, right, top + 34);
  drawRatioBar(ctx, row, right, top + 50);
}

/** 分节头:左侧一小段品牌红竖条 + 标题 + 口径说明。 */
function drawSection(
  ctx: CanvasRenderingContext2D,
  label: string,
  hint: string,
  top: number,
): void {
  ctx.fillStyle = C.red;
  roundRectPath(ctx, PAD, top + 22, 6, 30, 3);
  ctx.fill();
  ctx.font = font(31, 700);
  ctx.fillStyle = C.ink;
  ctx.fillText(label, PAD + 20, top + 48);
  if (hint) {
    const w = ctx.measureText(label).width; // ⚠ 量完再换字体(字重变了测宽也会变)
    ctx.font = font(22, 500);
    ctx.fillStyle = C.muted;
    ctx.fillText(hint, PAD + 20 + w + 14, top + 48);
  }
}

/** 头部:小字届次 / 大标题 / 副标题 / 全站三格大字 / 我的一行小字。 */
function drawHeader(ctx: CanvasRenderingContext2D, model: RbPosterModel): void {
  const maxTextW = POSTER_W - PAD * 2;
  const y = ACCENT_H;

  ctx.font = font(19, 600);
  ctx.fillStyle = C.muted;
  ctx.fillText(model.eyebrow, PAD, y + 52);

  ctx.font = font(56, 700);
  ctx.fillStyle = C.ink;
  ctx.fillText(fitText(ctx, model.title, maxTextW), PAD, y + 130);

  ctx.font = font(24, 500);
  ctx.fillStyle = C.ink2;
  ctx.fillText(fitText(ctx, model.subtitle, maxTextW), PAD, y + 180);

  drawRule(ctx, y + 214, maxTextW);

  // 全站三格:标签在上、数字在下(数字用大字号,一眼能读)
  const cols: Array<[string, number, string]> = [
    ["全站贴纸", model.site.total, C.ink],
    ["红", model.site.red, C.red2],
    ["黑", model.site.black, C.ink2],
  ];
  cols.forEach(([label, value, color], i) => {
    const x = PAD + i * 300;
    ctx.font = font(19, 600);
    ctx.fillStyle = C.muted;
    ctx.fillText(label, x, y + 262);
    ctx.font = font(46, 700);
    ctx.fillStyle = color;
    ctx.fillText(`${value}`, x, y + 320);
  });

  ctx.font = font(22, 500);
  ctx.fillStyle = C.muted;
  ctx.fillText(
    `我的：标记看过 ${model.mine.marked} 部 · 已贴 ${model.mine.placed} 枚 · 还能贴 ${model.mine.quota} 枚`,
    PAD,
    y + 366,
  );
}

/** 把模型画到给定画布上(画布尺寸由本函数按模型设好,调用方不必预先设)。 */
export function drawRbPoster(canvas: HTMLCanvasElement, model: RbPosterModel): void {
  const h = rbPosterHeight(model);
  const scale = h > SCALE_DOWN_H ? 1 : SCALE;
  // ⚠ 写 width/height 会**清空画布并重置 transform**,两者必须成对
  canvas.width = POSTER_W * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(scale, scale);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, POSTER_W, h);
  drawAccentBars(ctx, POSTER_W, h);

  drawHeader(ctx, model);

  let y = ACCENT_H + HEADER_H;
  for (const b of model.boards) {
    y += BLOCK_GAP;
    drawSection(ctx, b.label, b.hint, y);
    y += SECTION_H;
    b.rows.forEach((row, i) => {
      drawRow(ctx, row, i + 1, y, false);
      y += ROW_H;
    });
  }

  if (model.myRows.length) {
    y += BLOCK_GAP;
    drawSection(ctx, model.myTitle, model.myHint, y);
    y += SECTION_H;
    model.myRows.forEach((row, i) => {
      drawRow(ctx, row, i + 1, y, true);
      y += ROW_H;
    });
  }

  // 空榜:一句友好的话,而不是三个空节 + 一列空白
  if (!model.boards.length && !model.myRows.length) {
    ctx.font = font(26, 500);
    ctx.fillStyle = C.muted;
    ctx.fillText("榜上还没有贴纸 —— 去「看过」的片子上贴一枚红或黑吧。", PAD, y + 96);
  }

  // 页脚(绝对定位:内容再长也不会把它顶出画面)
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
