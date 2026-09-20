import { Hono } from "hono";
import { z } from "zod";
import { Types } from "mongoose";
import { ApiError, fromMongo } from "../../lib/errors.js";
import { serializeListing } from "../../lib/serialize.js";
import { logAdminAction } from "../../lib/audit.js";
import { destroyImages } from "../../lib/cloudinary.js";
import { sendPushToUser } from "../../lib/push.js";
import { Listing, Conversation, Message, Favorite, RecentView, Notification } from "../../models/index.js";

export const adminListingsRoute = new Hono();

const POPULATE = [
  { path: "categoryId" },
  { path: "cityId" },
  { path: "sellerId", populate: { path: "cityId" } },
] as const;

const STATUSES = ["active", "pending", "rejected", "paused"] as const;

const patchSchema = z
  .object({
    status: z.enum(STATUSES).optional(),
    is_featured: z.boolean().optional(),
  })
  .refine((v) => v.status !== undefined || v.is_featured !== undefined, {
    message: "لا يوجد شيء لتحديثه",
  });

adminListingsRoute.get("/", async (c) => {
  const q = c.req.query();
  const limit = Math.min(Number(q["limit"] ?? 200) || 200, 500);

  const filter: Record<string, unknown> = {};
  if (q["status"] && q["status"] !== "all") {
    if (!(STATUSES as readonly string[]).includes(q["status"])) throw ApiError.badRequest("حالة غير معروفة");
    filter["status"] = q["status"];
  }
  if (q["kind"] === "offer" || q["kind"] === "wanted") filter["kind"] = q["kind"];
  if (q["category"] && q["category"] !== "all" && Types.ObjectId.isValid(q["category"])) {
    filter["categoryId"] = q["category"];
  }
  if (q["city"] && q["city"] !== "all" && Types.ObjectId.isValid(q["city"])) filter["cityId"] = q["city"];
  if (q["q"]?.trim()) {
    const safe = q["q"].trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter["title"] = { $regex: safe, $options: "i" };
  }

  const rows = await Listing.find(filter).sort({ createdAt: -1 }).limit(limit).populate(POPULATE as never).lean();
  return c.json(rows.map((r) => serializeListing(r, { includeContact: true })));
});

adminListingsRoute.patch("/:id", async (c) => {
  const id = c.req.param("id");
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest("معرّف غير صالح", "invalid_id");

  const parsed = patchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "طلب غير صالح");
  const patch = parsed.data;
  const admin = c.get("user");

  const update: Record<string, unknown> = {};
  if (patch.status !== undefined) update["status"] = patch.status;
  if (patch.is_featured !== undefined) update["isFeatured"] = patch.is_featured;

  let doc;
  try {
    doc = await Listing.findByIdAndUpdate(id, { $set: update }, { new: true }).lean();
  } catch (err) {
    throw fromMongo(err);
  }
  if (!doc) throw ApiError.notFound("الإعلان غير موجود");

  if (patch.status) {
    const action =
      patch.status === "active" ? "approve_listing"
      : patch.status === "rejected" ? "reject_listing"
      : `set_status_${patch.status}`;
    await logAdminAction(admin.id, action, "listing", id, doc.title);

    // إشعار صاحب الإعلان بقرار الإدارة — كان مشغّلًا في PostgreSQL.
    if (patch.status === "active" || patch.status === "rejected") {
      const title = patch.status === "active" ? "تم اعتماد إعلانك" : "تم رفض إعلانك";
      await Notification.create({
        userId: doc.userId,
        type: "listing_status",
        title,
        body: doc.title,
        link: `/listing/${id}`,
      }).catch(() => undefined);

      void sendPushToUser(String(doc.userId), {
        title,
        body: doc.title,
        link: `/listing/${id}`,
      });
    }
  }
  if (patch.is_featured !== undefined) {
    await logAdminAction(
      admin.id,
      patch.is_featured ? "feature_listing" : "unfeature_listing",
      "listing", id, doc.title,
    );
  }

  return c.json({ id, status: doc.status, is_featured: doc.isFeatured, title: doc.title });
});

adminListingsRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest("معرّف غير صالح", "invalid_id");

  const listing = await Listing.findById(id).lean();
  if (!listing) throw ApiError.notFound("الإعلان غير موجود");

  await Listing.deleteOne({ _id: id });

  const convs = await Conversation.find({ listingId: id }).select("_id").lean();
  await Promise.all([
    Favorite.deleteMany({ listingId: id }),
    RecentView.deleteMany({ listingId: id }),
    Message.deleteMany({ conversationId: { $in: convs.map((x) => x._id) } }),
    Conversation.deleteMany({ listingId: id }),
    destroyImages((listing.images ?? []).map((i) => i.publicId)),
  ]);

  await logAdminAction(c.get("user").id, "delete_listing", "listing", id, listing.title);
  return c.json({ ok: true });
});
