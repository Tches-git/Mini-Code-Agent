import { describe, expect, it } from "vitest";

describe("standalone artifact naming", () => {
  it("prepare release script uses platform-qualified artifact names", async () => {
    const script = await import("../../package.json", {
      with: { type: "json" },
    });
    expect(script.default.scripts["prepare:standalone:release"]).toBe(
      "node ./scripts/prepare-standalone-release.mjs",
    );
  });
});
