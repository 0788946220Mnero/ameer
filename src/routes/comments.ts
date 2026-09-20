/**
 * التعليقات والتقييمات.
 *
 * السلوك يختلف باختلاف نوع الإعلان، وهذا مقصود:
 *
 *   • المعروض — تقييم: نجمة من 1 إلى 5 مع نصّ، **واحد لكل مستخدم**.
 *     إعادة الإرسال تُعدّل التقييم السابق لا تضيف ثانيًا، وإلا استطاع
 *     مستخدم واحد رفع أو خفض تقييم متجر بعشرات التعليقات.
 *
 *   • المطلوب — تعليق: نصّ بلا نجوم، ومتعدّد. التعليق هنا عرض سعر أو سؤال،
 *     لا حكم على جودة، فالنجوم بلا معنى.
 */
import { Hono } from "hono";
import { z } from "zod";
import { Types } from "mongoose";
import { ApiError, fromMongo } from "../lib/errors.js";
import { serializeComment } from "../lib/serialize.js";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { sendPushToUser } from "../lib/push.js";
import { Comment, Listing, Notification, User } from "../models/index.js";

export const commentsRoute = new Hono();

const AUTHOR_FIELDS = "fullName accountType avatarUrl verification.status";

function objectId(raw: string | undefined): Types.ObjectId {
  if (!raw || !Types.ObjectId.isValid(raw)) throw ApiError.badRequest("معرّف غير صالح", "invalid_id");
  return new Types.ObjectId(raw);
}

const createSchema = z.object({
  body: z.string().trim().min(2, "التعليق قصير جدًا").max(1000, "التعليق طويل جدًا"),
  rating: z.number().int().min(1).max(5).nullable().optional(),
});

const replySchema = z.object({
  body: z.string().trim().min(1, "الردّ فارغ").max(1000),
});

/**
 * يعيد حساب ملخّص التقييم المحفوظ مع الإعلان.
 *
 * باستعلامين بسيطين لا بخطّ تجميع: المعاملات الشرطية ($cond و$ifNull) غير
 * مدعومة في كل الخوادم المتوافقة مع MongoDB، وفشلها كان يُسقط الطلب بعد
 * إنشاء التعليق بنجاح — أسوأ حالة: التعليق محفوظ والمستخدم يرى خطأ خادم.
 */
const RATING_SAMPLE_CAP = 2000;

async function refreshSummary(listingId: Types.ObjectId): Promise<void> {
  try {
    const [count, rated] = await Promise.all([
      Comment.countDocuments({ listingId, hidden: { $ne: true } }),
      Comment.find({ listingId, hidden: { $ne: true }, rating: { $ne: null } })
        .select("rating")
        .limit(RATING_SAMPLE_CAP)
        .lean(),
    ]);

    const ratings = rated.map((r) => r.rating as number).filter((r) => typeof r === "number");
    const avg =
      ratings.length > 0
        ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
        : 0;

    await Listing.updateOne(
      { _id: listingId },
      { $set: { commentCount: count, ratingCount: ratings.length, ratingAvg: avg } },
    );
  } catch (err) {
    // الملخّص رقم تجميلي: فشله يجب ألّا يُفشل تعليقًا حُفظ فعلًا.
    console.error("[comments] تعذّر تحديث ملخّص التقييم:", err);
  }
}

// ── قراءة التعليقات ────────────────────────────────────────
commentsRoute.get("/:id/comments", optionalAuth, async (c) => {
  const listingId = objectId(c.req.param("id"));
  const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 100);

  const rows = await Comment.find({ listingId, hidden: { $ne: true } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate({ path: "userId", select: AUTHOR_FIELDS })
    .lean();

  const viewer = c.get("maybeUser");
  const mine = viewer
    ? rows.find((r) => String((r.userId as { _id?: unknown })?._id ?? r.userId) === viewer.id)
    : null;

  return c.json({
    items: rows.map(serializeComment),
    /** تقييم المستخدم الحالي إن وُجد — الواجهة تعرضه للتعديل. */
    my_comment: mine ? serializeComment(mine) : null,
  });
});

// ── إضافة تعليق أو تقييم ───────────────────────────────────
commentsRoute.post(
  "/:id/comments",
  requireAuth,
  rateLimit({ name: "comment", limit: 20, windowMs: 60 * 60 * 1000, key: (c) => c.get("user").id }),
  async (c) => {
    const listingId = objectId(c.req.param("id"));
    const userId = c.get("user").id;

    const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "بيانات غير صالحة");
    }

    const listing = await Listing.findById(listingId).select("userId kind status title").lean();
    if (!listing || listing.status !== "active") throw ApiError.notFound("الإعلان غير متاح");

    const isOffer = listing.kind !== "wanted";
    const isOwner = String(listing.userId) === userId;

    // صاحب الإعلان لا يقيّم نفسه — أبسط طريق لتزوير التقييمات.
    if (isOffer && isOwner) {
      throw ApiError.forbidden("لا يمكنك تقييم إعلانك", "own_listing");
    }

    let rating: number | null = null;
    if (isOffer) {
      if (!parsed.data.rating) throw ApiError.badRequest("اختر تقييمًا من 1 إلى 5", "rating_required");
      rating = parsed.data.rating;
    }
    // على المطلوب نتجاهل أي تقييم يرسله العميل بدل رفض الطلب.

    try {
      let doc;
      if (isOffer) {
        // تقييم واحد لكل مستخدم: الإرسال الثاني تعديل لا إضافة.
        doc = await Comment.findOneAndUpdate(
          { listingId, userId },
          { $set: { body: parsed.data.body, rating, hidden: false } },
          { new: true, upsert: true },
        ).populate({ path: "userId", select: AUTHOR_FIELDS });
      } else {
        doc = await Comment.create({ listingId, userId, body: parsed.data.body, rating: null });
        await doc.populate({ path: "userId", select: AUTHOR_FIELDS });
      }

      await refreshSummary(listingId);

      // إشعار صاحب الإعلان — إلا إن كان هو المعلّق على طلبه.
      if (!isOwner) {
        const author = await User.findById(userId).select("fullName").lean();
        const title = isOffer ? "تقييم جديد على إعلانك" : "عرض جديد على طلبك";
        const body = `${author?.fullName ?? "مستخدم"}: ${parsed.data.body.slice(0, 100)}`;
        await Notification.create({
          userId: listing.userId,
          type: "comment",
          title,
          body,
          link: `/listing/${String(listingId)}`,
        }).catch(() => undefined);
        void sendPushToUser(String(listing.userId), {
          title,
          body,
          link: `/listing/${String(listingId)}`,
        });
      }

      return c.json(serializeComment(doc.toObject()), 201);
    } catch (err) {
      throw fromMongo(err);
    }
  },
);

// ── ردّ صاحب الإعلان ───────────────────────────────────────
commentsRoute.post("/:id/comments/:commentId/reply", requireAuth, async (c) => {
  const listingId = objectId(c.req.param("id"));
  const commentId = objectId(c.req.param("commentId"));

  const parsed = replySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "ردّ غير صالح");

  const listing = await Listing.findById(listingId).select("userId").lean();
  if (!listing) throw ApiError.notFound("الإعلان غير موجود");
  if (String(listing.userId) !== c.get("user").id) {
    throw ApiError.forbidden("الردّ متاح لصاحب الإعلان فقط");
  }

  const doc = await Comment.findOneAndUpdate(
    { _id: commentId, listingId },
    { $set: { replyBody: parsed.data.body, replyAt: new Date() } },
    { new: true },
  ).populate({ path: "userId", select: AUTHOR_FIELDS });

  if (!doc) throw ApiError.notFound("التعليق غير موجود");
  return c.json(serializeComment(doc.toObject()));
});

// ── حذف تعليق ──────────────────────────────────────────────
commentsRoute.delete("/:id/comments/:commentId", requireAuth, async (c) => {
  const listingId = objectId(c.req.param("id"));
  const commentId = objectId(c.req.param("commentId"));
  const user = c.get("user");

  const comment = await Comment.findOne({ _id: commentId, listingId }).lean();
  if (!comment) throw ApiError.notFound("التعليق غير موجود");

  // يحذفه كاتبه، أو صاحب الإعلان، أو المدير.
  const listing = await Listing.findById(listingId).select("userId").lean();
  const allowed =
    String(comment.userId) === user.id ||
    String(listing?.userId) === user.id ||
    user.isAdmin;
  if (!allowed) throw ApiError.forbidden("لا تملك صلاحية حذف هذا التعليق");

  await Comment.deleteOne({ _id: commentId });
  await refreshSummary(listingId);
  return c.json({ ok: true });
});
