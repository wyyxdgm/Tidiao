// Board 模块导出 (R61).

export { parseBoardFile, parseIntervalSeconds, type BoardConfig, type Source, type ApiSource, type SqlSource, type ParsedBoardFile } from "./frontmatter";
export { executeBoardSql, closeBoardSqlDb, type SqlExecOptions, type SqlExecResult } from "./sql-executor";
export { resolveBoardFile, resolvePlatformBoard, platformBoardRoot, type ResolvedBoard } from "./resolve";
export { applyApiSourceCtx, appendQueryString, type BoardSourceCtx, type ApiSourceForCtx } from "./ctx";
