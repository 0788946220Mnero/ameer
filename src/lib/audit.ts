import { AdminAction } from "../models/index.js";

/**
 * يسجّل كل إجراء إداري.
 * الفشل هنا لا يُسقط الطلب — الإجراء أهمّ من سجلّه — لكنه يُطبع للمراقبة.
 */
export async function logAdminAction(
  adminId: string,
  action: string,
  targetType: string,
  targetId: string | null,
  notes?: string | null,
): Promise<void> {
  try {
    await AdminAction.create({ adminId, action, targetType, targetId, notes: notes ?? null });
  } catch (err) {
    console.error("[audit] تعذّر تسجيل الإجراء", action, err);
  }
}
