import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hydrateStorage } from "../src/app/store";
import { rankOf, savedPlans } from "../src/state";
import { catalog, show } from "./helpers";

const cat = catalog([show({ code: "001" }), show({ code: "002" })]);
const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  values.set("biff.picks.v2", JSON.stringify([
    { key: "one", picks: [{ code: "001" }, { code: "002" }], note: "" },
  ]));
});

afterEach(() => vi.unstubAllGlobals());

describe("legacy storage hydration order", () => {
  it("prunes ranks outside the loaded picks while preserving selected ranks and unknown keys", () => {
    values.set("biff.ranks.v1", '{"001":2,"002":1,"removed":3}');
    values.set("biff.future.v9", '{ "unchanged": true }');
    hydrateStorage(cat);
    expect(Object.fromEntries(rankOf)).toEqual({ "001": 2, "002": 1 });
    expect(JSON.parse(values.get("biff.ranks.v1")!)).toEqual({ "001": 2, "002": 1 });
    expect(values.get("biff.future.v9")).toBe('{ "unchanged": true }');
  });

  it("keeps valid rank bytes and saved plans across repeated storage synchronization", () => {
    const ranks = '{ "001": 2, "002": 1 }';
    const plans = [{ id: "saved", name: "方案 1", codes: ["001"], createdAt: 1 }];
    values.set("biff.ranks.v1", ranks);
    values.set("biff.savedplans.v1", JSON.stringify(plans));
    hydrateStorage(cat);
    hydrateStorage(cat);
    expect(values.get("biff.ranks.v1")).toBe(ranks);
    expect(savedPlans).toEqual(plans);
  });
});
