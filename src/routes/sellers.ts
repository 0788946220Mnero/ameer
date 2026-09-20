/** المتاجر — صفحة البائع العامة، وإدارة المستخدم لمتجره. */
import { Hono } from "hono";
import { z } from "zod";
import { Types } from "mongoose";
import { ApiError, fromMongo } from "../lib/errors.js";
import { serializeSeller, serializeListing } from "../lib/serialize.js";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { Seller, Listing, User } from "../models/index.js";
import { isValidCoords } from "../lib/geo.js";

export const sellersRoute = new Hono();

function slugify(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return `${base || "store"}-${Math.random().toString(36).slice(2, 7)}`;
}

const sellerSchema = z.object({
  name: z.string().trim().min(2, "اسم المتجر قصير جدًا").max(120),
  activity_type: z.string().trim().max(80).nullable().optional(),
  city_id: z.string().nullable().optional(),
  bio: z.string().trim().max(2000).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  whatsapp: z.string().trim().max(40).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
});

/** متجري — يُنشأ عند أول حفظ. */
sellersRoute.get("/mine", requireAuth, async (c) => {
  const seller = await Seller.findOne({ userId: c.get("user").id }).populate("cityId").lean();
  if (!seller) return c.json(null);
  return c.json(serializeSeller(seller, { includeContact: true }));
});

sellersRoute.put("/mine", requireAuth, async (c) => {
  const parsed = sellerSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "بيانات غير صالحة");
  const b = parsed.data;
  const userId = c.get("user").id;

  // إحداثية واحدة بلا أختها بلا معنى: نقبل الاثنتين معًا أو نمسحهما معًا.
  const hasCoords = isValidCoords(b.lat, b.lng);
  const clearCoords = b.lat === null || b.lng === null;

  const patch: Record<string, unknown> = {
    name: b.name,
    activityType: b.activity_type ?? null,
    cityId: b.city_id && Types.ObjectId.isValid(b.city_id) ? b.city_id : null,
    bio: b.bio ?? null,
    phone: b.phone ?? null,
    whatsapp: b.whatsapp ?? null,
  };
  if (b.address !== undefined) patch["address"] = b.address ?? null;
  if (hasCoords) {
    patch["lat"] = b.lat;
    patch["lng"] = b.lng;
  } else if (clearCoords) {
    patch["lat"] = null;
    patch["lng"] = null;
  }

  try {
    // isVerified غير مذكور هنا: التوثيق من الإدارة وحدها.
    const seller = await Seller.findOneAndUpdate(
      { userId },
      { $set: patch, $setOnInsert: { userId, slug: slugify(b.name) } },
      { new: true, upsert: true },
    ).populate("cityId");

    // مستخدم أنشأ متجرًا صار بائعًا.
    await User.updateOne({ _id: userId }, { $set: { accountType: "store" } });

    // مزامنة الإحداثيات مع إعلانات المتجر: البحث بالقرب يستعلم عن
    // الإعلانات مباشرة، فلو لم تُحدَّث لبقيت تظهر في الموقع القديم.
    if (hasCoords || clearCoords) {
      await Listing.updateMany(
        { sellerId: seller._id },
        { $set: { lat: patch["lat"] ?? null, lng: patch["lng"] ?? null } },
      );
    }

    return c.json(serializeSeller(seller.toObject(), { includeContact: true }));
  } catch (err) {
    throw fromMongo(err);
  }
});

/** صفحة البائع العامة — بيانات التواصل للمسجّلين فقط. */
sellersRoute.get("/:slug", optionalAuth, async (c) => {
  const seller = await Seller.findOne({ slug: c.req.param("slug") }).populate("cityId").lean();
  if (!seller) throw ApiError.notFound("المتجر غير موجود");

  const includeContact = Boolean(c.get("maybeUser"));
  const listings = await Listing.find({ sellerId: seller._id, status: "active" })
    .sort({ createdAt: -1 })
    .populate([{ path: "categoryId" }, { path: "cityId" }] as never)
    .lean();

  return c.json({
    seller: serializeSeller(seller, { includeContact }),
    listings: listings.map((l) => serializeListing(l, { includeContact })),
  });
});
