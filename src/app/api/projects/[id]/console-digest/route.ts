// GET /api/projects/[id]/console-digest - 总控制台「AI 全局归纳」(R195)
//
// AI 结合项目业务文档 (CLAUDE.md 等 agent 环境加载的文档) + 任务清单, 归纳出
// headline + 每任务分类/建议 (fix/design/delivery/iterate/decision/other),
// damo 据此快速拍板 (一键同意与否). 缓存进 app_settings (键 console_digest:<id>),
// 带 fingerprint (任务集 id/status/updated_at) — 没变直接吃缓存, 变了才重算
// (单次 LLM ≈ $0.01). ?refresh=true 强制重算.
// LLM 失败但存在旧缓存 → 回退 stale (总比空白好); 无缓存 → source:failed.

import { NextRequest, NextResponse } from "next/server";
import { getProjectById } from "@/lib/db/projects";
import { listTasks } from "@/lib/db/tasks";
import { getSetting, setSetting } from "@/lib/db/settings";
import {
  DIGEST_CACHE_PREFIX,
  collectProjectContext,
  digestFingerprint,
  generateConsoleDigest,
  type ConsoleDigest,
} from "@/lib/runtime/console-digest";

interface CachedDigest {
  fingerprint: string;
  digest: ConsoleDigest;
  at: string;
  model: string;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  // admin 只读放行 (同 GET /api/projects/[id] 口径; 无写路径)
  const role = request.headers.get("x-user-role");
  const isOwner = role !== "admin";
  const project = getProjectById(id, isOwner ? userId : undefined);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const tasks = listTasks({
    project_id: id,
    ownerId: isOwner ? userId : undefined,
    limit: 400,
  });
  const fingerprint = digestFingerprint(tasks);
  const cacheKey = `${DIGEST_CACHE_PREFIX}${id}`;

  const { searchParams } = new URL(request.url);
  const refresh = searchParams.get("refresh") === "true";

  let cached: CachedDigest | null = null;
  try {
    const raw = getSetting(cacheKey);
    if (raw) cached = JSON.parse(raw) as CachedDigest;
  } catch {
    cached = null; // 脏 JSON 当没缓存
  }

  if (!refresh && cached && cached.fingerprint === fingerprint && cached.digest) {
    return NextResponse.json({ ...cached, source: "cache" });
  }

  if (!tasks.length) {
    const empty: CachedDigest = {
      fingerprint,
      digest: { headline: "暂无任务，项目安静中", items: [] },
      at: new Date().toISOString(),
      model: "",
    };
    writeCache(cacheKey, empty);
    return NextResponse.json({ ...empty, source: "empty" });
  }

  const context = collectProjectContext(project.cwd);
  const { digest, model } = await generateConsoleDigest({
    project: { id: project.id, name: project.name, owner_id: project.owner_id },
    tasks,
    context,
  });

  if (!digest) {
    // LLM 失败: 有旧缓存回 stale (页面仍有归纳可看), 没有才报 failed.
    if (cached?.digest) {
      return NextResponse.json({ ...cached, source: "stale" });
    }
    return NextResponse.json({ source: "failed", digest: null });
  }

  const payload: CachedDigest = {
    fingerprint,
    digest,
    at: new Date().toISOString(),
    model,
  };
  writeCache(cacheKey, payload);
  return NextResponse.json({ ...payload, source: "llm" });
}

// 功能: 缓存写失败不阻断 (下次多花一次 LLM, 可接受).
function writeCache(key: string, payload: CachedDigest): void {
  try {
    setSetting(key, JSON.stringify(payload));
  } catch (err) {
    console.warn(`[console-digest] cache write failed for ${key}:`, err);
  }
}
