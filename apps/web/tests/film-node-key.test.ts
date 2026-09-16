// 场次身份口径(`util.ts::filmNodeKey`)的稳定性哨兵 —— 2026-09-16 立
// (`PLAN-20260916142713`)。
//
// 为什么单测它:本轮给活动场次(Actors' House / Master Class / Cine Class / Special Talk)
// 补中文译名时发现,`sched:` 分支当时取的是 `title_zh || title_en` —— 补译名会把身份 key
// 从英文名换成中文名,`biff.picks.v2` 里**已经选过**这些场次的记录会静默失配
// (用户只会看到「我选好的场次不见了」,不报任何错)。
// 口径改为**以官方英文名为准**后,译名只影响展示、不再动身份;这条测试钉死这一点。

import { describe, expect, it } from "vitest";
import { filmNodeKey } from "../src/util";
import { catalog, show } from "./helpers";

describe("filmNodeKey:非目录场次(活动 / 纯排期片)的身份只认官方英文名", () => {
  const s = show({ code: "804", title_en: "Actors' House: RYU Seung-ryong" });
  const cat = catalog([s]);

  it("补中文译名前后身份 key 相同(活动场次)", () => {
    const before = filmNodeKey(cat, s);
    const after = filmNodeKey(cat, { ...s, title_zh: "演员之家：柳承龙" });
    expect(before).toBe("sched:actors' house: ryu seung-ryong");
    expect(after).toBe(before);
  });

  it("英文名缺失时才退回中文名,再缺退回 code", () => {
    expect(filmNodeKey(cat, { code: "999", title_en: "", title_zh: "某活动" })).toBe("sched:某活动");
    expect(filmNodeKey(cat, { code: "999" })).toBe("sched:999");
  });
});
