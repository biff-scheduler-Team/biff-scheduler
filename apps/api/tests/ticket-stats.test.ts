import { describe, expect, it } from "vitest";
import {
  diffOutcomes,
  formatTicketCounts,
  isTicketOutcome,
  isTicketState,
  MAX_TICKET_ENTRIES_PER_PING,
  normalizeTicketEntries,
  outcomeOf,
} from "../src/ticket-stats";
import { SCREENING_CODE_MAX_LENGTH } from "../src/screening-stats";

// 抢票结果:与「同场观影人数」共用身份与权重口径,这里只测纯函数(落库行为由 store 负责)。
// 核心回归点是 **转票规则**:「已抢到 + 转票」必须被摘成独立的 transfer(不进抢到率),
// 而「放弃 + 转票」(改状态时 via 被有意保留)仍然是一条放弃。

describe("ticket outcome whitelist", () => {
  it("三态 / 四值各自的白名单", () => {
    expect(isTicketState("got")).toBe(true);
    expect(isTicketState("missed")).toBe(true);
    expect(isTicketState("dropped")).toBe(true);
    expect(isTicketState("transfer")).toBe(false);
    expect(isTicketState("sold_out")).toBe(false);
    expect(isTicketState(1)).toBe(false);

    expect(isTicketOutcome("transfer")).toBe(true);
    expect(isTicketOutcome("got")).toBe(true);
    expect(isTicketOutcome("sold_out")).toBe(false);
    expect(isTicketOutcome(null)).toBe(false);
  });

  it("上报上限与 want-ping / screening-ping 对齐", () => {
    expect(MAX_TICKET_ENTRIES_PER_PING).toBe(500);
  });
});

describe("outcomeOf", () => {
  it("「已抢到 + 转票」被摘成独立的 transfer", () => {
    expect(outcomeOf("got", "transfer")).toBe("transfer");
  });

  it("自己抢到的「已抢到」仍是 got（含 via 缺省 / self）", () => {
    expect(outcomeOf("got", "self")).toBe("got");
    expect(outcomeOf("got", undefined)).toBe("got");
  });

  it("改状态后 via 被保留：dropped + transfer 是一条「放弃」，不是转票获得", () => {
    // state.ts::setTicket 有意保留 via(把「已抢到」改成「放弃」不该弄丢「转票」标记),
    // 所以这个组合真实存在 —— 它必须落 dropped,否则抢到率会被记成一次转票
    expect(outcomeOf("dropped", "transfer")).toBe("dropped");
    expect(outcomeOf("missed", "transfer")).toBe("missed");
  });

  it("非法三态 → null（调用方丢弃该条）", () => {
    expect(outcomeOf("sold_out", "self")).toBeNull();
    expect(outcomeOf(undefined, undefined)).toBeNull();
    expect(outcomeOf(1, "transfer")).toBeNull();
  });
});

describe("normalizeTicketEntries", () => {
  it("丢弃非法条目;同一场以最后一条为准", () => {
    const entries = normalizeTicketEntries([
      { code: "001", state: "got" },
      { code: "", state: "got" },
      { code: "002", state: "sold_out" },
      { code: "001", state: "missed" }, // 同 code 后到者胜
      { code: "003", state: null },
      { code: "x".repeat(SCREENING_CODE_MAX_LENGTH + 1), state: "got" },
    ]);
    expect([...entries]).toEqual([["001", "missed"]]);
  });

  it("transfer 与 self 落到不同的取值", () => {
    const entries = normalizeTicketEntries([
      { code: "001", state: "got", via: "transfer" },
      { code: "002", state: "got", via: "self" },
      { code: "003", state: "got" },
    ]);
    expect(entries.get("001")).toBe("transfer");
    expect(entries.get("002")).toBe("got");
    expect(entries.get("003")).toBe("got");
  });

  it("空输入 → 空表", () => {
    expect(normalizeTicketEntries([]).size).toBe(0);
  });
});

describe("diffOutcomes", () => {
  it("改结果同时出现在 removed(旧值) 与 added(新值)", () => {
    const previous = new Map([
      ["001", "got"],
      ["002", "missed"],
    ] as const);
    const next = new Map([
      ["001", "dropped"], // 改结果
      ["003", "transfer"], // 新增
    ] as const);
    const { removed, added } = diffOutcomes(previous, next);
    expect(removed).toEqual([
      { code: "001", outcome: "got" },
      { code: "002", outcome: "missed" },
    ]);
    // added 的顺序跟 `next` 的插入序走,removed 跟 `previous` 的插入序走(与 diffVotes 同构)
    expect(added).toEqual([
      { code: "001", outcome: "dropped" },
      { code: "003", outcome: "transfer" },
    ]);
  });

  it("完全没变 → 两个空数组(store 据此直接返回,不碰聚合表)", () => {
    const same = new Map([["001", "got"]] as const);
    expect(diffOutcomes(same, new Map(same))).toEqual({ removed: [], added: [] });
  });

  it("整份撤回 → 全部进 removed", () => {
    const { removed, added } = diffOutcomes(new Map([["001", "got"]] as const), new Map());
    expect(removed).toEqual([{ code: "001", outcome: "got" }]);
    expect(added).toEqual([]);
  });
});

describe("formatTicketCounts", () => {
  it("四项全 0 的场次不输出;字符串数字也认;四舍五入成整数", () => {
    expect(
      formatTicketCounts([
        { code: "001", got_sum: "0.75", transfer_sum: "0", missed_sum: "2.5", dropped_sum: 0 },
        { code: "002", got_sum: 0, transfer_sum: 0, missed_sum: 0, dropped_sum: 0 },
        { code: "003", got_sum: "nope", transfer_sum: 0, missed_sum: 0, dropped_sum: 1 },
      ]),
    ).toEqual({
      "001": { got: 1, transfer: 0, missed: 3, dropped: 0 },
      "003": { got: 0, transfer: 0, missed: 0, dropped: 1 },
    });
  });

  it("负数被夹回 0；只带转票的场次也要输出（转票获得数本身是可见指标）", () => {
    expect(
      formatTicketCounts([{ code: "001", got_sum: -5, transfer_sum: "0.75", missed_sum: 0, dropped_sum: 0 }]),
    ).toEqual({ "001": { got: 0, transfer: 1, missed: 0, dropped: 0 } });
  });

  it("空输入 → 空表", () => {
    expect(formatTicketCounts([])).toEqual({});
  });
});
