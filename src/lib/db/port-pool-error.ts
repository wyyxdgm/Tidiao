// 功能: 端口池冲突的结构化错误 (R18 P2). 给 createProject / updateProject 在
// 「候选端口不在池内」或「与其它项目撞」时抛出, 路由层 catch 后回 409 + JSON
// 明细, 前端能直接展示 (而不是只能渲染一段抛出的字符串).
//
// 关注点:
//  - 继承 Error 让 stack trace 还在; 但 code 字段稳定, 路由 catch 时用 code ===
  //   "PORT_POOL_CONFLICT" 判断 —— 避免用 message 子串匹配 (damo 0823 红线:
//   字符串判错不可靠, 改 message 等于静默放过).
//  - 携带 conflict 字段让前端免去二次解析. 字段命名贴近 projects.ts 的
//   PortConflict 类型 (outOfPool / conflicting).
export type PortConflict = {
  outOfPool: number[];
  conflicting: Array<{ port: number; owner_project_id: string }>;
};

export class PortPoolConflictError extends Error {
  readonly code = "PORT_POOL_CONFLICT";
  readonly status = 409;
  readonly conflict: PortConflict;

  constructor(conflict: PortConflict) {
    const parts: string[] = [];
    if (conflict.outOfPool.length > 0) {
      parts.push(`端口 ${conflict.outOfPool.join(", ")} 不在端口池内`);
    }
    if (conflict.conflicting.length > 0) {
      const list = conflict.conflicting
        .map((c) => `${c.port}(被项目 ${c.owner_project_id.slice(0, 8)} 占用)`)
        .join(", ");
      parts.push(`端口冲突: ${list}`);
    }
    super(parts.join("; ") || "端口池冲突");
    this.name = "PortPoolConflictError";
    this.conflict = conflict;
  }
}
