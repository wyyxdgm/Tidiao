// Thin fetch wrapper with 401 auto-refresh + in-flight de-duplication.
// - All requests go through same-origin /api (vite proxy → :13000)
// - Cookies are same-origin, automatic on fetch with credentials:'include'
// - On 401: call POST /api/auth/refresh once (in-flight shared), then retry
//   the original request. Refresh failure → throw HttpError(status:401) so
//   the router guard (sessionState === 'no' branch) can redirect to /login.
// - Returns parsed JSON or throws HttpError.
// i18n (W4.5b): 前端自有兜底文案 (超时 message) 走 locale (非 setup 环境用
//   i18n.global); 后端返回的 error 字段原样透传不翻.

// 关注点: 当前 Next.js 后端（master 分支）未提供 /api/auth/refresh —— 此刻
// 命中会 404, 401 仍按设计抛给上层。架构就位, 等后端补 endpoint 后无需改本文件。
import { i18n } from '@/i18n';
const REFRESH_PATH = '/api/auth/refresh';

// 关注点: 模块级单例 —— 并发 401 共享同一个 refresh Promise, 避免雪崩。
// 完成后 (成功或失败) 立刻清空, 后续 401 可重新触发 refresh。
let refreshInflight: Promise<void> | null = null;

// 无自定义 signal 的请求统一挂 30s 超时. 背景: HTTP/1.1 直连 (内网 IP:13000)
// 场景下浏览器每域只有 6 个并发连接, 被 SSE 占满后 fetch 会无限 pending,
// 页面所有接口永远转圈 (2026-10-09 实证). 30s 对常规读写足够宽裕; 需要更长
// 时间或自定义中断的调用方自己传 signal, 透传不覆盖.
const DEFAULT_TIMEOUT_MS = 30_000;

// 服务端错误响应体里目前包含 `error` (string) 字段; 部分 endpoint (如带
// Zod 校验) 可能额外返回 `code` + `fieldErrors` (字段→错误信息)。HttpError
// 统一承载这些字段; 后端尚未返回的字段保持 undefined。
export interface ErrorBody {
  error?: string;
  code?: string;
  fieldErrors?: Record<string, string>;
}

const STATUS_CODE_MAP: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_ERROR',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
};

function defaultCodeForStatus(status: number): string {
  return STATUS_CODE_MAP[status] ?? `HTTP_${status}`;
}

// 关注点: HttpError 是真正的 Error 子类 —— `instanceof HttpError` 在所有路径
// 都成立 (跨 module 边界不会因 vitest mock 失效, 见 §catch 用 `code`/`name`
// 字符串判的根因)。`retryAfter` 仅 429 携带, 其余 undefined。
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors?: Record<string, string>;
  readonly retryAfter?: number;

  constructor(args: {
    status: number;
    code?: string;
    message: string;
    fieldErrors?: Record<string, string>;
    retryAfter?: number;
  }) {
    super(args.message);
    this.name = 'HttpError';
    this.status = args.status;
    this.code = args.code ?? defaultCodeForStatus(args.status);
    if (args.fieldErrors) this.fieldErrors = args.fieldErrors;
    if (args.retryAfter !== undefined) this.retryAfter = args.retryAfter;
  }

  // 表单错误的快速判定 —— 返回类型守卫, 调用方拿到的是 HttpError (非 unknown)。
  // 用法: `if (HttpError.isFormError(e)) { Object.entries(e.fieldErrors!) ... }`
  static isFormError(err: unknown): err is HttpError {
    return (
      err instanceof HttpError &&
      !!err.fieldErrors &&
      Object.keys(err.fieldErrors).length > 0
    );
  }
}

// 关注点: 顶层导出 `isHttpError` 便于 catch 后用 `if (isHttpError(e))` 缩窄类型;
// HttpError.isFormError 本身也是类型守卫, 但 catch 块通常先缩到 HttpError 再
// 判定是否表单错 (避免重复 instanceof)。
export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError;
}

// 从错误 (任意类型) 提取某字段的字段错误信息; 不是 HttpError / 没有
// fieldErrors → 返回 undefined. 表单页可直接 `getFieldError(e, 'email')`。
export function getFieldError(err: unknown, field: string): string | undefined {
  if (err instanceof HttpError && err.fieldErrors) {
    return err.fieldErrors[field];
  }
  return undefined;
}

async function doRefresh(): Promise<void> {
  const res = await fetch(REFRESH_PATH, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) {
    throw new HttpError({
      status: res.status,
      message: `refresh failed: HTTP ${res.status}`,
    });
  }
}

function ensureFresh(): Promise<void> {
  if (!refreshInflight) {
    refreshInflight = doRefresh().finally(() => {
      refreshInflight = null;
    });
  }
  return refreshInflight;
}

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildHttpError(status: number, body: unknown, retryAfterHeader: string | null): HttpError {
  const errBody = (body && typeof body === 'object' ? body : {}) as ErrorBody;
  let retryAfter: number | undefined;
  if (retryAfterHeader) {
    const n = Number(retryAfterHeader);
    if (!Number.isNaN(n)) retryAfter = n;
  }
  return new HttpError({
    status,
    code: errBody.code,
    message: errBody.error || `HTTP ${status}`,
    fieldErrors: errBody.fieldErrors,
    retryAfter,
  });
}

// Internal flag passed on the recursive retry call so we never trigger
// refresh+retry twice for the same request (would loop on permanent 401).
type ApiOptions = RequestInit & { _isRetry?: boolean };

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const { _isRetry, headers, ...rest } = options;

  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(headers || {}),
      },
      ...rest,
      // 放在 spread 之后: 调用方传了 signal 用调用方的, 没传统一挂超时.
      signal: rest.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    // 超时从 fetch reject 出来是 DOMException(TimeoutError), 转成 HttpError
    // 让上层 catch (e instanceof HttpError) 的 toast 路径正常显示.
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new HttpError({
        status: 0,
        message: i18n.global.t('common.errTimeout30s'),
      });
    }
    throw err;
  }

  // 401 + first attempt → try refresh + retry once.
  // 关注点: refresh 失败不重试递归 (catch 吞掉, 落到下面 throw) ——
  // 任何 refresh 错误都意味着"会话死了", 立刻抛给上层。
  if (res.status === 401 && !_isRetry) {
    try {
      await ensureFresh();
    } catch {
      // fall through — let the original 401 be reported below
    }
    return api<T>(path, { ...options, _isRetry: true });
  }

  if (res.status === 204) return undefined as T;

  const body = await parseBody(res);

  if (!res.ok) {
    throw buildHttpError(res.status, body, res.headers.get('Retry-After'));
  }

  return body as T;
}

// 可选 options (RequestInit) 透传 — R190: ensureResultLayers 用 signal 挂超时.
export const get = <T = unknown>(path: string, options?: RequestInit) =>
  api<T>(path, { method: 'GET', ...options });
export const post = <T = unknown>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
export const patch = <T = unknown>(path: string, body?: unknown) =>
  api<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined });
export const put = <T = unknown>(path: string, body?: unknown) =>
  api<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined });
export const del = <T = unknown>(path: string) =>
  api<T>(path, { method: 'DELETE' });

/** 条件 GET (R165): 带 `If-None-Match` 请求, 服务端指纹没变回 304 空 body.
 *  返回 changed=false 时 data 为 null, 调用方沿用上一次的内存数据 —— 这就是
 *  「后台定期探一次, 没变就不拉全量」的落点.
 *
 *  关注点:
 *   - 304 不是错误, 不能走 api() 的 `!res.ok → throw` 分支, 所以这里自带
 *     fetch 而不复用 api(); 但 401 → refresh → 重试的语义必须一致 (否则
 *     会话过期时会话页拿到一个看不懂的 304/401 组合).
 *   - etag 为 null 时退化成普通 GET (首次加载没有可比对的指纹).
 *   - 服务端换了 ETag 算法 (指纹格式变了) 时旧值只是不匹配 → 200 全量, 安全. */
export async function getIfChanged<T>(
  path: string,
  etag: string | null,
): Promise<{ changed: boolean; etag: string | null; data: T | null }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (etag) headers['If-None-Match'] = etag;

  let res = await fetch(path, { credentials: 'include', headers, method: 'GET' });

  if (res.status === 401) {
    // 会话可能过期, 与 api() 同款: 刷一次再试. 刷不动就照常把 401 抛上去.
    try {
      await ensureFresh();
      res = await fetch(path, { credentials: 'include', headers, method: 'GET' });
    } catch {
      /* fallthrough — 下面按原响应抛 */
    }
  }

  const nextEtag = res.headers.get('ETag');

  if (res.status === 304) {
    return { changed: false, etag: nextEtag ?? etag, data: null };
  }

  if (!res.ok) {
    const body = await parseBody(res);
    throw buildHttpError(res.status, body, res.headers.get('Retry-After'));
  }

  return { changed: true, etag: nextEtag, data: (await parseBody(res)) as T };
}

/** multipart/form-data POST — 仅 fork 等需要同时上传文件的端点用.
    meta: JSON 字符串 (后端 formData.get('meta') 解析); files: 文件列表 (字段名统一 'file').
    Content-Type 不手动设 — 由浏览器 multipart boundary 自动填, 我们给个空值避免被 http.ts 默认 application/json 覆盖. */
export const postMultipart = <T = unknown>(
  path: string,
  meta: unknown,
  files: File[],
): Promise<T> =>
  api<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': '' },
    body: (() => {
      const fd = new FormData();
      fd.append('meta', JSON.stringify(meta));
      for (const f of files) fd.append('file', f);
      return fd;
    })(),
  });