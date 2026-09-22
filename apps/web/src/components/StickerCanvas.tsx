/**
 * 只读贴纸的**画布层**(2026-09-22,PLAN-20260922145815)。
 *
 * 为什么把「别人的贴纸」从 DOM 挪到 canvas:一部片可能被上百人贴过,全画出来就是上百个
 * 绝对定位 + 歪斜 + 阴影的节点;榜单有近 300 张卡 —— 成本随总票数线性上涨。
 * canvas 让**一张卡只占一个节点**,票数再多也只是多几次 `drawImage`。
 *
 * 三条硬约束:
 *  ① `pointer-events: none` —— 拖拽落点靠 `document.elementFromPoint().closest("[data-rb-canvas]")`
 *     (`RedBlackPage.tsx::canvasAt`),画布挡住就拖不进这张卡;而「能不能拖」正是群点与我贴的
 *     那一枚**唯一**的区别(用户 2026-09-22 口径)。
 *  ② 视口外**释放 backing store**(`width = height = 0`):一张卡约 1MB(含 dpr 放大),
 *     299 张全留就是几百 MB 显存。滚动回来时 `needsRedraw(null, …)` 会重新画。
 *  ③ 绘制走 `sticker-canvas-guard`:**参数按值没变就不重画** —— 滚动时父级有一堆与本卡无关的
 *     re-render(顶部统计、票数重拉),每次都 `clearRect` 全量重画就是白烧的长任务。
 *
 * 「我贴的那一枚」**仍然留在 DOM**(`RedBlackPage.tsx::RbCard` 里那个 `.rb-dot`):它要能拖,
 * 画布只承担只读点。DOM 贴纸渲染在画布之后,所以自然压在群点上面。
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { countsSignature, crowdStickers, tiltOf, type StickerCounts } from "../redblack";
import { needsRedraw, type DrawKey } from "../sticker-canvas-guard";
import { STICKER_SIZE, stickerSprite } from "../sticker-sprite";
import { useDpr } from "../use-dpr";

interface StickerCanvasProps {
  /** 影片 key —— 落点由 `spotOf(影片key#crowd-i)` 确定性推导,与原来的 DOM 版逐字一致 */
  filmKey: string;
  /** 要画的**别人的**票数(已减掉我自己那一枚) */
  counts: StickerCounts;
  /** 是否在视口附近。false 时不上屏、也把 backing store 释放掉 */
  inView: boolean;
}

export function StickerCanvas({ filmKey, counts, inView }: StickerCanvasProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  // 上一次**真正画下去**时用的参数(见 sticker-canvas-guard)
  const lastRef = useRef<DrawKey | null>(null);
  // CSS 像素尺寸:由 ResizeObserver 单独驱动 —— 不要在绘制里「读 getBoundingClientRect() → 写 canvas.width」
  // 交替,那会让浏览器反复强制布局
  const [box, setBox] = useState({ width: 0, height: 0 });
  const dpr = useDpr();

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // 画在 layout effect 里:paint 之前画完,不会看到「先空白再出贴纸」的一闪
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (!inView || box.width <= 0 || box.height <= 0) {
      // 释放显存。⚠ 同时清掉守护键:回来时尺寸可能一模一样,不清就不会重画
      if (canvas.width !== 0) canvas.width = 0;
      if (canvas.height !== 0) canvas.height = 0;
      lastRef.current = null;
      return;
    }
    const key: DrawKey = {
      filmKey,
      dpr,
      width: Math.max(1, Math.round(box.width * dpr)),
      height: Math.max(1, Math.round(box.height * dpr)),
      counts: countsSignature(counts),
    };
    if (!needsRedraw(lastRef.current, key)) return;
    lastRef.current = paint(canvas, filmKey, counts, box.width, box.height, dpr);
  }, [inView, box, dpr, filmKey, counts]);

  return <canvas ref={ref} className="rb-ink" aria-hidden="true" />;
}

/** 真的画一遍,返回这次用的守护键(与实际写进画布的尺寸一致)。 */
function paint(
  canvas: HTMLCanvasElement,
  filmKey: string,
  counts: StickerCounts,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): DrawKey {
  const width = Math.max(1, Math.round(cssWidth * dpr));
  const height = Math.max(1, Math.round(cssHeight * dpr));
  // ⚠ 写 width/height 会**清空画布并重置 transform**,所以尺寸与变换必须一起设;
  //   只在真的变了才写,避免每帧清一次画布
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { filmKey, dpr, width, height, counts: countsSignature(counts) };

  // 幂等:用 setTransform 而不是累加的 scale()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  // 贴纸坐标是**中心**的百分比(与 DOM 版的 translate(-50%,-50%) 同一口径)
  const half = STICKER_SIZE / 2;
  for (const sticker of crowdStickers(filmKey, counts)) {
    const sprite = stickerSprite(sticker.type, dpr);
    ctx.save();
    ctx.translate(sticker.posX * cssWidth, sticker.posY * cssHeight);
    ctx.rotate((tiltOf(sticker.id) * Math.PI) / 180);
    ctx.drawImage(
      sprite.canvas,
      -half - sprite.pad,
      -half - sprite.pad,
      sprite.canvas.width / dpr,
      sprite.canvas.height / dpr,
    );
    ctx.restore();
  }
  return { filmKey, dpr, width, height, counts: countsSignature(counts) };
}
