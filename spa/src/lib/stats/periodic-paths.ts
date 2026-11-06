// R122 / T2.4: 周期统计渲染 helper —— 从 wiki tree 抽取 docs/stats/aggregated/ 下的 md 文件.
// 关注点:
//   - 输入: wiki tree 节点 (wiki/tree API 响应 .tree 数组), 树形递归结构 (children?)
//   - 输出: 按 period 分类的相对路径数组 (path 形如 docs/stats/aggregated/YYYY-MM-DD.md).
//   - period 推断: 文件名匹配 ISO 8601 命名 (YYYY-MM-DD / YYYY-Www / YYYY-MM / YYYY),
//     其它命名归 "other" 桶 (兜底, 不丢).
//   - 纯函数, 不依赖 DOM, 方便单测 mock.

export type WikiTreeNode = {
  name: string;
  path: string; // 文件: 相对 cwd 的 posix 路径; 目录: ""
  children?: WikiTreeNode[];
};

export type PeriodicBucket = "daily" | "weekly" | "monthly" | "yearly" | "other";

export interface PeriodicFile {
  /** 相对项目 cwd 的 posix 路径, 形如 "docs/stats/aggregated/2026-08-28.md" */
  path: string;
  /** 文件名 (basename), 用于排序 / 显示 */
  name: string;
  /** 按 ISO 8601 文件名命名规范推断的 period 桶 */
  bucket: PeriodicBucket;
}

const RE_DAILY = /^\d{4}-\d{2}-\d{2}\.md$/;
const RE_WEEKLY = /^\d{4}-W\d{2}\.md$/;
const RE_MONTHLY = /^\d{4}-\d{2}\.md$/;
const RE_YEARLY = /^\d{4}\.md$/;

export function bucketOf(filename: string): PeriodicBucket {
  if (RE_DAILY.test(filename)) return "daily";
  if (RE_WEEKLY.test(filename)) return "weekly";
  if (RE_YEARLY.test(filename)) return "yearly";
  if (RE_MONTHLY.test(filename)) return "monthly";
  return "other";
}

// 功能: 在 wiki tree 里递归找前缀为 prefix 的目录, 收集该目录下所有 .md 文件路径.
// 关注点: tree 节点 path=""/name=目录名 时是目录, path="<rel>" 时是文件; 目录一定有 children.
//          prefix 形如 "docs/stats/aggregated" (不带尾 /). 返回的文件 path 一定是
//          以 prefix + "/" 开头的相对路径 (与 wiki API 输出一致).
export function collectUnderPrefix(
  tree: WikiTreeNode[],
  prefix: string,
  out: PeriodicFile[] = []
): PeriodicFile[] {
  const prefixSegs = prefix.split("/").filter(Boolean);
  collectUnderPrefixInner(tree, prefixSegs, 0, out);
  return out;
}

function collectUnderPrefixInner(
  nodes: WikiTreeNode[],
  prefixSegs: string[],
  depth: number,
  out: PeriodicFile[]
): void {
  for (const node of nodes) {
    if (node.children) {
      // 目录: 检查 name 是否匹配当前 prefix 段; 不匹配就跳过整棵子树.
      if (depth < prefixSegs.length && node.name === prefixSegs[depth]) {
        collectUnderPrefixInner(node.children, prefixSegs, depth + 1, out);
      }
      continue;
    }
    // 文件: 只在 depth 等于 prefix 长度时收 (路径必须完全等于 prefix).
    if (depth === prefixSegs.length && node.path) {
      const filename = node.name;
      out.push({
        path: node.path,
        name: filename,
        bucket: bucketOf(filename),
      });
    }
  }
}

// 功能: 把 PeriodicFile 数组按 bucket 分组, 组内按 name 降序 (新→旧).
// 关注点: 顺序固定 daily → weekly → monthly → yearly → other; 同组内字典序降序.
export function groupByBucket(files: PeriodicFile[]): Record<PeriodicBucket, PeriodicFile[]> {
  const groups: Record<PeriodicBucket, PeriodicFile[]> = {
    daily: [],
    weekly: [],
    monthly: [],
    yearly: [],
    other: [],
  };
  for (const f of files) groups[f.bucket].push(f);
  for (const k of Object.keys(groups) as PeriodicBucket[]) {
    groups[k].sort((a, b) => b.name.localeCompare(a.name));
  }
  return groups;
}
