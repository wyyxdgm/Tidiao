// wiki 文件路径的安全解析 —— **服务端专用**(import 了 node:fs)。
//
// 为什么单独一个模块而不是留在 route.ts 里:
// 🔴 这个函数原本是 route.ts 的模块私有函数, 测试为了绕开 next/server 的 import 链
//    **抄了一份复刻**到测试文件里。结果是: 突变 route.ts 里真实的穿越防护(把 `..`
//    拦截整行删掉), 36 条测试**全绿** —— 那 4 条声称在测 cwd 锁死/隐藏段/扩展名的
//    断言其实在测试文件自己的副本上跑, 对真实代码零保护(经突变测试实测确认)。
//    所以这里的存在意义就是「唯一实现」: route.ts 与测试必须 import 同一个函数,
//    任何复刻都会重新制造假绿。**不要把它抄回 route.ts, 也不要在测试里再复刻。**
//
// 为什么不放进 wiki-files.ts: 那个文件被前端 import(projects-client / wiki-client),
// 加 node:fs 会把 fs 打进客户端 bundle。判定用的纯函数留在 wiki-files.ts, 碰盘的
// 部分在这里, 分界线就是「要不要 fs」。

import fs from "node:fs";
import path from "node:path";
import { extOf, hasHiddenSegment } from "./wiki-files";

export interface ResolvedWikiFile {
  /** 调用方传进来的相对路径原样返回(用于回给前端显示, 不是 realpath 后的) */
  chosen: string;
  /** realpath 解析后的绝对路径, 已确认在 cwd 内且是普通文件 */
  fullReal: string;
}

// 功能: 安全校验 + 取文件 realpath. 返回 {chosen, fullReal} 或 null(穿越/隐藏/扩展名不放行/不存在).
// 关注点:
//  - 🔴 realpath + path.relative 的 cwd 锁死是核心防线, 顺序不能变: 先 realpath
//    (解开 symlink)再比相对路径, 否则 cwd 内指向 /etc/passwd 的 symlink 能逃出去.
//  - 隐藏路径段(. 开头)硬拒, **不受项目配置影响**. 放开扩展名前, 「必须 .md」间接
//    挡住了 ?path=.claude/x 这类直连; 现在必须显式挡, 否则 scripts/.env.tokens、
//    .git/config 之类会被放行(tree 不列它们, 但直连 URL 照样能读).
//  - 扩展名判定用 allowed 集合而不是硬编码 .md; 判定基于 realpath 的最终文件名,
//    所以 symlink 换壳(a.md -> secret.env)也按真实目标的扩展名判.
//  - 整体 try/catch 成 null: realpathSync 对不存在的路径抛异常, 这里等价于 404.
export function safeResolve(
  cwdReal: string,
  rel: string,
  allowed: Set<string>
): ResolvedWikiFile | null {
  try {
    // 请求路径里就带隐藏段的, 在碰盘之前先拒掉.
    if (hasHiddenSegment(rel.split(path.sep).join("/"))) return null;
    const fullReal = fs.realpathSync(path.join(cwdReal, rel));
    const relFromCwd = path.relative(cwdReal, fullReal);
    // 锁死 cwd: 相对路径不得逃出 cwd.
    if (relFromCwd.startsWith("..") || path.isAbsolute(relFromCwd)) return null;
    // realpath 之后再查一遍隐藏段: symlink 可能指向 cwd 内的隐藏目录.
    if (hasHiddenSegment(relFromCwd.split(path.sep).join("/"))) return null;
    if (!allowed.has(extOf(path.basename(fullReal)))) return null;
    if (!fs.statSync(fullReal).isFile()) return null;
    return { chosen: rel, fullReal };
  } catch {
    return null;
  }
}
