// GET /api/project-templates - List bundled project templates (read-only JSON from docs/project-templates/)
//
// 功能: 读取仓内 docs/project-templates/*.json，返回给前端「从模板建项目」按钮用。
// 关注点:
//   - 只读不写；模板由仓内 JSON 管理，不走 DB（避免 schema 改动）。
//   - 任何用户都能读，不需要鉴权（项目模板是公开出厂模板，非用户私有）。
//   - 解析失败不抛 500，降级返回空数组 + error 字段，前端能 graceful 退化。
//   - 模板 schema 校验宽松：id/name/category 必填，其余字段缺省不强求。
//   - 不缓存（开发期 JSON 频繁改；如需缓存放前端 SWR，源头不挡）。

import { NextRequest, NextResponse } from "next/server";
import { readFile, readdir } from "fs/promises";
import { join } from "path";

interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  category?: string;
  estimated_minutes?: number;
  icon?: string;
  recommended_skills?: string[];
  project?: {
    name?: string;
    description?: string;
    cwd?: string;
  };
  version?: {
    name?: string;
    feishu_url?: string;
    feishu_sheet?: string;
    [k: string]: unknown;
  };
  roles?: unknown[];
  tasks?: unknown[];
  notes?: string[];
  [k: string]: unknown;
}

const TEMPLATES_DIR = join(process.cwd(), "docs", "project-templates");

export async function GET(_request: NextRequest) {
  try {
    const files = await readdir(TEMPLATES_DIR);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    const templates: ProjectTemplate[] = [];
    const errors: Array<{ file: string; error: string }> = [];

    for (const file of jsonFiles) {
      try {
        const raw = await readFile(join(TEMPLATES_DIR, file), "utf-8");
        const parsed = JSON.parse(raw) as ProjectTemplate;
        if (!parsed.id || !parsed.name) {
          errors.push({ file, error: "missing id or name" });
          continue;
        }
        templates.push(parsed);
      } catch (e) {
        errors.push({
          file,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // 按 category + estimated_minutes 排序：starter → collaboration → advanced
    const categoryOrder: Record<string, number> = {
      starter: 0,
      collaboration: 1,
      advanced: 2,
    };
    templates.sort((a, b) => {
      const ca = categoryOrder[a.category ?? ""] ?? 99;
      const cb = categoryOrder[b.category ?? ""] ?? 99;
      if (ca !== cb) return ca - cb;
      return (a.estimated_minutes ?? 0) - (b.estimated_minutes ?? 0);
    });

    return NextResponse.json({ templates, errors });
  } catch (e) {
    return NextResponse.json(
      { templates: [], error: e instanceof Error ? e.message : String(e) },
      { status: 200 }, // 即使读不到也不 500，前端能 graceful 退化（按钮不显示）
    );
  }
}
