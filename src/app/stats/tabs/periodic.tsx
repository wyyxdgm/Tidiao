// R122 / T2.4: 周期总结 tab —— 渲染项目仓 docs/stats/aggregated/ 下的聚合 md 文件清单.
// 不跑 SQL, 不 AI 总结: 走 C4 拍板的"项目仓自带汇总最准"路线, 主 partner 仅渲染路径列表.
// 数据源:
//   - GET /api/projects 拿本账号可见的所有项目
//   - 每个项目调 GET /api/projects/[id]/wiki/tree, 客户端过滤 docs/stats/aggregated/
// 关注点:
//   - 单文件渲染走 wiki API (?path=docs/stats/aggregated/<file>.md), 这里只列出 link.
//   - 链接形如 `<project_name>:docs/stats/aggregated/<file>.md`, 跳 /{projectId}/wiki?path=....
//   - 项目没 aggregated 目录 (或 cwd 不存在) 静默跳过, 不污染页面.
//   - 周期桶: 日 / 周 / 月 / 年 / 其他 (helper 在 src/lib/stats/periodic-paths.ts).

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  collectUnderPrefix,
  groupByBucket,
  type WikiTreeNode,
  type PeriodicFile,
  type PeriodicBucket,
} from "@/lib/stats/periodic-paths";

const PREFIX = "docs/stats/aggregated";
const BUCKET_LABEL: Record<PeriodicBucket, string> = {
  daily: "日报",
  weekly: "周报",
  monthly: "月报",
  yearly: "年报",
  other: "其他",
};

type ProjectRow = { id: string; name: string; cwd: string | null };

type ProjectAggregate = {
  project: ProjectRow;
  files: PeriodicFile[];
  error?: string;
};

export default function PeriodicTab() {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [aggregates, setAggregates] = useState<ProjectAggregate[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => {
        const list = Array.isArray(d.projects) ? d.projects : [];
        setProjects(list);
        return list;
      })
      .then(async (list) => {
        // 并行拉每个项目的 wiki/tree
        const results = await Promise.all(
          list.map(async (p: ProjectRow) => {
            if (!p.cwd) {
              return { project: p, files: [], error: "no-cwd" };
            }
            try {
              const r = await fetch(`/api/projects/${p.id}/wiki/tree`);
              if (!r.ok) return { project: p, files: [], error: `HTTP ${r.status}` };
              const d = await r.json();
              const tree: WikiTreeNode[] = Array.isArray(d.tree) ? d.tree : [];
              const files = collectUnderPrefix(tree, PREFIX);
              return { project: p, files };
            } catch (e) {
              return { project: p, files: [], error: String(e) };
            }
          })
        );
        setAggregates(results);
      })
      .catch((e) => setErr(String(e)));
  }, []);

  if (err) {
    return <div className="text-sm text-red-600">加载失败：{err}</div>;
  }
  if (!projects || !aggregates) {
    return (
      <div className="min-h-[200px] flex items-center justify-center text-gray-400">
        加载中...
      </div>
    );
  }

  const projectsWithFiles = aggregates.filter((a) => a.files.length > 0);
  const totalFiles = aggregates.reduce((s, a) => s + a.files.length, 0);
  const projectsNoData = aggregates.length - projectsWithFiles.length;

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg border p-5">
        <h2 className="font-medium text-gray-900 mb-2">周期总结</h2>
        <p className="text-xs text-gray-500 mb-4">
          按 C4 拍板：汇总产物落项目仓 <code>&lt;project&gt;/docs/stats/aggregated/</code>，主 partner 不集中汇总。本 tab 仅渲染路径清单，点击跳项目 wiki 查阅正文。
        </p>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          <StatCard label="项目数" value={String(aggregates.length)} />
          <StatCard label="有聚合报告" value={String(projectsWithFiles.length)} />
          <StatCard label="聚合文件总数" value={String(totalFiles)} />
          <StatCard label="无 aggregated/ 目录" value={String(projectsNoData)} />
        </div>

        {projectsWithFiles.length === 0 ? (
          <p className="text-sm text-gray-400 py-8 text-center">
            本账号下项目都还没维护 <code>docs/stats/aggregated/</code>。项目 partner 写聚合 md 后将出现在这里。
          </p>
        ) : (
          <div className="space-y-4">
            {projectsWithFiles.map((agg) => {
              const groups = groupByBucket(agg.files);
              return (
                <div key={agg.project.id} className="border rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-medium text-gray-900">
                      {agg.project.name}
                    </h3>
                    <span className="text-xs text-gray-400">
                      {agg.files.length} 个文件
                    </span>
                  </div>
                  <div className="space-y-2">
                    {(Object.keys(groups) as PeriodicBucket[])
                      .filter((b) => groups[b].length > 0)
                      .map((b) => (
                        <div key={b}>
                          <div className="text-xs text-gray-500 mb-1">
                            {BUCKET_LABEL[b]}（{groups[b].length}）
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {groups[b].map((f) => (
                              <Link
                                key={f.path}
                                href={`/#/${agg.project.id}/wiki?path=${encodeURIComponent(f.path)}`}
                                className="inline-block text-xs px-2 py-1 rounded border border-gray-200 hover:border-blue-400 hover:bg-blue-50 text-gray-700 hover:text-blue-700"
                              >
                                {f.name}
                              </Link>
                            ))}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {projectsNoData > 0 && (
        <p className="text-xs text-gray-400">
          提示：{projectsNoData} 个项目暂无 <code>docs/stats/aggregated/</code> 目录（CWD 不存在或目录未建）。
        </p>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-50 rounded border p-3">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-lg font-semibold text-gray-900">{value}</div>
    </div>
  );
}
