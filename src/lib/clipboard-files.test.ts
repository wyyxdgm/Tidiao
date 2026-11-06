import { describe, it, expect } from "vitest";
import { filesFromDataTransfer, nameForPastedFile } from "./clipboard-files";

describe("nameForPastedFile", () => {
  it("keeps original name when file already has one", () => {
    const f = new File(["x"], "report.md", { type: "text/markdown" });
    expect(nameForPastedFile(f, "0").name).toBe("report.md");
  });

  it("infers .png from image/png", () => {
    const f = new File(["x"], "", { type: "image/png" });
    expect(nameForPastedFile(f, "0").name).toMatch(/^pasted-\d+-0\.png$/);
    expect(nameForPastedFile(f, "0").type).toBe("image/png");
  });

  it("infers .jpg from image/jpeg", () => {
    const f = new File(["x"], "", { type: "image/jpeg" });
    expect(nameForPastedFile(f, "3").name).toMatch(/^pasted-\d+-3\.jpg$/);
  });

  it("falls back to .bin for unknown mime types", () => {
    const f = new File(["x"], "", { type: "application/x-foo" });
    expect(nameForPastedFile(f, "0").name).toMatch(/\.bin$/);
  });

  it("falls back to .bin when type is empty", () => {
    const f = new File(["x"], "");
    expect(nameForPastedFile(f, "0").name).toMatch(/\.bin$/);
  });
});

describe("filesFromDataTransfer", () => {
  function mockDT(opts: {
    items?: Array<{ kind: string; getAsFile: () => File | null }>;
    files?: File[];
  }): DataTransfer {
    return {
      items: opts.items
        ? ({ length: opts.items.length, ...opts.items } as unknown as DataTransferItemList)
        : ([] as unknown as DataTransferItemList),
      files: (opts.files ?? []) as unknown as FileList,
    } as unknown as DataTransfer;
  }

  it("returns [] for null", () => {
    expect(filesFromDataTransfer(null)).toEqual([]);
  });

  it("extracts files via items path (clipboard image case)", () => {
    const img = new File(["img"], "", { type: "image/png" });
    const dt = mockDT({
      items: [{ kind: "file", getAsFile: () => img }],
    });
    const out = filesFromDataTransfer(dt);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("image/png");
    expect(out[0].name).toMatch(/^pasted-\d+-0\.png$/);
  });

  it("skips non-file items (e.g. text/plain clipboard kind)", () => {
    const dt = mockDT({
      items: [
        { kind: "string", getAsFile: () => null },
        { kind: "file", getAsFile: () => new File([""], "a.txt", { type: "text/plain" }) },
      ],
    });
    const out = filesFromDataTransfer(dt);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("a.txt");
  });

  it("falls back to dt.files when items is empty (drop case)", () => {
    const dt = mockDT({
      items: [],
      files: [new File([""], "drop.png", { type: "image/png" })],
    });
    const out = filesFromDataTransfer(dt);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("drop.png");
  });

  it("skips getAsFile() returning null", () => {
    const dt = mockDT({
      items: [
        { kind: "file", getAsFile: () => null },
        { kind: "file", getAsFile: () => new File([""], "ok.png", { type: "image/png" }) },
      ],
    });
    const out = filesFromDataTransfer(dt);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("ok.png");
  });
});