import { describe, expect, it } from "vitest";
import { canonical } from "@biff/contracts/canonical";
import { hasImportableData } from "@biff/contracts/import";
import { REACTION_EMOJIS, isReactionEmoji } from "@biff/contracts/reactions";
import {
  DISCUSSION_CATEGORIES,
  discussionCategoryLabel,
  normalizeDiscussionBody,
} from "@biff/contracts/screening";

// `packages/contracts` 是前后端共享的**序列化口径**,此前没有任何单测。
// 放在 `apps/api/tests/` 而不是 `packages/contracts/tests/`:调用方是 api(见 vitest.config.ts 的说明)。
//
// - `canonical()` 决定「同一条片单在两台设备上算出同一个字符串」——它一旦不稳定,
//   `PUT /api/account/sync` 的 `previous.records !== canonical(records)` 幂等判定就会误报
//   `OPERATION_ID_REUSED`(409)。
// - `hasImportableData()` 决定「访客数据算不算值得占用那次 account_import」。
//
// 2026-09-13 补,见 PLAN-20260913201727。

describe("canonical", () => {
  it("对象键排序,与插入顺序无关", () => {
    expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
    expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("嵌套对象逐层排序", () => {
    expect(canonical({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it("★ 数组保持原序(数组是序列,不是集合)", () => {
    expect(canonical([2, 1])).toBe("[2,1]");
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
    // 数组里的对象仍然排序
    expect(canonical([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it("基本类型走 JSON.stringify 的口径", () => {
    expect(canonical("x")).toBe('"x"');
    expect(canonical(1)).toBe("1");
    expect(canonical(true)).toBe("true");
    expect(canonical(null)).toBe("null");
  });

  it("⚠ 当前实际行为:NaN / Infinity 归一为 null", () => {
    // JSON.stringify 的口径,不是本函数的选择 —— 断言写下来,免得日后当成 bug 去「修」
    expect(canonical(Number.NaN)).toBe("null");
    expect(canonical(Number.POSITIVE_INFINITY)).toBe("null");
  });

  it("⚠ 当前实际行为:undefined 产出非法 JSON(不是崩溃)", () => {
    // `JSON.stringify(undefined)` 返回 undefined(不是字符串),模板字符串把它拼成 "undefined"。
    // 真实数据里不会出现 undefined(records 是 Record<string,string>),但这是可观察行为。
    expect(canonical({ a: undefined })).toBe('{"a":undefined}');
    expect(canonical(undefined)).toBeUndefined();
  });

  it("转义与 Unicode 保持 JSON.stringify 的结果", () => {
    expect(canonical({ "a b": '引"号' })).toBe('{"a b":"引\\"号"}');
  });
});

describe("hasImportableData", () => {
  it("key 前缀不在白名单 → false(即使内容非空)", () => {
    expect(hasImportableData({ "other:x": '{"a":1}' })).toBe(false);
  });

  it("四个允许的前缀都认", () => {
    for (const key of ["pick:abc", "plan:abc", "local:biff.settings.v1", "raw:biff.picks.v2"])
      expect(hasImportableData({ [key]: '{"a":1}' })).toBe(true);
  });

  it("空容器 / null / 空字符串不算「有数据」", () => {
    expect(hasImportableData({ "pick:a": "[]" })).toBe(false);
    expect(hasImportableData({ "pick:a": "{}" })).toBe(false);
    expect(hasImportableData({ "pick:a": "null" })).toBe(false);
    expect(hasImportableData({ "pick:a": '""' })).toBe(false);
    expect(hasImportableData({ "pick:a": '{"x":[]}' })).toBe(false);
  });

  it("嵌套里任意一处有值就算有数据", () => {
    expect(hasImportableData({ "pick:a": '[{"code":"001"}]' })).toBe(true);
    expect(hasImportableData({ "pick:a": '{"x":[],"y":[1]}' })).toBe(true);
  });

  it("⚠ 当前实际行为:顶层是字符串时只看「非空」,不看它解析出什么", () => {
    // 值是字符串字面量 `"[]"`(注意外层引号)—— populated() 对 string 只判 trim 后长度,
    // 所以「空数组的字符串」反而算有数据。
    expect(hasImportableData({ "local:biff.picks.v2": '"[]"' })).toBe(true);
  });

  it("非法 JSON → false(不抛)", () => {
    expect(hasImportableData({ "pick:a": "{oops" })).toBe(false);
  });

  it("空记录 → false", () => {
    expect(hasImportableData({})).toBe(false);
  });
});

// 2026-09-14 新增:反应白名单与讨论分类上提到 contracts,前后端同一 import。
describe("reactions contract", () => {
  it("五个热门 emoji + 点踩,未知 emoji 不合法", () => {
    expect([...REACTION_EMOJIS]).toEqual(["👍", "❤️", "🎉", "💡", "👀", "👎"]);
    expect(isReactionEmoji("👀")).toBe(true);
    expect(isReactionEmoji("👎")).toBe(true);
    expect(isReactionEmoji("🔥")).toBe(false);
  });
});

describe("screening discussion contract", () => {
  it("四类讨论分类与中文标签", () => {
    expect(DISCUSSION_CATEGORIES).toEqual([
      { key: "gift", label: "无料交换" },
      { key: "swap", label: "物品互换" },
      { key: "buddy", label: "临时约伴" },
      { key: "other", label: "其他" },
    ]);
    expect(discussionCategoryLabel("gift")).toBe("无料交换");
  });

  it("⚠ 当前实际行为:未知分类 key 原样返回标签,不抛错", () => {
    // 旧数据 / 将来删分类时的兜底 —— 断言写下来,免得日后当成 bug 去「修」
    expect(discussionCategoryLabel("nope")).toBe("nope");
  });

  it("正文 trim 后 1–2000 字", () => {
    expect(normalizeDiscussionBody("  换无料  ")).toBe("换无料");
    expect(normalizeDiscussionBody("   ")).toBeNull();
    expect(normalizeDiscussionBody("a".repeat(2001))).toBeNull();
    expect(normalizeDiscussionBody(null)).toBeNull();
  });
});
