// 抢票结果客户端缓存单测（2026-09-20,PLAN-20260920161837）。
//
// 重点与 `film-votes.test.ts` 一致：**容错**（接口没部署 / 断网 / 半截响应都不能把页面拖挂）
// 与取整口径。⚠ 上报端已于 2026-09-30 删除（`PLAN-20260930213528`），故这里只剩读取端。

import { afterEach, describe, expect, it, vi } from "vitest";

const okJson = (body: unknown) =>
  Promise.resolve({ ok: true, json: async () => body } as unknown as Response);
const fail = (status = 404) => Promise.resolve({ ok: false, status } as unknown as Response);

/* 取整口径：全站唯一来源是 `util.ts::wholeCount`（want / screening / film-votes 三个同构模块都走它）。
 * api 侧 `formatTicketCounts` 每个端点都 `Math.round` 过，故第一条钉的是**真实形状行为不变**；
 * 第二条钉的是「万一上游漏了取整」时仍与另外三个模块同口径（round，而不是 trunc）。
 * 2026-09-23，PLAN-20260923113659 T7。 */
describe("取整口径（与三个同构模块同一份 wholeCount）", () => {
  it("上游真实形状（服务端已 Math.round 的整数）原样通过", async () => {
    const { parseTicketCounts } = await import("../src/ticket-stats");
    expect(parseTicketCounts({ "001": { got: 3, transfer: 1, missed: 0, dropped: 0 } })).toEqual({
      "001": { got: 3, transfer: 1, missed: 0, dropped: 0 },
    });
  });

  it("上游漏了取整时（加权和 2.75）→ 四舍五入成 3，而不是截断成 2", async () => {
    const { parseTicketCounts } = await import("../src/ticket-stats");
    expect(parseTicketCounts({ "001": { got: 2.75 } })).toEqual({
      "001": { got: 3, transfer: 0, missed: 0, dropped: 0 },
    });
  });
});

describe("parseTicketCounts 白名单", () => {
  it("丢弃非法条目、四项全 0 不输出、负数夹回 0、字符串数字认", async () => {
    const { parseTicketCounts } = await import("../src/ticket-stats");
    expect(
      parseTicketCounts({
        "001": { got: 3, transfer: 1, missed: 2, dropped: 0 },
        "002": { got: 0, transfer: 0, missed: 0, dropped: 0 },
        "003": { got: "2", transfer: -5, missed: 1, dropped: 0 },
        "004": null,
        "005": "nope",
      }),
    ).toEqual({
      "001": { got: 3, transfer: 1, missed: 2, dropped: 0 },
      "003": { got: 2, transfer: 0, missed: 1, dropped: 0 },
    });
    expect(parseTicketCounts(null)).toEqual({});
    expect(parseTicketCounts("nope")).toEqual({});
  });

  it("只带转票的场次也要保留（转票获得数本身是可见指标）", async () => {
    const { parseTicketCounts } = await import("../src/ticket-stats");
    expect(parseTicketCounts({ "001": { transfer: 2 } })).toEqual({
      "001": { got: 0, transfer: 2, missed: 0, dropped: 0 },
    });
  });
});

describe("loadTicketCounts 容错", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("接口还没部署(404)→ 空表,不抛", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(() => fail()));
    const { loadTicketCounts, peekTicketCounts } = await import("../src/ticket-stats");
    await expect(loadTicketCounts()).resolves.toEqual({});
    expect(peekTicketCounts()).toEqual({});
  });

  it("断网(网络异常)→ 空表,不抛", async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    const { loadTicketCounts } = await import("../src/ticket-stats");
    await expect(loadTicketCounts()).resolves.toEqual({});
  });

  it("正常响应 → 解析进缓存", async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => okJson({ tickets: { "001": { got: 2, transfer: 1, missed: 0, dropped: 0 } } })),
    );
    const { loadTicketCounts, peekTicketCounts } = await import("../src/ticket-stats");
    await loadTicketCounts();
    expect(peekTicketCounts()).toEqual({ "001": { got: 2, transfer: 1, missed: 0, dropped: 0 } });
  });
});

/* `describe("scheduleTicketPing")` 的三个用例已于 2026-09-30 删除(`PLAN-20260930213528`):
 * 上报端(`scheduleTicketPing` / `TicketEntry` / `MAX_TICKET_ENTRIES_PER_PING`)唯一的数据来源是
 * 本地票务三态,而三态随卡片视图一并下线。读取端(上面那两个 describe)保留 ——
 * 抢票分析链路仍按服务端返回的**存量**计数渲染。 */
