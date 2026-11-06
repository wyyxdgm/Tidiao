// GET /api/tasks/[id]/timeline - Return status change events for a task
//
// Returns a chronologically ordered list of status transitions including
// the initial "pending" state (synthesized from the task's created_at)
// so the timeline always has a starting node, even for tasks that never
// moved off "pending".

import { NextRequest, NextResponse } from "next/server";
import { getEventsByTaskId } from "@/lib/db/events";
import { getTaskById } from "@/lib/db/tasks";

type TimelineEvent = {
  id: number | null;
  from: string | null;
  to: string;
  created_at: string;
  is_initial: boolean;
  duration_ms: number | null;
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = request.headers.get("x-user-id");
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const task = getTaskById(id, userId, { includeDeleted: true });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  // Fetch all status_change events for the task (ASC order)
  const events = getEventsByTaskId(id).filter((e) => e.type === "status_change");

  const items: TimelineEvent[] = [];

  // Synthesize the initial "pending" node from task.created_at so the
  // timeline always has a starting point. If the first real transition
  // is from some other state, we still want to show the initial state.
  const initialState: TimelineEvent = {
    id: null,
    from: null,
    to: task.status, // will be overwritten if the first event's `from` matches
    created_at: task.created_at,
    is_initial: true,
    duration_ms: null,
  };
  items.push(initialState);

  for (const ev of events) {
    let parsed: { from?: string; to?: string } = {};
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      continue;
    }
    if (!parsed.to) continue;
    items.push({
      id: ev.id ?? null,
      from: parsed.from ?? null,
      to: parsed.to,
      created_at: ev.created_at || task.created_at,
      is_initial: false,
      duration_ms: null,
    });
  }

  // Compute duration from the previous event for each node
  for (let i = 1; i < items.length; i++) {
    const prev = new Date(items[i - 1].created_at).getTime();
    const cur = new Date(items[i].created_at).getTime();
    if (!isNaN(prev) && !isNaN(cur) && cur >= prev) {
      items[i].duration_ms = cur - prev;
    }
  }

  // If the synthesized initial node's `to` doesn't match the first real
  // transition's `from`, override the initial node's `to` to reflect what
  // the task actually started as. (Usually "pending".)
  const firstReal = items.find((e) => !e.is_initial);
  if (firstReal && firstReal.from) {
    items[0].to = firstReal.from;
  }

  return NextResponse.json({ events: items });
}
