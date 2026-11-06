import { i18n } from '@/i18n';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { listProjects, listVersions, updateProject, type Project, type Version } from '@/api/projects';

export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<Project[]>([]);
  // v532: 归档项目列表 (侧栏「已归档」分组 / 项目列表归档区块数据源).
  // load() 不拉它 (多一次请求), 首次进侧栏按需 loadArchived().
  const archivedProjects = ref<Project[]>([]);
  const versionsByProject = ref<Record<string, Version[]>>({});
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load(
    force = false,
    sort: 'created_at' | 'recent_activity' | 'manual' = 'manual',
  ) {
    if (!force && projects.value.length) return;
    loading.value = true;
    error.value = null;
    try {
      const resp = await listProjects(sort);
      projects.value = resp.projects;
    } catch (e) {
      error.value = (e as { error?: string }).error || i18n.global.t('projects.errors.loadProjects');
    } finally {
      loading.value = false;
    }
  }

  /** v532: 拉归档项目列表. 失败静默 (归档分组是次要 UI, 不阻塞主列表). */
  async function loadArchived(force = false) {
    if (!force && archivedProjects.value.length) return;
    try {
      const resp = await listProjects('created_at', true);
      archivedProjects.value = resp.projects;
    } catch {
      // 静默: 归档分组显示为空, 不阻塞侧栏.
    }
  }

  async function loadVersions(projectId: string, force = false) {
    if (!force && versionsByProject.value[projectId]) return;
    try {
      const resp = await listVersions(projectId);
      versionsByProject.value = {
        ...versionsByProject.value,
        [projectId]: resp.versions,
      };
    } catch (e) {
      error.value = (e as { error?: string }).error || i18n.global.t('projects.errors.loadVersions');
    }
  }

  /** R49.11: 一次性加载所有版本 (不分项目). master projects-client.tsx:243-244
      refresh() 拉 /api/versions 一次后 filter(v.project_id === projectId).
      SPA 走无参 listVersions() 同口径, 用于项目卡片内联渲染版本列表. */
  async function loadAllVersions(force = false) {
    if (!force && Object.keys(versionsByProject.value).length > 0) return;
    try {
      const resp = await listVersions();
      const grouped: Record<string, Version[]> = {};
      for (const v of resp.versions) {
        const pid = v.project_id;
        if (!grouped[pid]) grouped[pid] = [];
        grouped[pid].push(v);
      }
      versionsByProject.value = grouped;
    } catch (e) {
      error.value = (e as { error?: string }).error || i18n.global.t('projects.errors.loadVersions');
    }
  }

  /** R56-B6: 拖拽重排 — mirror master NavigationTree.tsx:184-211 reorderProjects.
     本地立即用新顺序 (重赋 sort_order = i*1000), 并行 PATCH 受影响的行到后端.
     后端 master src/lib/db/projects.ts:602-615 已接受 sort_order, 失败不抛
     (catch → null), 下次 load() 由服务端覆盖纠偏. 步长 1000 留插入空间,
     同 master, 让后续拖拽不用重排太多行. */
  async function reorderProject(
    dragId: string,
    targetId: string,
    pos: 'before' | 'after',
  ): Promise<void> {
    if (dragId === targetId) return;
    const current = projects.value;
    const fromIdx = current.findIndex((p) => p.id === dragId);
    const toIdxRaw = current.findIndex((p) => p.id === targetId);
    if (fromIdx < 0 || toIdxRaw < 0) return;
    const without = current.filter((p) => p.id !== dragId);
    const insertAt = pos === 'before' ? toIdxRaw : toIdxRaw + 1;
    const reordered = [
      ...without.slice(0, insertAt),
      current[fromIdx],
      ...without.slice(insertAt),
    ];
    const patched = reordered.map((p, i) => ({ ...p, sort_order: i * 1000 }));
    projects.value = patched;
    const prevById = new Map(current.map((p) => [p.id, p.sort_order ?? null]));
    await Promise.all(
      patched
        .filter((p) => (prevById.get(p.id) ?? null) !== p.sort_order)
        .map((p) =>
          updateProject(p.id, { sort_order: p.sort_order }).catch(() => null),
        ),
    );
  }

  /** R56-B16: 项目置顶 toggle (镜像 master projects-client.tsx:456 togglePin).
     乐观更新 pinned 0/1, 并行 PATCH 到后端; 失败回滚. 后端 listProjects 排序
     始终 pinned DESC 在前 (src/lib/db/projects.ts:467/473), 所以本地更新
     projects 数组就够 — 后端下次 listProjects 自然重排.

     v532: 置顶附带收藏 (不变量 pin ⇒ star) — pin=1 时同时传 starred:1;
     取消置顶不动收藏状态 (用户可能只是不想置顶但仍想收藏). */
  async function togglePin(id: string, currentPinned: number): Promise<void> {
    const next = currentPinned ? 0 : 1;
    const prev = projects.value;
    projects.value = prev.map((p) =>
      p.id === id
        ? { ...p, pinned: next, starred: next === 1 ? 1 : (p.starred ?? 0) }
        : p,
    );
    try {
      await updateProject(id, next === 1 ? { pinned: 1, starred: 1 } : { pinned: 0 });
    } catch {
      // rollback to server state on failure
      projects.value = prev;
    }
  }

  /** v532: 收藏 toggle. 乐观更新 + PATCH, 失败回滚 (同 togglePin 口径).
     不变量 pin ⇒ star: 取消收藏时若项目还置顶着, 联动取消置顶 —
     否则会出现「置顶段里有个未收藏项目」, 语义矛盾. */
  async function toggleStar(id: string, currentStarred: number): Promise<void> {
    const next = currentStarred ? 0 : 1;
    const prev = projects.value;
    const target = prev.find((p) => p.id === id);
    if (!target) return;
    // 取消收藏联动取消置顶; 收藏不动置顶.
    const dropPin = next === 0 && !!target.pinned;
    projects.value = prev.map((p) =>
      p.id === id
        ? { ...p, starred: next, pinned: dropPin ? 0 : (p.pinned ?? 0) }
        : p,
    );
    try {
      await updateProject(
        id,
        dropPin ? { starred: 0, pinned: 0 } : { starred: next },
      );
    } catch {
      projects.value = prev;
    }
  }

  /** v532: 重命名 (侧栏右键菜单). 成功返回 true, 失败 (409 撞名等) 返回 false
     并抛给调用方展示 message — 侧栏行内编辑需要区分「静默失败」和「提示用户」.
     乐观更新先行, 失败回滚旧名. */
  async function renameProject(id: string, name: string): Promise<boolean> {
    const trimmed = name.trim();
    if (!trimmed) return false;
    const prev = projects.value;
    const target = prev.find((p) => p.id === id);
    if (!target || target.name === trimmed) return true;
    projects.value = prev.map((p) => (p.id === id ? { ...p, name: trimmed } : p));
    try {
      await updateProject(id, { name: trimmed });
      return true;
    } catch (e) {
      projects.value = prev;
      throw new Error(
        (e as { error?: string }).error || i18n.global.t('projects.errors.renameFailed'),
      );
    }
  }

  /** v532: 归档 — 从活跃列表移入归档列表 (本地先行, PATCH 失败回滚).
     归档 ≠ 删除: 数据不动, 归档分组可见, 可恢复, URL 仍可访问. */
  async function archiveProject(id: string): Promise<void> {
    const prev = projects.value;
    const target = prev.find((p) => p.id === id);
    if (!target) return;
    projects.value = prev.filter((p) => p.id !== id);
    archivedProjects.value = [{ ...target, archived: 1 }, ...archivedProjects.value];
    try {
      await updateProject(id, { archived: 1 });
    } catch {
      projects.value = prev;
      archivedProjects.value = archivedProjects.value.filter((p) => p.id !== id);
    }
  }

  /** v532: 恢复归档项目 — 从归档列表移回活跃列表. */
  async function unarchiveProject(id: string): Promise<void> {
    const prevArchived = archivedProjects.value;
    const target = prevArchived.find((p) => p.id === id);
    if (!target) return;
    archivedProjects.value = prevArchived.filter((p) => p.id !== id);
    projects.value = [...projects.value, { ...target, archived: 0 }];
    try {
      await updateProject(id, { archived: 0 });
    } catch {
      archivedProjects.value = prevArchived;
      projects.value = projects.value.filter((p) => p.id !== id);
    }
  }

  /** v532: 删除 (级联软删) 后本地移除 — 活跃 + 归档两个列表都清.
     真正的 DELETE API 调用由调用方做 (需 ConfirmDialog 二次确认), 这里只管
     确认成功后的本地状态收敛. */
  function removeProjectLocally(id: string): void {
    projects.value = projects.value.filter((p) => p.id !== id);
    archivedProjects.value = archivedProjects.value.filter((p) => p.id !== id);
  }

  return { projects, archivedProjects, versionsByProject, loading, error, load, loadArchived, loadVersions, loadAllVersions, reorderProject, togglePin, toggleStar, renameProject, archiveProject, unarchiveProject, removeProjectLocally };
});