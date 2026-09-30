/**
 * 「换一款皮肤」的**左轮式环形滚轮**（2026-09-29，PLAN-20260929195500）。
 *
 * 它是什么：鼠标悬停到**自己贴的那一枚**上时，那枚贴纸周围弹出一圈 5 个节点（每 72° 一个），
 * 悬停节点**实时预览**（贴纸本体跟着换款），点选落定。键盘与触屏有等价入口（见调用方）。
 *
 * ## 为什么必须 portal 到 `document.body`（两条都是硬约束，不是偏好）
 *  ① `.rb-canvas` 是 `overflow: hidden`（贴纸本来就允许超出被裁掉），轮盘挂在里面会被裁；
 *  ② 想改用 `position: fixed` 躲开裁切**也不行** —— `.rb-card` 上有 `contain: content`
 *     （含 `contain: paint`），它会让**卡片自己**成为 fixed 后代的包含块，fixed 照样被圈在卡里。
 *  挂到 body 之后还白拿两件事：轮盘不在 `.rb-dot` 里、也不在卡片里，所以 E2E 那两条
 *  「贴纸里只有 5 个节点」「贴纸里没有任何浮层」的判据都不用改。
 *
 * ## 为什么**只有一种**渲染形态（没有「贴边时改浮层」那第二种）
 * 因为悬浮层就是它唯一的存在方式（理由见上）。原计划里的「贴边改浮层」是在假设
 * 「默认画在画布内」——那个假设不成立，所以也就不需要两套定位与两套样式。
 *
 * ## 其它两条口径
 *  · 节点里那枚小贴纸用**和真贴纸同一个尺寸**（`StickerFace` 自己那份 `STICKER_SIZE`）：
 *    它生成的 `clip-path: path()` 是按那个尺寸算的**绝对坐标**，换个尺寸就得再传一个 size，
 *    而「预览看到的和贴上去的不一样大」本身也是错的。所以放大的只是**点击区**（44px）。
 *  · 锚点只在**打开那一刻量一次**（`getBoundingClientRect()`），之后滚一下或缩放一下就叫它关掉
 *    —— 逐帧重测等于每帧读一次布局，而这只是个一闪而过的选择器。
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { STICKER_SKIN_KEYS, stickerSkinLabel, type StickerSkin } from "@biff/contracts/sticker";
import { STICKER_SIZE } from "../sticker-sprite";
// 环的几何(半径 / 节点尺寸 / 座位 / 视口夹取)是**纯数学**,住在 `sticker-wheel.ts` ——
// 抽出去的理由是可测:在这里的话想单测「5 颗是否均匀」就得把 React 与 portal 一起拉进 node。
import { NODE_SIZE, WHEEL_RADIUS, clampAnchor, wheelSeat } from "../sticker-wheel";
import { StickerFace } from "./StickerFace";

interface StickerSkinWheelProps {
  /** 锚点：那枚贴纸在**视口**里的中心（打开那一刻量一次）。 */
  anchor: { x: number; y: number };
  /** 这一枚现在用的款（高亮它、并把焦点放上去）。 */
  current: StickerSkin;
  /** 这一枚是红还是黑 —— 节点里的小贴纸要跟它同色（预览才所见即所得）。 */
  tint: "red" | "black";
  /** 键盘打开时把焦点收进环里。⚠ 鼠标悬停打开时**不能**抢焦点，那会把用户的焦点从页面上拽走。 */
  autoFocus: boolean;
  /** 悬停 / 聚焦某颗节点 → 实时预览（调用方只改本地状态，**不写 board**）。 */
  onPreview: (skin: StickerSkin | null) => void;
  /** 点选落定。 */
  onPick: (skin: StickerSkin) => void;
  /** 关闭（Escape / 失焦到环外 / 滚动 / 缩放）。 */
  onDismiss: () => void;
  /** 指针进 / 出这一带。**交给调用方**判定关不关：它同时看着贴纸那一侧，
   *  也只有它知道「贴纸 → 节点」中间那段空隙该给多长的宽限（见调用方里的 `WHEEL_GRACE_MS`）。 */
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

export function StickerSkinWheel({
  anchor,
  current,
  tint,
  autoFocus,
  onPreview,
  onPick,
  onDismiss,
  onPointerEnter,
  onPointerLeave,
}: StickerSkinWheelProps) {
  const nodes = useRef<Array<HTMLButtonElement | null>>([]);
  // 锚点只量一次（理由见文件头）；夹进视口也在这时算一次
  const [seat] = useState(() => clampAnchor(anchor.x, anchor.y));

  // 键盘打开 → 焦点落到**当前那一款**上（用户从它开始左右转，而不是每次都从头找）
  useEffect(() => {
    if (!autoFocus) return;
    nodes.current[Math.max(0, STICKER_SKIN_KEYS.indexOf(current))]?.focus();
  }, [autoFocus, current]);

  // 滚动 / 缩放会让锚点对不上那枚贴纸（锚点是视口坐标）→ 直接关掉，不做逐帧跟随
  useEffect(() => {
    const close = (): void => onDismiss();
    window.addEventListener("scroll", close, { passive: true, capture: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [onDismiss]);

  // Escape 关掉。
  // ⚠ 必须挂在 `window` 上、**不能只靠容器上的 `onKeyDown`**：鼠标悬停开的环里
  //   **没有任何元素获得焦点**（那是刻意的，见 `autoFocus`），于是 Escape 的 keydown
  //   落在 `body` 上，永远冒泡不到这个容器 —— 面板上一个按键都不响应，而这只表现为
  //   「按了没反应」，没有任何报错。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  /** 方向键在环上转（`role="radiogroup"` 的既有约定）；Escape 关掉并把焦点还给调用方。 */
  const step = (from: number, delta: number): void => {
    const count = STICKER_SKIN_KEYS.length;
    nodes.current[(from + delta + count) % count]?.focus();
  };

  return createPortal(
    <div
      className="rb-wheel"
      role="radiogroup"
      aria-label="给这枚贴纸换一款"
      data-rb-wheel={current}
      /* ⚠ 小贴纸的尺寸从 `STICKER_SIZE` 来(不写进 CSS):它必须与真贴纸**等大**,
        写死一个数就是第二处口径 —— 而贴纸尺寸用户已经改过四轮了。 */
      style={
        {
          left: `${seat.x}px`,
          top: `${seat.y}px`,
          "--rb-wheel-size": `${STICKER_SIZE}px`,
          /* ⚠ 环半径与节点尺寸由 `sticker-wheel.ts` 提供(**几何的唯一来源**):
             白底盘的外径就是按这两个值算的,在这里另写一个 46 / 44 会让底盘与节点错位。 */
          "--rb-wheel-radius": `${WHEEL_RADIUS}px`,
          "--rb-wheel-node": `${NODE_SIZE}px`,
        } as CSSProperties
      }
      onKeyDown={(event) => {
        const index = nodes.current.findIndex((node) => node === document.activeElement);
        if (event.key === "Escape") {
          // ⚠ 吃掉冒泡：页面上别处也可能把 Escape 当「关闭」（弹层 / 抽屉），
          //   轮盘是这里最内层的那一个，该由它先响应。
          event.stopPropagation();
          onDismiss();
          return;
        }
        if (index < 0) return;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          step(index, 1);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          step(index, -1);
        }
      }}
      onBlur={(event) => {
        // 焦点跑到环外才算「离开」——在环内从一颗走到另一颗不算（`relatedTarget` 是下一个焦点元素）
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onDismiss();
      }}
      /* ⚠ 容器是 `pointer-events: none`（那段空隙不吃指针），但节点不是 ——
         指针落到**节点**上时事件会冒泡到这里，所以这两个回调仍然会响。 */
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {/* 白底盘(2026-09-30,用户:「选择的盘白底的,能更清晰看到」)。
          ⚠ 它是**环带**(中心掏空),中心留出来的正是那枚贴纸的位置 ——
            预览靠它实时换款,底盘要是实心,用户唯一想看的东西就被盖住了。
          纯装饰、不吃指针(见 CSS)。 */}
      <span className="rb-wheel__plate" aria-hidden="true" />
      {/* 环心那个小圆点：告诉眼睛「这一圈是围着谁的」。纯装饰，不吃指针。 */}
      <span className="rb-wheel__hub" aria-hidden="true" />
      {STICKER_SKIN_KEYS.map((skin, index) => {
        const { dx, dy } = wheelSeat(index, STICKER_SKIN_KEYS.length, WHEEL_RADIUS);
        // ⚠ 名字走契约层的中文名（与上报载荷同一个白名单），**不在这里另写一份**
        const label = stickerSkinLabel(skin);
        return (
          <button
            key={skin}
            ref={(node) => {
              nodes.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={skin === current}
            aria-label={label}
            className={`rb-wheel__node rb-dot--${tint}`}
            data-rb-wheel-node={skin}
            /* 每颗晚一点点出现 —— 「气泡一颗颗冒出来」靠的就是这个 30ms 的错峰，
               关闭时不需要错峰（那会显得拖沓），见 CSS 里对 `animation` 的说明 */
            style={
              {
                "--rb-wheel-dx": `${dx}px`,
                "--rb-wheel-dy": `${dy}px`,
                "--rb-wheel-delay": `${index * 30}ms`,
                /* 名称胶囊该往哪一侧躲:`dy > 0`(下半圈)就挂在节点**上方**,
                   否则(上半圈)挂在下方 —— 一律朝环外。不这样的话下半圈那几个的名字
                   会往屏幕外探(而 `clampAnchor` 只保证**节点**在视口里,没算名字)。 */
                "--rb-wheel-label-dir": dy > 0 ? "-1" : "1",
              } as CSSProperties
            }
            onPointerEnter={() => onPreview(skin)}
            onFocus={() => onPreview(skin)}
            onClick={() => onPick(skin)}
          >
            <span className="rb-wheel__chip">
              <StickerFace skin={skin} />
            </span>
            {/* 悬停 / 聚焦才出现的名称(2026-09-30,用户:「悬停出现贴纸名称」)。
                ⚠ 一次只显示一颗 —— 所以相邻节点的名字**不可能**互相压到,不必做避让。
                ⚠ 不再挂 `title`:那会与这个胶囊同时弹出两个提示,而且原生 tooltip 要等一秒多。
                ⚠ `aria-hidden`:名字已经在节点的 `aria-label` 上了,这枚胶囊纯给眼睛看 ——
                  不排除的话读屏在某些模式下会把它当成按钮的可见文本再念一遍。 */}
            <span className="rb-wheel__name" aria-hidden="true">
              {label}
            </span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
