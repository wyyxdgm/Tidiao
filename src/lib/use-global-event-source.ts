"use client";

// 模块级单例: /api/events 的 EventSource + 引用计数 + 回调集合.
// 同一全局事件流被 NavigationTree / NavSidebar / global-board / chat-view(global)
// 共享一条长连接, 避免重复订阅占满浏览器 HTTP/1.1 同域并发名额 (每域 6 个).

import { useEffect, useRef } from "react";

type GlobalEvent = { type: string; [key: string]: unknown };

type Entry = {
  es: EventSource;
  count: number;
  listeners: Set<(e: GlobalEvent) => void>;
};

const GLOBAL_URL = "/api/events";
const streams = new Map<string, Entry>();

// 功能: 订阅全局 /api/events. 同一组件树多消费者共享一条 EventSource, 末个
//       消费者卸载才关闭连接. onEvent 收到每个解析后的事件.
// 关注点: onEvent 用 cbRef 保最新, 不进 effect 依赖, 避免每次渲染重订阅;
//         onerror 时探测 401 (session 过期), 主动关闭避免 EventSource 无限重连.
//         与 src/app/tasks/[id]/use-task-stream.ts 的 task-scoped 模式对称, 但
//         key 固定为 GLOBAL_URL (本进程只有一个全局流).
export function useGlobalEventSource(onEvent: (e: GlobalEvent) => void) {
  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;

  useEffect(() => {
    let entry = streams.get(GLOBAL_URL);
    if (!entry) {
      const es = new EventSource(GLOBAL_URL);
      const listeners = new Set<(e: GlobalEvent) => void>();
      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          listeners.forEach((cb) => cb(event));
        } catch {}
      };
      es.onerror = () => {
        // session 过期时服务端返 401, EventSource 默认无限重连.
        // 探测一次, 401 则关闭连接, 交由 AuthGuard 的 fetch patch 跳登录页.
        fetch("/api/user/me")
          .then((r) => {
            if (r.status === 401) {
              es.close();
              streams.delete(GLOBAL_URL);
            }
          })
          .catch(() => {});
      };
      entry = { es, count: 0, listeners };
      streams.set(GLOBAL_URL, entry);
    }

    const listener = (e: GlobalEvent) => cbRef.current(e);
    entry.listeners.add(listener);
    entry.count++;

    return () => {
      const ent = streams.get(GLOBAL_URL);
      if (!ent) return;
      ent.listeners.delete(listener);
      ent.count--;
      if (ent.count <= 0) {
        ent.es.close();
        streams.delete(GLOBAL_URL);
      }
    };
  }, []);
}
