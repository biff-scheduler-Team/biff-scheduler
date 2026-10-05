/**
 * 贴纸**皮肤**的唯一来源（2026-09-29，PLAN-20260929195500 第三轮）。
 *
 * 一轮之前贴纸是「同一个形状族按 id 自动交替」；现在改成**每枚手选一款皮肤**。
 * 一款皮肤 = **轮廓 + 材质 + 中心图标 整套绑定**（用户 2026-09-29 拍板），三者由同一个
 * `StickerSkin` 决定 —— 所以这个模块是「这一枚长什么样」的唯一入口，四条绘制路径
 * （CSS / 群点 sprite / 分享图 / 只读展示）都只许从这里取。
 *
 * ⚠ **id 与中文名在 `@biff/contracts/sticker`**（前后端唯一来源，服务端要按这个 id 聚合）;
 *   这里只管**怎么画** —— 服务端不需要、也不该知道轮廓路径长什么样。
 *
 * ⚠ **红黑共用同一套皮肤**（用户原话:「只是红色跟黑色的区别」）——
 *   所以这里**没有**按颜色分的表，图标也必须**颜色中立**
 *   （「叉号 / 避雷」那类负面图形与「心形」那类正面图形都不能要：同一款皮肤两个颜色都会用到）。
 *
 * ⚠ 纯函数 + 常量表，**import 期不碰 DOM**。
 */

import {
  DEFAULT_STICKER_SKIN,
  STICKER_SKINS,
  isStickerSkin,
  type StickerSkin,
} from "@biff/contracts/sticker";
// ⚠ 「由 id 推导的款」住在 `redblack.ts`（`derivedSkin`）而不是这里：`crowdStickers` 要用它兜底，
//   而那在 redblack 里 —— 推导放这边就是循环 import。本模块只负责「款 → 长什么样」。
import { derivedSkin } from "./redblack";
import type { StickerGlyph } from "./sticker-glyph";
import type { StickerMaterial } from "./sticker-material";
import type { StickerShape } from "./sticker-shape";

export type { StickerSkin, StickerMaterial };
// 转出去,好让「皮肤」这件事对消费端只有一个入口（不必知道它其实住在 `redblack.ts`）
export { derivedSkin };

/** 一款皮肤的外观。⚠ 三项**整套绑定**，不做「单独换材质」那种开关 ——
 *  将来真要拆，就在这里把 `material` 提成独立参数，绘制侧一行都不用改。 */
export interface SkinSpec {
  readonly shape: StickerShape;
  readonly glyph: StickerGlyph;
  readonly material: StickerMaterial;
}

/** 皮肤 → 外观。⚠ 类型是 `Record<StickerSkin, …>`：`@biff/contracts/sticker` 里加一款而
 *  这里忘了登记，会**编译不过**（而不是运行时画出一个不存在的形状）。 */
const SKINS: Record<StickerSkin, SkinSpec> = {
  // 2026-10-05 定稿：票根 / 胶片残片 / 胶片齿孔（红黑同一套，只差颜色）。
  // ⚠ 场记板（`clap`）与金棕榈（`palm`）已下线；它们的轮廓 `clap` / `torn`、图形 `palm`
  //   与材质 `screen` 一并删掉（`screen` 唯一消费者就是场记板）—— 三款现在各用一个轮廓。
  stub: { shape: "stub", glyph: "heart", material: "ink" },
  scrap: { shape: "scrap", glyph: "bolt", material: "grain" },
  sprocket: { shape: "sprocket", glyph: "hole", material: "grain" },
};

/** 全部可选皮肤，**按轮盘里的排列顺序**（顺序来自契约层，见那里的说明）。 */
export const ALL_SKINS: readonly StickerSkin[] = STICKER_SKINS.map((skin) => skin.key);

export function skinSpec(skin: StickerSkin): SkinSpec {
  return SKINS[skin];
}

/** 某一枚实际用哪款：存了（且在白名单内）就用存的，否则按 id 兜底（`redblack.ts::derivedSkin`）。
 *
 *  ⚠ 收 `string | null | undefined` 而不是 `StickerSkin`：调用方喂进来的可能是**库里读出来的**、
 *    或者是**旧版本存下来的**字符串 —— 白名单判定必须发生在这一处（与读侧同一道收口），
 *    而不是让每个调用点各写一遍 `sticker.skin ?? …`。 */
export function resolveSkin(id: string, skin?: string | null): StickerSkin {
  return isStickerSkin(skin) ? skin : derivedSkin(id);
}

/** 兜底款（服务端 / 契约层定为 `stub`，见 `DEFAULT_STICKER_SKIN`）。
 *  ⚠ 2026-09-30 换款时它**跟着换过**（原 `torn`，已下线）—— 这里如果写着旧款名，
 *    下一个人会顺着它去找一个不存在的款。
 *  ⚠ 它只用于「需要一个默认高亮」，**不是**「没存款时画哪一款」：
 *    后者走 `resolveSkin` → 按 id 兜底（见那里的说明），比同一个值更耐看。 */
export const FALLBACK_SKIN: StickerSkin = DEFAULT_STICKER_SKIN;
