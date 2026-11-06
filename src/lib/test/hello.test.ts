// 功能: hello world 冒烟测试 —— 验证 vitest 配置可用, 在控制台输出 "hello world".
// 关注点: 这是需求点 8d0b4c4a-... 的最小测试; 不依赖任何业务模块,
//   仅当 vitest 跑通时才算满足"输出 hello world". stdout 由 vitest 自动捕获.
import { describe, it } from "vitest";

describe("hello", () => {
  it("outputs hello world", () => {
    console.log("hello world");
  });
});
