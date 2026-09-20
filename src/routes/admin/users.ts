import { Hono } from "hono";
import { z } from "zod";
import { Types } from "mongoose";
import { ApiError, fromMongo } from "../../lib/errors.js";
import { serializeUser, serializeVerificationRequest } from "../../lib/serialize.js";
import { logAdminAction } from "../../lib/audit.js";
import { revokeAllForUser } from "../../lib/tokens.js";
import { User, Listing, Seller, Notification } from "../../models/index.js";
import { sendPushToUser } from "../../lib/push.js";

export const adminUsersRoute = new Hono();

const userPatch = z
  .object({
    is_banned: z.boolean().optional(),
    is_admin: z.boolean().optional(),
  })
  .refine((v) => v.is_banned !== undefined || v.is_admin !== undefined, {
    message: "لا يوجد شيء لتحديثه",
  });

adminUsersRoute.get("/", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 300) || 300, 1000);
  const users = await User.find().sort({ createdAt: -1 }).limit(limit).lean();

  // عدد إعلانات كل مستخدم في تجميعة واحدة بدل جلب كل الإعلانات وعدّها محليًا.
  const counts = await Listing.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $group: { _id: "$userId", count: { $sum: 1 } } },
  ]);
  const map = new Map(counts.map((x) => [String(x._id), x.count]));

  return c.json(
    users.map((u) => ({ ...serializeUser(u), listings_count: map.get(String(u._id)) ?? 0 })),
  );
});

adminUsersRoute.patch("/:id", async (c) => {
  const id = c.req.param("id");
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest("معرّف غير صالح", "invalid_id");

  const parsed = userPatch.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "طلب غير صالح");
  const patch = parsed.data;
  const admin = c.get("user");

  const target = await User.findById(id);
  if (!target) throw ApiError.notFound("المستخدم غير موجود");

  // حماية من قفل النظام على النفس.
  if (id === admin.id && patch.is_banned === true) throw ApiError.forbidden("لا يمكنك حظر حسابك");
  if (id === admin.id && patch.is_admin === false) {
    throw ApiError.forbidden("لا يمكنك إزالة صلاحية المدير من حسابك");
  }

  try {
    if (patch.is_banned !== undefined) {
      target.isBanned = patch.is_banned;
      await target.save();
      // الحظر يُنهي جلسات المستخدم فورًا بدل انتظار انتهاء توكنه.
      if (patch.is_banned) await revokeAllForUser(id);
      await logAdminAction(
        admin.id, patch.is_banned ? "ban_user" : "unban_user", "user", id, target.fullName,
      );
    }

    if (patch.is_admin !== undefined) {
      const roles = new Set(target.roles ?? ["user"]);
      if (patch.is_admin) {
        roles.add("admin");
      } else {
        const adminCount = await User.countDocuments({ roles: "admin" });
        if (adminCount <= 1) throw ApiError.forbidden("لا يمكن إزالة آخر مدير في النظام");
        roles.delete("admin");
      }
      target.roles = [...roles];
      await target.save();
      // تغيير الصلاحية يجب أن يظهر في التوكن التالي، لا بعد 15 دقيقة.
      await revokeAllForUser(id);
      await logAdminAction(
        admin.id, patch.is_admin ? "grant_admin" : "revoke_admin", "user", id, target.fullName,
      );
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw fromMongo(err);
  }

  return c.json({ ok: true });
});

// ── طلبات التوثيق ──────────────────────────────────────────

const reviewSchema = z.object({
  approve: z.boolean(),
  note: z.string().trim().max(500).nullable().optional(),
});

/** الطلبات المعلّقة أولًا، ثم البقيّة — هذا ما يحتاجه المدير يوميًا. */
adminUsersRoute.get("/verifications", async (c) => {
  const status = c.req.query("status") ?? "pending";
  const filter =
    status === "all" ? { "verification.status": { $ne: "none" } } : { "verification.status": status };

  const rows = await User.find(filter)
    .sort({ "verification.submittedAt": -1 })
    .limit(200)
    .lean();
  return c.json(rows.map(serializeVerificationRequest));
});

adminUsersRoute.post("/:id/verification", async (c) => {
  const id = c.req.param("id");
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest("معرّف غير صالح", "invalid_id");

  const parsed = reviewSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest("قرار غير صالح");

  const admin = c.get("user");
  const user = await User.findById(id);
  if (!user) throw ApiError.notFound("المستخدم غير موجود");

  const approved = parsed.data.approve;
  user.verification = {
    ...(user.verification ?? {}),
    status: approved ? "approved" : "rejected",
    reviewNote: parsed.data.note ?? null,
    reviewedAt: new Date(),
    reviewedBy: admin.id as never,
  };
  await user.save();

  // شارة المتجر تتبع توثيق صاحبه، فلا يظهر متجر موثّق لصاحب غير موثّق.
  await Seller.updateOne({ userId: id }, { $set: { isVerified: approved } });

  const title = approved ? "تم توثيق حسابك" : "لم يُقبل طلب التوثيق";
  const body = approved
    ? "صارت شارة التوثيق تظهر على حسابك وإعلاناتك"
    : (parsed.data.note ?? "راجع بياناتك وأعد الإرسال");
  await Notification.create({ userId: id, type: "verification", title, body, link: "/account" }).catch(
    () => undefined,
  );
  void sendPushToUser(id, { title, body, link: "/account" });

  await logAdminAction(
    admin.id,
    approved ? "approve_verification" : "reject_verification",
    "user",
    id,
    user.fullName,
  );

  return c.json({ ok: true, status: user.verification.status });
});
