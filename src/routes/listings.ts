/**
 * الإعلانات — القراءة العامة، وإدارة المستخدم لإعلاناته.
 *
 * كل ما كانت تضمنه سياسات RLS صار شرطًا صريحًا هنا:
 *   • العام يرى الحالة active فقط.
 *   • المالك يرى إعلاناته بكل الحالات.
 *   • التعديل والحذف للمالك وحده.
 *   • الحالة لا تخرج من rejected، والعدّادات والتمييز لا يلمسها العميل.
 */
import { Hono } from "hono";
import { z } from "zod";
import { Types } from "mongoose";
import { ApiError, fromMongo } from "../lib/errors.js";
import { serializeListing } from "../lib/serialize.js";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { destroyImages, verifyUploadedImage } from "../lib/cloudinary.js";
import { boundingBox, distanceKm, isValidCoords } from "../lib/geo.js";
import { getSettings } from "../lib/settings.js";
import { Listing, Seller, Favorite, RecentView, Conversation, Message } from "../models/index.js";

export const listingsRoute = new Hono();

/** الأردن طوله نحو 400 كم؛ السقف يغطّي البلد كاملًا ويمنع مسح القاعدة. */
const MAX_RADIUS_KM = 500;
/** أقصى عدد مرشّحين يُجلبون من المربّع قبل التنقية بالمسافة. */
const NEARBY_CANDIDATE_CAP = 500;

const POPULATE = [
  { path: "categoryId" },
  { path: "cityId" },
  { path: "sellerId", populate: { path: "cityId" } },
] as const;

function objectId(raw: string | undefined, label: string): Types.ObjectId {
  if (!raw || !Types.ObjectId.isValid(raw)) throw ApiError.badRequest(`${label} غير صالح`, "invalid_id");
  return new Types.ObjectId(raw);
}

const imageInput = z.object({
  public_id: z.string().min(3).max(300),
  sort_order: z.number().int().min(0).max(50).default(0),
});

const tierInput = z.object({
  min_qty: z.number().int().min(1),
  max_qty: z.number().int().min(1).nullable().optional(),
  price: z.number().min(0),
});

const createSchema = z.object({
  kind: z.enum(["offer", "wanted"]).default("offer"),
  category_id: z.string(),
  city_id: z.string(),
  title: z.string().trim().min(3, "العنوان قصير جدًا").max(160),
  description: z.string().trim().min(10, "الوصف قصير جدًا").max(5000),
  /** للمعروض إلزامي، وللمطلوب ميزانية تقريبية اختيارية. */
  price: z.number().min(0, "السعر غير صالح").nullable().optional(),
  unit: z.string().trim().min(1).max(40),
  min_order: z.number().int().min(2, "المنصّة للجملة: أقل كمية 2"),
  /** للمطلوب: آخر موعد يحتاج فيه المشتري البضاعة. */
  needed_by: z.string().datetime().nullable().optional(),
  available_qty: z.number().int().min(0).nullable().optional(),
  area: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  has_whatsapp: z.boolean().default(false),
  has_delivery: z.boolean().default(false),
  images: z.array(imageInput).max(10, "أقصى عدد صور 10").default([]),
  price_tiers: z.array(tierInput).max(10).default([]),
});

/**
 * يحوّل صور العميل إلى صور مخزّنة، بعد التأكد من وجود كل صورة فعلًا على
 * Cloudinary وأنها داخل مجلد المشروع. بدون هذا الفحص يستطيع العميل حقن
 * أي رابط خارجي في إعلانه.
 */
async function resolveImages(input: z.infer<typeof imageInput>[]) {
  const resolved = await Promise.all(
    input.map(async (img) => {
      const meta = await verifyUploadedImage(img.public_id);
      if (!meta) return null;
      return { url: meta.url, publicId: img.public_id, sortOrder: img.sort_order };
    }),
  );
  const ok = resolved.filter((x): x is NonNullable<typeof x> => x !== null);
  if (ok.length !== input.length) {
    throw ApiError.badRequest("بعض الصور غير موجودة أو خارج مجلد المشروع", "invalid_image");
  }
  return ok;
}

function mapTiers(tiers: z.infer<typeof tierInput>[]) {
  return tiers.map((t) => ({ minQty: t.min_qty, maxQty: t.max_qty ?? null, price: t.price }));
}

// ── قائمة عامة ─────────────────────────────────────────────
listingsRoute.get("/", optionalAuth, async (c) => {
  const q = c.req.query();
  const limit = Math.min(Number(q["limit"] ?? 24) || 24, 60);
  const page = Math.max(Number(q["page"] ?? 1) || 1, 1);

  // النوع الافتراضي "معروض": الزائر الذي لا يحدّد شيئًا يريد تصفّح البضاعة.
  const kind = q["kind"] === "wanted" ? "wanted" : "offer";
  const filter: Record<string, unknown> = { status: "active", kind };

  // الطلبات المنتهية لا تُعرض: مشترٍ احتاج بضاعة الشهر الماضي لا يفيد أحدًا.
  if (kind === "wanted") {
    filter["$or"] = [{ neededBy: null }, { neededBy: { $gte: new Date() } }];
  }
  if (q["cat"] && Types.ObjectId.isValid(q["cat"])) filter["categoryId"] = q["cat"];
  if (q["city"] && Types.ObjectId.isValid(q["city"])) filter["cityId"] = q["city"];
  if (q["seller"] && Types.ObjectId.isValid(q["seller"])) filter["sellerId"] = q["seller"];
  if (q["featured"] === "1") filter["isFeatured"] = true;

  const min = Number(q["min_price"]);
  const max = Number(q["max_price"]);
  if (!Number.isNaN(min) || !Number.isNaN(max)) {
    filter["price"] = {
      ...(Number.isNaN(min) ? {} : { $gte: min }),
      ...(Number.isNaN(max) ? {} : { $lte: max }),
    };
  }
  if (q["delivery"] === "1") filter["hasDelivery"] = true;

  // البحث بالقرب: مربّع إحداثيات يحصر المرشّحين، ثم تنقية بالمسافة الحقيقية
  // بعد الجلب. المربّع وحده يُدخل زوايا أبعد من نصف القطر المطلوب.
  const lat = Number(q["lat"]);
  const lng = Number(q["lng"]);
  const radiusKm = Math.min(Math.max(Number(q["radius_km"]) || 0, 0), MAX_RADIUS_KM);
  const nearby = isValidCoords(lat, lng) && radiusKm > 0;

  if (nearby) {
    const box = boundingBox(lat, lng, radiusKm);
    filter["lat"] = { $gte: box.minLat, $lte: box.maxLat };
    filter["lng"] = { $gte: box.minLng, $lte: box.maxLng };
  }

  const search = q["q"]?.trim();
  if (search) {
    // regex لا $text: البحث النصّي في Mongo لا يجزّئ العربية جيدًا،
    // و regex يطابق جزء الكلمة وهو ما يتوقّعه المستخدم عمليًا.
    const safe = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // $or مستخدم أعلاه لفلترة الطلبات المنتهية؛ الكتابة فوقه تُلغي ذلك
    // الشرط بصمت. $and يجمع الشرطين بأمان.
    const searchOr = [
      { title: { $regex: safe, $options: "i" } },
      { description: { $regex: safe, $options: "i" } },
    ];
    if (filter["$or"]) {
      filter["$and"] = [{ $or: filter["$or"] }, { $or: searchOr }];
      delete filter["$or"];
    } else {
      filter["$or"] = searchOr;
    }
  }

  const sortKey = q["sort"] ?? "newest";
  const sort: Record<string, 1 | -1> =
    sortKey === "price_asc" ? { price: 1 } :
    sortKey === "price_desc" ? { price: -1 } :
    sortKey === "popular" ? { views: -1, createdAt: -1 } :
    { isFeatured: -1, createdAt: -1 };

  const includeContact = Boolean(c.get("maybeUser"));

  if (nearby) {
    // البحث بالقرب: نجلب مرشّحي المربّع، ننقّيهم بالمسافة الحقيقية، نرتّبهم
    // بالأقرب، ثم نقطّعهم صفحات. الترقيم بعد التنقية وإلا ظهرت صفحات ناقصة.
    const candidates = await Listing.find(filter)
      .limit(NEARBY_CANDIDATE_CAP)
      .populate(POPULATE as never)
      .lean();

    const withDistance = candidates
      .map((r) => ({ row: r, km: distanceKm(lat, lng, r.lat as number, r.lng as number) }))
      .filter((x) => x.km <= radiusKm)
      .sort((a, b) => a.km - b.km);

    const slice = withDistance.slice((page - 1) * limit, page * limit);
    return c.json({
      items: slice.map((x) =>
        serializeListing(x.row, { includeContact, distanceKm: Math.round(x.km * 10) / 10 }),
      ),
      total: withDistance.length,
      page,
      limit,
      has_more: page * limit < withDistance.length,
    });
  }

  const [rows, total] = await Promise.all([
    Listing.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).populate(POPULATE as never).lean(),
    Listing.countDocuments(filter),
  ]);

  return c.json({
    items: rows.map((r) => serializeListing(r, { includeContact })),
    total,
    page,
    limit,
    has_more: page * limit < total,
  });
});

// ── إعلاناتي ───────────────────────────────────────────────
listingsRoute.get("/mine", requireAuth, async (c) => {
  const rows = await Listing.find({ userId: c.get("user").id })
    .sort({ createdAt: -1 })
    .populate(POPULATE as never)
    .lean();
  return c.json(rows.map((r) => serializeListing(r, { includeContact: true })));
});

listingsRoute.get("/favorites", requireAuth, async (c) => {
  const favs = await Favorite.find({ userId: c.get("user").id }).select("listingId").lean();
  const rows = await Listing.find({ _id: { $in: favs.map((f) => f.listingId) }, status: "active" })
    .populate(POPULATE as never)
    .lean();
  return c.json(rows.map((r) => serializeListing(r, { includeContact: true })));
});

listingsRoute.get("/recent", requireAuth, async (c) => {
  const views = await RecentView.find({ userId: c.get("user").id })
    .sort({ viewedAt: -1 })
    .limit(12)
    .select("listingId")
    .lean();
  const rows = await Listing.find({ _id: { $in: views.map((v) => v.listingId) }, status: "active" })
    .populate(POPULATE as never)
    .lean();
  return c.json(rows.map((r) => serializeListing(r, { includeContact: true })));
});

// ── إعلان واحد ─────────────────────────────────────────────
listingsRoute.get("/:id", optionalAuth, async (c) => {
  const id = objectId(c.req.param("id"), "معرّف الإعلان");
  const row = await Listing.findById(id).populate(POPULATE as never).lean();
  if (!row) throw ApiError.notFound("الإعلان غير موجود");

  const viewer = c.get("maybeUser");
  const isOwner = viewer && String(row.userId) === viewer.id;
  if (row.status !== "active" && !isOwner && !viewer?.isAdmin) {
    throw ApiError.notFound("الإعلان غير موجود");
  }

  if (viewer) {
    // تسجيل المشاهدة الأخيرة — لا يُنتظر، فشله لا يعني فشل الطلب.
    void RecentView.updateOne(
      { userId: viewer.id, listingId: id },
      { $set: { viewedAt: new Date() } },
      { upsert: true },
    ).catch(() => undefined);
  }

  return c.json(serializeListing(row, { includeContact: Boolean(viewer) }));
});

// ── عدّادات الأداء ─────────────────────────────────────────
const METRICS = { views: "views", phone_clicks: "phoneClicks", chats: "chatsCount" } as const;

listingsRoute.post("/:id/metric", async (c) => {
  const id = objectId(c.req.param("id"), "معرّف الإعلان");
  const body = (await c.req.json().catch(() => ({}))) as { metric?: keyof typeof METRICS };
  const field = body.metric ? METRICS[body.metric] : undefined;
  if (!field) throw ApiError.badRequest("عدّاد غير معروف");

  // المسار الوحيد لتغيير العدّادات. لا يقبل قيمة من العميل، يزيد بواحد فقط.
  await Listing.updateOne({ _id: id }, { $inc: { [field]: 1 } });
  return c.json({ ok: true });
});

// ── إنشاء إعلان ────────────────────────────────────────────
listingsRoute.post("/", requireAuth, async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "بيانات غير صالحة");
  const b = parsed.data;
  const userId = c.get("user").id;

  const settings = await getSettings();

  // مفتاح الإيقاف في لوحة التحكم: الموقع يبقى يعمل ويُتصفَّح، لكن لا تُضاف
  // إعلانات جديدة. المدير يستثنى ليجرّب دون رفع الإيقاف.
  if (settings["listings_paused"] === true && !c.get("user").isAdmin) {
    throw new ApiError(503, "listings_paused", "نشر الإعلانات موقوف مؤقتًا، حاول لاحقًا");
  }

  // المتجر شرط للمعروض وحده. طلب الشراء يكتبه أي مستخدم، وهذا جوهر
  // القسم الجديد: المشتري لا يملك متجرًا ولا يُفترض أن يُنشئ واحدًا ليطلب.
  const isWanted = b.kind === "wanted";
  const seller = await Seller.findOne({ userId }).lean();

  if (!isWanted && !seller) {
    throw ApiError.badRequest("أنشئ متجرك أولًا قبل عرض منتج", "no_seller");
  }
  if (!isWanted && (b.price === null || b.price === undefined)) {
    throw ApiError.badRequest("السعر إلزامي في إعلان المعروض", "price_required");
  }

  const images = await resolveImages(b.images);

  try {
    const created = await Listing.create({
      userId,
      kind: b.kind,
      sellerId: seller?._id ?? null,
      categoryId: objectId(b.category_id, "القسم"),
      cityId: objectId(b.city_id, "المدينة"),
      title: b.title,
      description: b.description,
      price: b.price ?? null,
      unit: b.unit,
      neededBy: isWanted && b.needed_by ? new Date(b.needed_by) : null,
      minOrder: b.min_order,
      availableQty: b.available_qty ?? null,
      area: b.area ?? null,
      phone: b.phone ?? null,
      hasWhatsapp: b.has_whatsapp,
      hasDelivery: b.has_delivery,
      // نسخة من موقع المتجر وقت الإنشاء؛ تُحدَّث لاحقًا مع أي تغيير للمتجر.
      lat: typeof seller?.lat === "number" ? seller.lat : null,
      lng: typeof seller?.lng === "number" ? seller.lng : null,
      images,
      priceTiers: mapTiers(b.price_tiers),
      // الحالة لا تُقرأ من العميل إطلاقًا: تحدّدها سياسة المنصّة.
      // مع تفعيل المراجعة ينتظر الإعلان اعتماد الإدارة بدل النشر التلقائي.
      status: settings["moderate_new_listings"] === true ? "pending" : "active",
    });
    const full = await Listing.findById(created._id).populate(POPULATE as never).lean();
    return c.json(serializeListing(full!, { includeContact: true }), 201);
  } catch (err) {
    // الإعلان فشل بعد رفع الصور: نحذفها حتى لا تتراكم صور يتيمة تُحتسب علينا.
    await destroyImages(images.map((i) => i.publicId));
    throw fromMongo(err);
  }
});

// ── تعديل إعلان ────────────────────────────────────────────
const updateSchema = createSchema.partial().extend({
  status: z.enum(["active", "paused", "pending"]).optional(),
});

listingsRoute.patch("/:id", requireAuth, async (c) => {
  const id = objectId(c.req.param("id"), "معرّف الإعلان");
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "بيانات غير صالحة");
  const b = parsed.data;

  const listing = await Listing.findById(id);
  if (!listing) throw ApiError.notFound("الإعلان غير موجود");
  if (String(listing.userId) !== c.get("user").id) throw ApiError.forbidden("هذا الإعلان ليس لك");

  // قرار الرفض نهائي من جهة المستخدم؛ تغييره من الإدارة وحدها.
  if (listing.status === "rejected") {
    throw ApiError.forbidden("هذا الإعلان مرفوض من الإدارة ولا يمكن تعديله", "rejected_locked");
  }

  if (b.title !== undefined) listing.title = b.title;
  if (b.description !== undefined) listing.description = b.description;
  if (b.price !== undefined) listing.price = b.price ?? null;
  if (b.needed_by !== undefined) {
    listing.neededBy = b.needed_by ? new Date(b.needed_by) : null;
  }
  if (b.unit !== undefined) listing.unit = b.unit;
  if (b.min_order !== undefined) listing.minOrder = b.min_order;
  if (b.available_qty !== undefined) listing.availableQty = b.available_qty ?? null;
  if (b.area !== undefined) listing.area = b.area ?? null;
  if (b.phone !== undefined) listing.phone = b.phone ?? null;
  if (b.has_whatsapp !== undefined) listing.hasWhatsapp = b.has_whatsapp;
  if (b.has_delivery !== undefined) listing.hasDelivery = b.has_delivery;
  if (b.category_id !== undefined) listing.categoryId = objectId(b.category_id, "القسم");
  if (b.city_id !== undefined) listing.cityId = objectId(b.city_id, "المدينة");
  if (b.price_tiers !== undefined) listing.priceTiers = mapTiers(b.price_tiers) as never;
  if (b.status !== undefined) listing.status = b.status;

  let removed: string[] = [];
  if (b.images !== undefined) {
    const next = await resolveImages(b.images);
    const keep = new Set(next.map((i) => i.publicId));
    removed = listing.images.filter((i) => !keep.has(i.publicId)).map((i) => i.publicId);
    listing.images = next as never;
  }

  try {
    await listing.save();
  } catch (err) {
    throw fromMongo(err);
  }

  // الحذف من Cloudinary بعد نجاح الحفظ فقط.
  if (removed.length) void destroyImages(removed);

  const full = await Listing.findById(id).populate(POPULATE as never).lean();
  return c.json(serializeListing(full!, { includeContact: true }));
});

// ── حذف إعلان ──────────────────────────────────────────────
listingsRoute.delete("/:id", requireAuth, async (c) => {
  const id = objectId(c.req.param("id"), "معرّف الإعلان");
  const listing = await Listing.findById(id);
  if (!listing) throw ApiError.notFound("الإعلان غير موجود");
  if (String(listing.userId) !== c.get("user").id) throw ApiError.forbidden("هذا الإعلان ليس لك");

  const publicIds = listing.images.map((i) => i.publicId);
  await Listing.deleteOne({ _id: id });

  // لا وجود لـ ON DELETE CASCADE في Mongo: التنظيف مسؤوليتنا صراحةً.
  const convs = await Conversation.find({ listingId: id }).select("_id").lean();
  await Promise.all([
    Favorite.deleteMany({ listingId: id }),
    RecentView.deleteMany({ listingId: id }),
    Message.deleteMany({ conversationId: { $in: convs.map((x) => x._id) } }),
    Conversation.deleteMany({ listingId: id }),
    destroyImages(publicIds),
  ]);

  return c.json({ ok: true });
});
