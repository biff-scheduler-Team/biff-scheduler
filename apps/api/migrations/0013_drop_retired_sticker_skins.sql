-- 2026-09-30 换款：`torn`（撕裂圆片）与 `reel`（胶卷盘）下线，五款改为
-- 场记板 / 金棕榈 / 票根 / 胶片残片 / 胶片齿孔（红黑同一套，只差颜色）。
--
-- ⚠ 这不是「顺手清一下」，而是 `film-vote-store.ts::prevSkins` 那段写明的**操作约束**：
--   库里若留着这两款的值与聚合行，读侧的白名单会把它们归一成 `null`，
--   于是撤票 / 改款时**无从知道该从哪个桶里减** —— 那些桶会永远减不掉，
--   表现是「群点比卡片上的数字多一枚」，而且**永不自愈**（聚合只在贡献行有差分时修正）。
--
-- 两件事**都要做**：
--   ① 聚合表里那两款的桶直接删掉；
--   ② 贡献行里的款置 NULL —— `null` 的语义是「这一票没有款」（与迁移前的旧票一致），
--      读回来会落到兜底款；留着旧字符串则是「一个白名单外的款」，两回事。
--
-- ⚠ 红黑**总数**那本账（`film_vote_stat`）一个字都不动：换款不影响谁投了什么。
--> statement-breakpoint

DELETE FROM `film_vote_skin_stat` WHERE `skin` IN ('torn', 'reel');
--> statement-breakpoint

UPDATE `film_vote_contribution` SET `skin` = NULL WHERE `skin` IN ('torn', 'reel');
