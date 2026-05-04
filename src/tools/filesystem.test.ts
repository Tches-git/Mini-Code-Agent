import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTreeFilesOutput,
  cleanupExtractedText,
  columnLettersToIndex,
  countPdfPages,
  decodeXmlEntities,
  extractOpenDocumentCellText,
  extractXmlTextRuns,
  formatReadFileContent,
  getBackupRelativePath,
  getExtension,
  getMimeType,
  getXmlTagText,
  inspectFileContent,
  inspectImageDimensions,
  isProbablyTextBuffer,
  isReadableTextFile,
  normalizeImportMode,
  normalizeSlashes,
  parseSharedStrings,
  parseXlsxCellValue,
  parseXlsxSheetRows,
  replaceLineRangeContent,
  resolveAccessiblePath,
  resolveWorkspacePath,
  sanitizeFileName,
  stripXmlTags,
  toDiffLabel,
  toDisplayPath,
  toWorkspaceRelative,
} from "./filesystem.js";

const root = process.cwd();
let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("decodeXmlEntities", () => {
  it("解码标准 XML 实体", () => {
    expect(decodeXmlEntities("&amp;&lt;&gt;&quot;&apos;")).toBe("&<>\"'");
  });

  it("解码十进制数字实体", () => {
    expect(decodeXmlEntities("&#65;&#66;")).toBe("AB");
  });

  it("解码十六进制数字实体", () => {
    expect(decodeXmlEntities("&#x41;&#x42;")).toBe("AB");
  });

  it("混合内容保留普通文本", () => {
    expect(decodeXmlEntities("hello &amp; world")).toBe("hello & world");
  });

  it("已解码文本原样返回", () => {
    expect(decodeXmlEntities("no entities here")).toBe("no entities here");
  });
});

describe("cleanupExtractedText", () => {
  it("CRLF 转 LF", () => {
    expect(cleanupExtractedText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("NBSP 替换为普通空格", () => {
    expect(cleanupExtractedText("hello\u00a0world")).toBe("hello world");
  });

  it("去除行尾空白", () => {
    expect(cleanupExtractedText("hello   \nworld\t\n")).toBe("hello\nworld");
  });

  it("压缩过多空行", () => {
    expect(cleanupExtractedText("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("首尾 trim", () => {
    expect(cleanupExtractedText("  hello  ")).toBe("hello");
  });
});

describe("stripXmlTags", () => {
  it("去除 XML 标签", () => {
    expect(stripXmlTags("<p>hello</p>")).toBe("hello");
  });

  it("<br/> 转换为换行", () => {
    expect(stripXmlTags("a<br/>b")).toBe("a\nb");
  });

  it("<text:line-break/> 转换为换行", () => {
    expect(stripXmlTags("a<text:line-break/>b")).toBe("a\nb");
  });

  it("<text:tab/> 转换为制表符", () => {
    expect(stripXmlTags("a<text:tab/>b")).toBe("a\tb");
  });

  it("解码标签内实体", () => {
    expect(stripXmlTags("<p>&amp;</p>")).toBe("&");
  });
});

describe("extractXmlTextRuns", () => {
  it("提取 <t> 标签内容", () => {
    expect(extractXmlTextRuns("<t>hello</t>")).toEqual(["hello"]);
  });

  it("提取命名空间 <a:t> 标签内容", () => {
    expect(extractXmlTextRuns('<a:t xml:space="preserve">world</a:t>')).toEqual(
      ["world"],
    );
  });

  it("提取多个 run", () => {
    expect(extractXmlTextRuns("<t>a</t><t>b</t>")).toEqual(["a", "b"]);
  });

  it("无匹配返回空数组", () => {
    expect(extractXmlTextRuns("<p>no runs</p>")).toEqual([]);
  });

  it("过滤空白 run", () => {
    expect(extractXmlTextRuns("<t>  </t><t>valid</t>")).toEqual(["valid"]);
  });
});

describe("getXmlTagText", () => {
  it("提取命名标签内容", () => {
    expect(getXmlTagText("<v>42</v>", "v")).toBe("42");
  });

  it("缺失标签返回空字符串", () => {
    expect(getXmlTagText("<other>42</other>", "v")).toBe("");
  });

  it("带属性的标签", () => {
    expect(getXmlTagText('<v style="bold">text</v>', "v")).toBe("text");
  });
});

describe("columnLettersToIndex", () => {
  it("A = 0", () => expect(columnLettersToIndex("A")).toBe(0));
  it("B = 1", () => expect(columnLettersToIndex("B")).toBe(1));
  it("Z = 25", () => expect(columnLettersToIndex("Z")).toBe(25));
  it("AA = 26", () => expect(columnLettersToIndex("AA")).toBe(26));
  it("AB = 27", () => expect(columnLettersToIndex("AB")).toBe(27));
  it("AZ = 51", () => expect(columnLettersToIndex("AZ")).toBe(51));
  it("小写自动转大写", () => expect(columnLettersToIndex("a")).toBe(0));
});

describe("parseSharedStrings", () => {
  it("解析 <si> 元素", () => {
    const xml = "<sst><si><t>hello</t></si><si><t>world</t></si></sst>";
    expect(parseSharedStrings(xml)).toEqual(["hello", "world"]);
  });

  it("含多个 <t> run 的 <si>", () => {
    const xml = "<sst><si><r><t>a</t></r><r><t>b</t></r></si></sst>";
    expect(parseSharedStrings(xml)).toEqual(["ab"]);
  });

  it("空 XML 返回空数组", () => {
    expect(parseSharedStrings("")).toEqual([]);
  });
});

describe("parseXlsxCellValue", () => {
  const shared = ["零", "一", "二"];

  it("type=s 查共享字符串", () => {
    expect(parseXlsxCellValue("<v>1</v>", 't="s" r="A1"', shared)).toBe("一");
  });

  it("type=inlineStr 提取内联文本", () => {
    expect(
      parseXlsxCellValue("<is><t>inline</t></is>", 't="inlineStr"', shared),
    ).toBe("inline");
  });

  it("type=b 布尔值 1→TRUE", () => {
    expect(parseXlsxCellValue("<v>1</v>", 't="b"', shared)).toBe("TRUE");
  });

  it("type=b 布尔值 0→FALSE", () => {
    expect(parseXlsxCellValue("<v>0</v>", 't="b"', shared)).toBe("FALSE");
  });

  it("type=str 直接提取 <v>", () => {
    expect(parseXlsxCellValue("<v>formula result</v>", 't="str"', shared)).toBe(
      "formula result",
    );
  });

  it("无 type（数字）提取 <v>", () => {
    expect(parseXlsxCellValue("<v>42</v>", 'r="A1"', shared)).toBe("42");
  });

  it("共享字符串索引越界返回空", () => {
    expect(parseXlsxCellValue("<v>99</v>", 't="s"', shared)).toBe("");
  });
});

describe("parseXlsxSheetRows", () => {
  const shared = ["姓名", "年龄", "张三"];

  it("解析制表符分隔的行", () => {
    const xml =
      '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData>';
    expect(parseXlsxSheetRows(xml, shared)).toEqual(["姓名\t年龄"]);
  });

  it("处理稀疏列（跳过空列）", () => {
    const xml =
      '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row></sheetData>';
    const rows = parseXlsxSheetRows(xml, shared);
    expect(rows[0]).toBe("姓名\t\t年龄");
  });

  it("裁剪尾部空列", () => {
    const xml =
      '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData>';
    expect(parseXlsxSheetRows(xml, shared)).toEqual(["姓名"]);
  });

  it("跳过全空行", () => {
    const xml = '<sheetData><row r="1"></row></sheetData>';
    expect(parseXlsxSheetRows(xml, shared)).toEqual([]);
  });
});

describe("extractOpenDocumentCellText", () => {
  it("提取 <text:p> 段落", () => {
    expect(
      extractOpenDocumentCellText(
        "<text:p>hello</text:p><text:p>world</text:p>",
      ),
    ).toBe("hello world");
  });

  it("无 <text:p> 时回退到 stripXmlTags", () => {
    expect(extractOpenDocumentCellText("<span>fallback</span>")).toBe(
      "fallback",
    );
  });

  it("空内容返回空字符串", () => {
    expect(extractOpenDocumentCellText("")).toBe("");
  });
});

describe("sanitizeFileName", () => {
  it("替换特殊字符", () => {
    expect(sanitizeFileName("file name!@#$.ts")).toBe("file-name-.ts");
  });

  it("保留合法字符", () => {
    expect(sanitizeFileName("valid-name_v2.ts")).toBe("valid-name_v2.ts");
  });

  it("空结果返回 imported-file", () => {
    expect(sanitizeFileName("!!!")).toBe("imported-file");
  });

  it("去除首尾连字符", () => {
    expect(sanitizeFileName("-test-")).toBe("test");
  });
});

describe("getExtension", () => {
  it("提取小写扩展名", () => {
    expect(getExtension("file.TS")).toBe(".ts");
  });

  it("无扩展名返回空", () => {
    expect(getExtension("Makefile")).toBe("");
  });

  it("多点取最后", () => {
    expect(getExtension("file.test.ts")).toBe(".ts");
  });
});

describe("normalizeImportMode", () => {
  it("auto + 文档扩展名 → extract_text", () => {
    expect(normalizeImportMode("/a/b.xlsx", "auto")).toBe("extract_text");
    expect(normalizeImportMode("/a/b.docx", "auto")).toBe("extract_text");
    expect(normalizeImportMode("/a/b.pdf", "auto")).toBe("extract_text");
  });

  it("auto + 普通扩展名 → copy", () => {
    expect(normalizeImportMode("/a/b.ts", "auto")).toBe("copy");
    expect(normalizeImportMode("/a/b.png", "auto")).toBe("copy");
  });

  it("显式模式直通", () => {
    expect(normalizeImportMode("/a/b.ts", "extract_text")).toBe("extract_text");
    expect(normalizeImportMode("/a/b.xlsx", "copy")).toBe("copy");
  });
});

describe("isReadableTextFile", () => {
  it("文本文件扩展名返回 true", () => {
    expect(isReadableTextFile("a.ts")).toBe(true);
    expect(isReadableTextFile("b.md")).toBe(true);
    expect(isReadableTextFile("c.json")).toBe(true);
    expect(isReadableTextFile("d.csv")).toBe(true);
  });

  it("非文本文件返回 false", () => {
    expect(isReadableTextFile("a.xlsx")).toBe(false);
    expect(isReadableTextFile("b.pdf")).toBe(false);
    expect(isReadableTextFile("c.png")).toBe(false);
  });
});

describe("inspect helpers", () => {
  it("根据扩展名推断 MIME", () => {
    expect(getMimeType("a.png")).toBe("image/png");
    expect(getMimeType("a.md")).toBe("text/markdown");
    expect(getMimeType("a.unknown")).toBe("application/octet-stream");
  });

  it("判断文本和二进制 buffer", () => {
    expect(isProbablyTextBuffer(Buffer.from("hello\nworld", "utf8"))).toBe(
      true,
    );
    expect(isProbablyTextBuffer(Buffer.from([0, 1, 2, 3]))).toBe(false);
  });

  it("读取 PNG 尺寸", () => {
    const buffer = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(
      buffer,
      0,
    );
    buffer.writeUInt32BE(640, 16);
    buffer.writeUInt32BE(480, 20);

    expect(inspectImageDimensions(buffer, "image.png")).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("读取 WebP VP8X 尺寸", () => {
    const buffer = Buffer.alloc(30);
    buffer.write("RIFF", 0, "ascii");
    buffer.write("WEBP", 8, "ascii");
    buffer.write("VP8X", 12, "ascii");
    buffer.writeUIntLE(639, 24, 3);
    buffer.writeUIntLE(479, 27, 3);

    expect(inspectImageDimensions(buffer, "image.webp")).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("统计 PDF 页数", () => {
    const pdf = Buffer.from(
      "%PDF-1.7\n1 0 obj<</Type /Page>>\n2 0 obj<</Type /Pages>>\n3 0 obj<</Type /Page>>",
      "latin1",
    );
    expect(countPdfPages(pdf)).toBe(2);
  });

  it("输出文件摘要和建议", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "inspect-file-"));
    const filePath = path.join(tempDir, "notes.txt");
    await fs.writeFile(filePath, "hello", "utf8");

    const result = JSON.parse(
      await inspectFileContent({ path: filePath, confirmed: true }),
    ) as {
      sizeBytes: number;
      extension: string;
      likelyText: boolean;
      suggestion: string;
    };

    expect(result.sizeBytes).toBe(5);
    expect(result.extension).toBe(".txt");
    expect(result.likelyText).toBe(true);
    expect(result.suggestion).toContain("read_file");
  });
});

describe("normalizeSlashes", () => {
  it("反斜杠转正斜杠", () => {
    expect(normalizeSlashes("a\\b\\c")).toBe("a/b/c");
  });

  it("已是正斜杠不变", () => {
    expect(normalizeSlashes("a/b/c")).toBe("a/b/c");
  });
});

describe("resolveWorkspacePath", () => {
  it("相对路径正常解析", () => {
    expect(resolveWorkspacePath("src/index.ts")).toBe(
      path.join(root, "src/index.ts"),
    );
  });

  it("../  逃逸抛错", () => {
    expect(() => resolveWorkspacePath("../outside")).toThrow(
      "禁止访问工作区外路径",
    );
  });

  it("绝对路径逃逸抛错", () => {
    expect(() => resolveWorkspacePath("/tmp/evil")).toThrow(
      "禁止访问工作区外路径",
    );
  });
});

describe("resolveAccessiblePath", () => {
  it("工作区内路径无需确认", () => {
    expect(resolveAccessiblePath("src/index.ts")).toBe(
      path.resolve(root, "src/index.ts"),
    );
  });

  it("工作区外未确认抛错", () => {
    expect(() => resolveAccessiblePath("/tmp/outside")).toThrow("需要用户确认");
  });

  it("confirmed=true 允许工作区外路径", () => {
    expect(resolveAccessiblePath("/tmp/outside", true)).toBe(
      path.resolve(root, "/tmp/outside"),
    );
  });
});

describe("toWorkspaceRelative", () => {
  it("绝对路径转相对", () => {
    const abs = path.join(root, "src/index.ts");
    expect(toWorkspaceRelative(abs)).toBe("src/index.ts");
  });
});

describe("toDisplayPath", () => {
  it("工作区内路径显示为相对", () => {
    expect(toDisplayPath("src/index.ts")).toBe("src/index.ts");
  });

  it("工作区外路径显示为绝对", () => {
    const result = toDisplayPath("/tmp/outside.ts");
    expect(result).toContain("/tmp/outside.ts");
  });
});

describe("formatReadFileContent", () => {
  it("默认返回带文件、行号和截断信息的内容", () => {
    const result = formatReadFileContent("a\nb\nc", { path: "src/a.ts" });

    expect(result).toBe(
      [
        "File: src/a.ts",
        "Lines: 1-3 of 3",
        "Truncated: false",
        "",
        "a",
        "b",
        "c",
      ].join("\n"),
    );
  });

  it("支持 offset/limit 分页并提示继续读取参数", () => {
    const result = formatReadFileContent("a\nb\nc\nd", {
      path: "src/a.ts",
      offset: 1,
      limit: 2,
    });

    expect(result).toBe(
      [
        "File: src/a.ts",
        "Lines: 2-3 of 4",
        "Truncated: true (use offset=3, limit=2 to continue)",
        "",
        "b",
        "c",
      ].join("\n"),
    );
  });
});

describe("buildTreeFilesOutput", () => {
  it("输出目录树并跳过默认忽略目录", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-files-"));
    await fs.mkdir(path.join(tempDir, "src", "nested"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "node_modules", "pkg"), {
      recursive: true,
    });
    await fs.writeFile(path.join(tempDir, "src", "index.ts"), "", "utf8");
    await fs.writeFile(
      path.join(tempDir, "src", "nested", "deep.ts"),
      "",
      "utf8",
    );
    await fs.writeFile(path.join(tempDir, "README.md"), "", "utf8");

    const result = await buildTreeFilesOutput({
      path: tempDir,
      maxDepth: 3,
      confirmed: true,
    });

    expect(result).toContain("src/");
    expect(result).toContain("index.ts");
    expect(result).toContain("README.md");
    expect(result).not.toContain("node_modules/");
    expect(result).toContain("Skipped ignored directories: 1");
    expect(result).toContain("Truncated: false");
  });

  it("遵守 maxEntries 截断", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-files-limit-"));
    await fs.writeFile(path.join(tempDir, "a.ts"), "", "utf8");
    await fs.writeFile(path.join(tempDir, "b.ts"), "", "utf8");

    const result = await buildTreeFilesOutput({
      path: tempDir,
      maxEntries: 1,
      confirmed: true,
    });

    expect(result).toContain("Entries: 1");
    expect(result).toContain("Truncated: true");
  });
});

describe("replaceLineRangeContent", () => {
  it("替换单行", () => {
    expect(
      replaceLineRangeContent("a\nb\nc", {
        path: "x.ts",
        startLine: 2,
        endLine: 2,
        content: "B",
      }),
    ).toBe("a\nB\nc");
  });

  it("替换多行为多行", () => {
    expect(
      replaceLineRangeContent("a\nb\nc\nd", {
        path: "x.ts",
        startLine: 2,
        endLine: 3,
        content: "B\nC",
      }),
    ).toBe("a\nB\nC\nd");
  });

  it("拒绝无效行号范围", () => {
    expect(() =>
      replaceLineRangeContent("a\nb", {
        path: "x.ts",
        startLine: 2,
        endLine: 1,
        content: "x",
      }),
    ).toThrow("行号范围无效");
  });

  it("拒绝越界行号", () => {
    expect(() =>
      replaceLineRangeContent("a\nb", {
        path: "x.ts",
        startLine: 2,
        endLine: 3,
        content: "x",
      }),
    ).toThrow("行号范围超出文件长度");
  });
});

describe("toDiffLabel", () => {
  it("去除前导斜杠", () => {
    expect(toDiffLabel("/src/index.ts")).toBe("src/index.ts");
  });

  it("无前导斜杠不变", () => {
    expect(toDiffLabel("src/index.ts")).toBe("src/index.ts");
  });
});

describe("getBackupRelativePath", () => {
  it("工作区文件返回相对路径", () => {
    const filePath = path.join(root, "src/index.ts");
    expect(getBackupRelativePath(filePath)).toBe(path.join("src", "index.ts"));
  });

  it("外部文件返回 __external__ 前缀路径", () => {
    const result = getBackupRelativePath("/tmp/test.ts");
    expect(result).toContain("__external__");
    expect(result).toContain("test.ts");
  });
});
