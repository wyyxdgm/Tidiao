// 🆕 idea-canvas P1: 人工分拣列表 API 封装 — 与 master src/lib/db/pin-lists.ts 对齐.

import { get, post, patch, del, put } from './http';

export type PinRefType = 'task' | 'idea' | 'node';

export interface PinListItem {
  id: string;
  list_id: string;
  ref_type: PinRefType;
  ref_id: string;
  note: string | null;
  /** v524: 条目扩展数据 (JSON object 字符串, 按 list.data_schema 校验) */
  data: string | null;
  sort_key: number | null;
  added_by: string | null;
  created_at: string;
}

export interface PinListItemWithRef extends PinListItem {
  title: string;
  status: string | null;
  missing: boolean;
}

export interface PinList {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  /** v524: 挂哪个项目 (null = 全局列表) */
  project_id: string | null;
  /** v524: 条目扩展数据 schema (JSON 字符串: {properties, required}) */
  data_schema: string | null;
  sort_key: number | null;
  created_at: string;
  updated_at: string;
}

export interface PinListWithItems extends PinList {
  items: PinListItemWithRef[];
}

export async function listPinLists(): Promise<{ lists: PinListWithItems[] }> {
  return get('/api/pin-lists');
}

export async function createPinList(
  title: string,
  description?: string | null,
  extra?: { project_id?: string | null; data_schema?: string | null },
): Promise<PinListWithItems> {
  return post('/api/pin-lists', { title, description: description ?? null, ...(extra ?? {}) });
}

export async function updatePinList(id: string, body: Record<string, unknown>): Promise<PinList> {
  return patch(`/api/pin-lists/${id}`, body);
}

export async function deletePinList(id: string): Promise<void> {
  await del(`/api/pin-lists/${id}`);
}

export async function addPinListItem(
  listId: string,
  body: { ref_type: PinRefType; ref_id: string; note?: string | null; data?: string | null; added_by?: string },
): Promise<PinListItem> {
  return post(`/api/pin-lists/${listId}/items`, body);
}

export async function removePinListItem(itemId: string): Promise<void> {
  await del(`/api/pin-list-items/${itemId}`);
}

export async function reorderPinListItems(listId: string, itemIds: string[]): Promise<void> {
  await put(`/api/pin-lists/${listId}/items`, { item_ids: itemIds });
}

/** R245: 批量改列表顺序 (分类面板左右拖动持久化)。orders = 完整新顺序 [{id, sort_key}]。
 *  后端契约 (PUT /api/pin-lists): body 包 {orders} 一层。 */
export async function reorderPinLists(orders: Array<{ id: string; sort_key: number }>): Promise<void> {
  await put('/api/pin-lists', { orders });
}
