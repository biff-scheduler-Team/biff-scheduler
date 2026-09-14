import { describe, expect, it } from "vitest";
import {
  TICKET_STATES,
  TICKET_STATE_LABELS,
  actualCodeSet,
  isTicketState,
  normalizeTicketRecord,
  staleTicketCodes,
} from "../src/tickets";
import type { TicketRecord } from "../src/types";

// 票务状态(2026-09-14,PLAN-20260914164050)。纯逻辑,不碰 DOM / localStorage。

describe("ticket states", () => {
  it("三态固定,中文标签齐备", () => {
    expect([...TICKET_STATES]).toEqual(["got", "missed", "dropped"]);
    for (const state of TICKET_STATES) expect(TICKET_STATE_LABELS[state]).toBeTruthy();
  });

  it("只认三态;票务系统内部状态(如售罄)不是合法值", () => {
    expect(isTicketState("got")).toBe(true);
    expect(isTicketState("sold_out")).toBe(false);
    expect(isTicketState("")).toBe(false);
    expect(isTicketState(undefined)).toBe(false);
    expect(isTicketState(1)).toBe(false);
  });
});

describe("normalizeTicketRecord", () => {
  it("非法 / 残缺记录一律丢弃(返回 null)", () => {
    expect(normalizeTicketRecord(null)).toBeNull();
    expect(normalizeTicketRecord("got")).toBeNull();
    expect(normalizeTicketRecord({})).toBeNull();
    expect(normalizeTicketRecord({ state: "sold_out" })).toBeNull();
  });

  it("via 缺省或非法 → 归一为「自己抢到」(不写回 self)", () => {
    expect(normalizeTicketRecord({ state: "got" })).toEqual({ state: "got" });
    expect(normalizeTicketRecord({ state: "got", via: "self" })).toEqual({ state: "got" });
    expect(normalizeTicketRecord({ state: "got", via: "nope" })).toEqual({ state: "got" });
  });

  it("转票来源保留", () => {
    expect(normalizeTicketRecord({ state: "got", via: "transfer" })).toEqual({
      state: "got",
      via: "transfer",
    });
  });
});

describe("实际行程派生", () => {
  it("只取「已抢到」的场次(转票补入的也算)", () => {
    const records = new Map<string, TicketRecord>([
      ["001", { state: "got" }],
      ["002", { state: "got", via: "transfer" }],
      ["003", { state: "missed" }],
      ["004", { state: "dropped" }],
    ]);
    expect([...actualCodeSet(records)].sort()).toEqual(["001", "002"]);
  });

  it("未标记 / 空表 → 实际行程为空", () => {
    expect([...actualCodeSet(new Map())]).toEqual([]);
  });
});

describe("prune", () => {
  it("已移出行程的场次状态被点名删除", () => {
    const records = new Map<string, TicketRecord>([
      ["001", { state: "got" }],
      ["002", { state: "missed" }],
    ]);
    const alive = new Set(["001"]);
    expect(staleTicketCodes(records, (code) => alive.has(code))).toEqual(["002"]);
  });

  it("全部仍在行程里 → 一个都不删", () => {
    const records = new Map<string, TicketRecord>([["001", { state: "got" }]]);
    expect(staleTicketCodes(records, () => true)).toEqual([]);
  });
});
