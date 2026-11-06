/* 功能: 把 action.label (可能带前导图标/emoji, 如 '▶ 继续干') 转成 ConfirmDialog 的
   确认按钮文案 —— 去掉前导的非文字符号 + 空白, 保留中文 / 字母 / 数字.
   关注点: 🔴 不能用 /^[^\w]+/ —— JS 的 \w 只含 [A-Za-z0-9_], 中文属 \p{L} 不算 \w,
   于是纯中文 label ('删除' / '取消') 会被整串吃掉 → 确认按钮文案变空串
   (R213 线上 bug: 删除弹窗确认按钮只显示一半 / 空白).
   改用 Unicode 属性类 \p{L}\p{N} + u 标志: 只剥离前导符号 / emoji / 空白. */
export function confirmTextFromLabel(label: string): string {
  return label.replace(/^[^\p{L}\p{N}]+/u, '');
}
