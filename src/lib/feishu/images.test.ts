// 飞书取图解析器的回归测试.
//
// 这些 fixture 是**真实 lark-cli 输出**的节选(实测表 1.6期 第 3 行, 2026-08-10),
// 不是手编的 —— 手编 fixture 测不出"字段名/嵌套层级记错"这类最容易犯的错.

import { describe, it, expect } from "vitest";
import {
  parseEmbedImages,
  parseFloatImages,
  mediaTypeToExt,
  imageBasename,
} from "./images";

// 真实 +cells-get --range A3:H3 --include value 输出的结构(文字内容已截短).
const CELLS_GET = JSON.stringify({
  ok: true,
  data: {
    has_more: false,
    ranges: [
      {
        actual_range: "A3:H3",
        cells: [
          [
            {},
            {},
            { value: "产品详情页" },
            { value: "example" },
            { value: "这里加上最新净值日期..." },
            {
              rich_text: [
                {
                  image_height: 59,
                  image_token: "FNf3bMe9WoRhPYxTqMbcZRgtnph",
                  image_width: 206,
                  text: "",
                  type: "embed-image",
                },
              ],
            },
            {},
            {},
          ],
        ],
        col_indices: ["A", "B", "C", "D", "E", "F", "G", "H"],
        row_indices: [3],
      },
    ],
  },
});

// 真实 +float-image-list 输出.
const FLOAT_LIST = JSON.stringify({
  ok: true,
  data: {
    sheets: [
      {
        sheet_id: "1XzOKi",
        sheet_name: "1.6期",
        float_images: [
          {
            address: "G3",
            float_image_id: "83V8Drogs4",
            image_token: "I2djbmQJ3oFASpxnHWGctrOXnmg",
            position: { col: "G", row: 2 }, // 0-based —— 故意与 address 不一致
            url: "https://ee-box.byted.org/api/box/stream/download/authcode/?code=x",
          },
        ],
      },
    ],
    total: 1,
  },
});

describe("parseEmbedImages", () => {
  it("从 rich_text 里取出 cell 内嵌图, 行列取自 row_indices/col_indices", () => {
    const imgs = parseEmbedImages(CELLS_GET);
    expect(imgs).toEqual([
      { row: 3, column: "F", imageToken: "FNf3bMe9WoRhPYxTqMbcZRgtnph", kind: "embed" },
    ]);
  });

  it("有 value 没 rich_text 的普通文字格不算图", () => {
    // C/D/E 都有 value, 不应该被当成图.
    expect(parseEmbedImages(CELLS_GET)).toHaveLength(1);
  });

  it("空结果不抛", () => {
    expect(parseEmbedImages(JSON.stringify({ ok: true, data: { ranges: [] } }))).toEqual([]);
    expect(parseEmbedImages(JSON.stringify({ ok: true, data: {} }))).toEqual([]);
  });

  it("列字母来自 col_indices 而非数组下标 —— 范围不从 A 开始时也对", () => {
    // 真实场景: --range F3:G3 时 cells[0][0] 是 F 列, 按下标数会错成 A.
    const partial = JSON.stringify({
      data: {
        ranges: [{
          cells: [[{ rich_text: [{ type: "embed-image", image_token: "tok" }] }]],
          col_indices: ["F"],
          row_indices: [3],
        }],
      },
    });
    expect(parseEmbedImages(partial)[0].column).toBe("F");
  });

  it("rich_text 里混着文字段时只取 embed-image", () => {
    const mixed = JSON.stringify({
      data: {
        ranges: [{
          cells: [[{
            rich_text: [
              { type: "text", text: "说明文字" },
              { type: "embed-image", image_token: "tok1" },
            ],
          }]],
          col_indices: ["E"],
          row_indices: [7],
        }],
      },
    });
    expect(parseEmbedImages(mixed)).toEqual([
      { row: 7, column: "E", imageToken: "tok1", kind: "embed" },
    ]);
  });
});

describe("parseFloatImages", () => {
  it("用 address 定位(1-based), 不用 position.row(0-based)", () => {
    const imgs = parseFloatImages(FLOAT_LIST, "1.6期");
    expect(imgs).toEqual([
      { row: 3, column: "G", imageToken: "I2djbmQJ3oFASpxnHWGctrOXnmg", kind: "float" },
    ]);
    // 这条断言就是防线本身: position.row 是 2, 拿它当行号会整体错一行.
    expect(imgs[0].row).not.toBe(2);
  });

  it("按 sheet_name 过滤 —— 这个接口返回整个 spreadsheet 的所有 sheet", () => {
    const twoSheets = JSON.stringify({
      data: {
        sheets: [
          { sheet_name: "1.6期", float_images: [{ address: "G3", image_token: "a" }] },
          { sheet_name: "1.5期", float_images: [{ address: "G9", image_token: "b" }] },
        ],
      },
    });
    expect(parseFloatImages(twoSheets, "1.6期").map((i) => i.imageToken)).toEqual(["a"]);
    // 不传 sheetName 时不过滤(两张都要).
    expect(parseFloatImages(twoSheets)).toHaveLength(2);
  });

  it("双字母列(AA 之后)也能解析", () => {
    const wide = JSON.stringify({
      data: { sheets: [{ sheet_name: "s", float_images: [{ address: "AB12", image_token: "t" }] }] },
    });
    expect(parseFloatImages(wide, "s")).toEqual([
      { row: 12, column: "AB", imageToken: "t", kind: "float" },
    ]);
  });

  it("缺 address 或缺 token 的条目直接跳过, 不产出半个结果", () => {
    const broken = JSON.stringify({
      data: {
        sheets: [{
          sheet_name: "s",
          float_images: [
            { image_token: "no-address" },
            { address: "G3" },
            { address: "G4", image_token: "ok" },
          ],
        }],
      },
    });
    expect(parseFloatImages(broken, "s")).toEqual([
      { row: 4, column: "G", imageToken: "ok", kind: "float" },
    ]);
  });

  it("空结果不抛", () => {
    expect(parseFloatImages(JSON.stringify({ data: { sheets: [] } }))).toEqual([]);
    expect(parseFloatImages(JSON.stringify({ data: {} }))).toEqual([]);
  });
});

describe("mediaTypeToExt", () => {
  it("常见图片类型映射", () => {
    expect(mediaTypeToExt("image/png")).toBe(".png");
    expect(mediaTypeToExt("image/jpeg")).toBe(".jpg");
    expect(mediaTypeToExt("IMAGE/PNG")).toBe(".png"); // 大小写不敏感
  });

  it("认不出的类型回退 .png 而不是空扩展名", () => {
    // 空扩展名会让 Read 认不出是图, 也让 symlink 名字变难看.
    expect(mediaTypeToExt("application/octet-stream")).toBe(".png");
    expect(mediaTypeToExt("")).toBe(".png");
  });
});

describe("imageBasename", () => {
  const img = { row: 3, column: "F", imageToken: "t", kind: "embed" as const };

  it("文件名带上行列 = agent 一眼看出图贴在哪", () => {
    expect(imageBasename(img, 1)).toBe("R3-F");
  });

  it("一格多张时加序号后缀, 不互相覆盖", () => {
    // 浮动图允许一格多张(damo: "爱放几张放几张"), 不加后缀会写同一个文件名.
    expect(imageBasename(img, 2)).toBe("R3-F-2");
    expect(imageBasename(img, 3)).toBe("R3-F-3");
  });
});
