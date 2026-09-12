import { describe, expect, it } from "vitest";
import {
  canonical,
  mergeRecords,
  readWorkspace,
  writeWorkspace,
  type WorkspaceStorage,
} from "../src/sync-data";
class MemoryStorage implements WorkspaceStorage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
const pick = (codes: string[], note = "") =>
  canonical({
    key: "cat:f001",
    codes: Object.fromEntries(codes.map((code) => [code, true])),
    note,
  });
describe("account synchronization", () => {
  it("merges different devices' independent edits without replacing either", () => {
    const base = { "pick:cat:f001": pick(["101"]) };
    const local = { "pick:cat:f001": pick(["101", "102"]) };
    const remote = { "pick:cat:f001": pick(["101"], "Meet before screening") };
    const merged = mergeRecords(base, local, remote);
    expect(merged.conflicts).toEqual([]);
    expect(merged.records["pick:cat:f001"]).toBe(pick(["101", "102"], "Meet before screening"));
  });
  it("preserves offline deletions rather than resurrecting them from the cloud", () => {
    const base = { "pick:cat:f001": pick(["101"]) };
    expect(mergeRecords(base, {}, base)).toEqual({ records: {}, conflicts: [] });
    expect(mergeRecords(base, base, {})).toEqual({ records: {}, conflicts: [] });
    const removed = mergeRecords(
      base,
      { "pick:cat:f001": pick([]) },
      { "pick:cat:f001": pick(["101", "102"]) },
    );
    expect(removed.conflicts).toEqual([]);
    expect(removed.records["pick:cat:f001"]).toBe(pick(["102"]));
  });
  it("keeps both versions of conflicting notes and delete-versus-edit", () => {
    const base = { "pick:cat:f001": pick(["101"], "Initial") };
    const local = { "pick:cat:f001": pick(["101"], "Local note") };
    const remote = { "pick:cat:f001": pick(["101"], "Remote note") };
    expect(mergeRecords(base, local, remote).conflicts).toEqual([
      { key: "pick:cat:f001", local: local["pick:cat:f001"], remote: remote["pick:cat:f001"] },
    ]);
    expect(mergeRecords(base, {}, remote).conflicts[0]?.local).toBeNull();
  });
  it("initial guest import is additive and repeated import is idempotent", () => {
    const local = { "pick:cat:f001": pick(["101"]) };
    const remote = { "local:biff.settings.v1": canonical({ transitMin: 15 }) };
    const once = mergeRecords({}, local, remote);
    expect(once.records).toEqual({ ...local, ...remote });
    expect(mergeRecords({}, once.records, local).records).toEqual(once.records);
  });
  it("round-trips existing picks, plans, ranks and preferences while excluding account caches", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "biff.picks.v2",
      JSON.stringify([{ key: "cat:f001", picks: [{ code: "101" }], note: "Keep this" }]),
    );
    storage.setItem(
      "biff.savedplans.v1",
      JSON.stringify([{ id: "plan-1", name: "First choice", codes: ["101"], createdAt: 123 }]),
    );
    storage.setItem("biff.ranks.v1", JSON.stringify({ "101": 1 }));
    storage.setItem("biff.settings.v1", JSON.stringify({ transitMin: 10, theme: "dark" }));
    storage.setItem("iffday.workspace.cache.v1:user_other", "private-workspace");
    const records = readWorkspace(storage);
    expect(JSON.stringify(records)).not.toContain("private-workspace");
    writeWorkspace(storage, records);
    expect(readWorkspace(storage)).toEqual(records);
    expect(storage.getItem("iffday.workspace.cache.v1:user_other")).toBe("private-workspace");
    expect(JSON.parse(storage.getItem("biff.picks.v2")!)[0].note).toBe("Keep this");
  });
});
