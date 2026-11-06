"use client";

import { useEffect, useRef } from "react";

type TaskEvent = { type: string; [key: string]: unknown };

// 模块级单例: taskId -> { EventSource, 引用计数, 回调集合 }
// 同一 task 的多个组件(如 TaskHeader + TaskDetailClient)共享一个 EventSource,
// 避免重复长连接占满浏览器 HTTP/1.1 并发名额(每域 6 个).
type Entry = {
  es: EventSource;
  count: number;
  listeners: Set<(e: TaskEvent) => void>;
};
const streams = new Map<string, Entry>();

// 功能: 订阅某 task 的 SSE 事件流. 同一 taskId 多组件共享一个 EventSource,
//       末个组件卸载才关闭连接. onEvent 收到每个解析后的事件.
// 关注点: onEvent 用 cbRef 保最新, 不进 effect 依赖, 避免每次渲染重订阅;
//         onerror 时探测 401(session 过期), 主动关闭避免 EventSource 无限重连.
export function useTaskStream(taskId: string, onEvent: (e: TaskEvent) => void) {
  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;

  useEffect(() => {
    let entry = streams.get(taskId);
    if (!entry) {
      const es = new EventSource(`/api/tasks/${taskId}/stream`);
      const listeners = new Set<(e: TaskEvent) => void>();
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
              streams.delete(taskId);
            }
          })
          .catch(() => {});
      };
      entry = { es, count: 0, listeners };
      streams.set(taskId, entry);
    }

    const listener = (e: TaskEvent) => cbRef.current(e);
    entry.listeners.add(listener);
    entry.count++;

    return () => {
      const ent = streams.get(taskId);
      if (!ent) return;
      ent.listeners.delete(listener);
      ent.count--;
      if (ent.count <= 0) {
        ent.es.close();
        streams.delete(taskId);
      }
    };
  }, [taskId]);
}
