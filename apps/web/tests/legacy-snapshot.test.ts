import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps the legacy TypeScript fallback identical to the 8a95215 snapshot", () => {
  const manifest = JSON.parse(readFileSync("legacy/source-manifest.json", "utf8")) as {revision: string; files: Record<string, string>};
  expect(manifest.revision.startsWith("8a95215")).toBe(true);
  expect(Object.keys(manifest.files)).toContain("src/main.ts");
  for (const [file, digest] of Object.entries(manifest.files)) {
    expect(createHash("sha256").update(readFileSync(`legacy/${file}`)).digest("hex"), file).toBe(digest);
  }
});
