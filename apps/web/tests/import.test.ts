import { expect, it } from "vitest";
import { hasImportableData } from "@biff/contracts/import";
it("ignores empty storage, containers and blank values", () => {
  const cases: Record<string, string>[] = [{}, { "local:biff.picks.v2": "[]" }, { "local:biff.preferences": "{}" }, { "local:biff.value": "null" }, { "local:biff.value": '"  "' }, { "other.site": '"data"' }];
  for (const records of cases) expect(hasImportableData(records)).toBe(false);
});
it("preserves real picks and explicit false or zero preferences", () => {
  const cases: Record<string, string>[] = [{ "pick:film": '{"key":"film","codes":{},"note":""}' }, { "local:biff.settings": '{"transitMin":0}' }, { "local:biff.settings": '{"gvTalkOn":false}' }];
  for (const records of cases) expect(hasImportableData(records)).toBe(true);
});
