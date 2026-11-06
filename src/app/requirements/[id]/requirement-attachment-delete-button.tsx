"use client";

// 功能: 需求点详情页附件删除按钮 (R71).
// 关注点:
//   - 调 DELETE /api/attachments/[id] (通用端点, polymorphic — 不知道也不关心
//     是 task 还是 requirement attachment). 后端 owner 校验保证跨 owner 删不了.
//   - 删后 router.refresh() 拉最新列表 (server component, 必须 refresh 才能重渲染).
//   - R64 红线: 用 ConfirmDialog (danger variant) 二次确认 + useToastActions
//     提示结果, 不调原生 window.confirm/alert.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import ConfirmDialog from "@/components/ConfirmDialog";
import { useToastActions } from "@/components/Toast";

export default function RequirementAttachmentDeleteButton({
  attachmentId,
}: {
  attachmentId: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { error: toastError, success: toastSuccess } = useToastActions();

  const handleDelete = () => {
    setConfirmOpen(false);
    start(async () => {
      const res = await fetch(`/api/attachments/${attachmentId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toastError(`删除失败: ${data.error || res.status}`);
        return;
      }
      toastSuccess("附件已删除");
      router.refresh();
    });
  };

  return (
    <>
      <button
        type="button"
        disabled={pending}
        onClick={() => setConfirmOpen(true)}
        className="text-xs text-gray-400 hover:text-red-600 px-2 py-1 rounded disabled:opacity-50"
        title="删除附件"
      >
        {pending ? "删除中…" : "删除"}
      </button>
      <ConfirmDialog
        open={confirmOpen}
        title="删除附件"
        message="确认删除这个附件？文件本身也会一起删除。"
        confirmLabel="删除"
        cancelLabel="取消"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}