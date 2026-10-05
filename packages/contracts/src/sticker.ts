/**
 * 贴纸皮肤与材质的白名单 —— **前后端唯一来源**（2026-09-29）。
 *
 * 前因：贴纸从「按 id 自动交替长什么样」改成**每枚手选一款皮肤**，而这枚贴纸的款要
 * 跟着上报载荷进服务端（服务端按款聚合，展板上的群点才画得出大家真正选了什么）。
 * 于是这个 id 同时出现在三个地方：前端轮盘（渲染）、上报载荷（路由）、服务端聚合表（存取）。
 * 任何一侧手抄一份都会漂移 —— 漂移的表现是「用户选的那款存进去了，但读出来是另一款」，
 * 不报错、只是默默地不对。照 `reactions.ts` / `screening.ts` 的既有做法上提到契约层。
 *
 * ⚠ 这里**只放 id 与展示名**。一款皮肤长什么样（轮廓路径 / 中心图标 / 材质配方）是**绘制**的事，
 *   留在前端 `apps/web/src/sticker-skin.ts`；服务端不需要、也不该知道怎么画。
 * ⚠ 材质也是同样的道理：`StickerMaterial` 放在这里是因为它要进库（聚合按款、款绑材质，
 *   将来若要单独统计材质就现成），但具体怎么呈现只在绘制侧定义。
 */

/** 可选皮肤（2026-10-05 定稿 3 款：**红黑同一套，只差颜色**）。
 *
 *  ⚠ 数组顺序 = 轮盘里的排列顺序 = 群点分款时的稳定次序。不要为了好看重排：
 *    群点的落点由 id 推导，改顺序会让「同一个人同一票」在别人屏幕上换个位置。
 *
 *  ⚠ 沿革：2026-09-30 定稿五款（场记板 / 金棕榈 / 票根 / 胶片残片 / 胶片齿孔）；
 *    2026-10-05 用户要求「只保留三种，去掉场记板和金棕榈」→ 剩下下面这三款。
 *    ⚠ 删款不是改这一行就完事：库里那两款的行**必须一起清**
 *      （`film_vote_contribution.skin` + `film_vote_skin_stat`），
 *      否则它们的桶永远减不掉、群点会比卡片上的数字多一枚
 *      （操作约束原话见 `apps/api/src/film-vote-store.ts` 的 `prevSkins` 那段；
 *      本次的清理见迁移 `0014_drop_clap_palm_skins.sql`）。 */
export const STICKER_SKINS = [
  { key: "stub", label: "票根" },
  { key: "scrap", label: "胶片残片" },
  { key: "sprocket", label: "胶片齿孔" },
] as const;

export type StickerSkin = (typeof STICKER_SKINS)[number]["key"];

/** 全部皮肤 id，按轮盘顺序。 */
export const STICKER_SKIN_KEYS: readonly StickerSkin[] = STICKER_SKINS.map((skin) => skin.key);

/** 没存皮肤时的兜底款。
 *  ⚠ 用户说了「旧数据不用兼容、我会自己删」，所以这不是在迁旧数据 —— 它收的是**字段缺席**：
 *    旧客户端上报的票、迁移前写下的聚合行，读回来都没有款。让它们落在一个确定的款上，
 *    而不是渲染时抛错或画出一个不存在的形状。
 *  ⚠ 2026-09-30 换款时**它必须跟着换**：原来落 `torn`，而 `torn` 已下线 ——
 *    留着一个不在白名单里的兜底款，等于每次兜底都要再走一次「白名单外的值怎么画」那条分支。
 *    现在落 `stub`（票根）：三款里最中性的一枚，读起来正好像「没有特意挑过」。 */
export const DEFAULT_STICKER_SKIN: StickerSkin = "stub";

const skinSet = new Set<string>(STICKER_SKIN_KEYS);

/** 白名单判定（含类型收窄）。
 *  ⚠ 收 `unknown` 而不是 `string`：它的调用方全是**不可信来源** —— 上报载荷、
 *    库里被人工改过的行。收窄之前先挡住「不是字符串」这一档。 */
export function isStickerSkin(value: unknown): value is StickerSkin {
  return typeof value === "string" && skinSet.has(value);
}

/** 皮肤 id → 中文名；未知 id 原样返回（旧数据 / 将来删款时的兜底，不抛错）。 */
export function stickerSkinLabel(key: string): string {
  return STICKER_SKINS.find((skin) => skin.key === key)?.label ?? key;
}

/** 材质变体：一款皮肤绑定一种（「一款 = 轮廓 + 材质 + 图标 整套绑定」）。
 *  · `grain`  胶片颗粒 —— 确定性噪点
 *  · `ink`    印章油墨边 —— 边缘不均匀的深色轮廓
 *  ⚠ 2026-10-05 下线 `screen`（丝网重影）：它唯一的消费者是场记板，而那一款已经删了 ——
 *    材质表里留一个没有任何皮肤指向的项，正是 `sticker-material.test.ts` 那条
 *    「登记了却没人用」守卫要挡的东西。 */
export const STICKER_MATERIALS = ["grain", "ink"] as const;

export type StickerMaterial = (typeof STICKER_MATERIALS)[number];

const materialSet = new Set<string>(STICKER_MATERIALS);

export function isStickerMaterial(value: unknown): value is StickerMaterial {
  return typeof value === "string" && materialSet.has(value);
}
