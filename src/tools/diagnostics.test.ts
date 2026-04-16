import { describe, expect, it } from "vitest";
import {
  parseBiomeJsonOutput,
  parseBiomeTextOutput,
  parseTscDiagnostics,
} from "./diagnostics.js";

describe("parseTscDiagnostics", () => {
  it("parses standard tsc diagnostics", () => {
    const diagnostics = parseTscDiagnostics(
      [
        "src/index.ts(3,14): error TS2322: Type 'string' is not assignable to type 'number'.",
        "src/app.ts(8,2): warning TS9999: Example warning.",
      ].join("\n"),
    );

    expect(diagnostics).toEqual([
      {
        file: "src/index.ts",
        line: 3,
        column: 14,
        severity: "error",
        code: "TS2322",
        message: "Type 'string' is not assignable to type 'number'.",
        source: "tsc",
      },
      {
        file: "src/app.ts",
        line: 8,
        column: 2,
        severity: "warning",
        code: "TS9999",
        message: "Example warning.",
        source: "tsc",
      },
    ]);
  });
});

describe("parseBiomeJsonOutput", () => {
  it("parses biome json reporter output", () => {
    const diagnostics = parseBiomeJsonOutput(
      JSON.stringify({
        diagnostics: {
          diagnostics: [
            {
              category: "lint/style/useTemplate",
              severity: "error",
              description: "Use a template literal.",
              location: {
                path: {
                  file: "/workspace/src/example.ts",
                },
              },
            },
          ],
        },
      }),
    );

    expect(diagnostics).toEqual([
      {
        file: "/workspace/src/example.ts",
        severity: "error",
        message: "Use a template literal.",
        source: "biome",
        code: "lint/style/useTemplate",
      },
    ]);
  });
});

describe("parseBiomeTextOutput", () => {
  it("parses fallback text output", () => {
    const diagnostics = parseBiomeTextOutput(
      "src/example.ts:12:4 error noDebugger Debugger statements are not allowed.",
    );

    expect(diagnostics).toEqual([
      {
        file: "src/example.ts",
        line: 12,
        column: 4,
        severity: "error",
        message:
          "src/example.ts:12:4 error noDebugger Debugger statements are not allowed.",
        source: "biome",
      },
    ]);
  });
});
