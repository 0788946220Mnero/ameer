import { Hono } from "hono";
import { z } from "zod";
import { Types } from "mongoose";
import { ApiError, fromMongo } from "../../lib/errors.js";
import { serializeCategory, serializeCity, serializeContactMessage } from "../../lib/serialize.js";
import { logAdminAction } from "../../lib/audit.js";
import { Category, City, Listing, ContactMessage } from "../../models/index.js";

export const taxonomyRoute = new Hono();
export const messagesRoute = new Hono();

type TaxTable = "categories" | "cities";

function readTable(raw: string): TaxTable {
  if (raw !== "categories" && raw !== "cities") throw ApiError.badRequest("جدول غير مدعوم");
  return raw;
}

function slugify(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return `${base || "item"}-${Math.random().toString(36).slice(2, 7)}`;
}

const createSchema = z.object({
  name_ar: z.string().trim().min(2, "الاسم قصير جدًا").max(80, "الاسم طويل جدًا"),
});
const patchSchema = z
  .object({
    name_ar: z.string().trim().min(2).max(80).optional(),
    sort_order: z.number().int().min(0).max(9999).optional(),
  })
  .refine((v) => v.name_ar !== undefined || v.sort_order !== undefined, {
    message: "لا يوجد شيء لتحديثه",
  });

taxonomyRoute.get("/:table", async (c) => {
  const table = readTable(c.req.param("table"));
  if (table === "categories") {
    const rows = await Category.find().sort({ sortOrder: 1 }).lean();
    return c.json(rows.map(serializeCategory));
  }
  const rows = await City.find().sort({ sortOrder: 1 }).lean();
  return c.json(rows.map(serializeCity));
});

taxonomyRoute.post("/:table", async (c) => {
  const table = readTable(c.req.param("table"));
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "اسم غير صالح");
  const name = parsed.data.name_ar;

  try {
    // الـ slug يولّده الخادم، فلا يستطيع العميل فرض قيمة متضاربة.
    if (table === "categories") {
      const count = await Category.countDocuments();
      const doc = await Category.create({ nameAr: name, slug: slugify(name), sortOrder: count + 1 });
      await logAdminAction(c.get("user").id, "add_categories", "categories", String(doc._id), name);
      return c.json(serializeCategory(doc.toObject()), 201);
    }
    const count = await City.countDocuments();
    const doc = await City.create({ nameAr: name, slug: slugify(name), sortOrder: count + 1 });
    await logAdminAction(c.get("user").id, "add_cities", "cities", String(doc._id), name);
    return c.json(serializeCity(doc.toObject()), 201);
  } catch (err) {
    throw fromMongo(err);
  }
});

taxonomyRoute.patch("/:table/:id", async (c) => {
  const table = readTable(c.req.param("table"));
  const id = c.req.param("id");
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest("معرّف غير صالح", "invalid_id");

  const parsed = patchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "طلب غير صالح");

  const update: Record<string, unknown> = {};
  if (parsed.data.name_ar !== undefined) update["nameAr"] = parsed.data.name_ar;
  if (parsed.data.sort_order !== undefined) update["sortOrder"] = parsed.data.sort_order;

  try {
    if (table === "categories") {
      const doc = await Category.findByIdAndUpdate(id, { $set: update }, { new: true }).lean();
      if (!doc) throw ApiError.notFound("العنصر غير موجود");
      await logAdminAction(c.get("user").id, "rename_categories", "categories", id, parsed.data.name_ar ?? null);
      return c.json(serializeCategory(doc));
    }
    const doc = await City.findByIdAndUpdate(id, { $set: update }, { new: true }).lean();
    if (!doc) throw ApiError.notFound("العنصر غير موجود");
    await logAdminAction(c.get("user").id, "rename_cities", "cities", id, parsed.data.name_ar ?? null);
    return c.json(serializeCity(doc));
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw fromMongo(err);
  }
});

taxonomyRoute.delete("/:table/:id", async (c) => {
  const table = readTable(c.req.param("table"));
  const id = c.req.param("id");
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest("معرّف غير صالح", "invalid_id");

  // لا مفاتيح أجنبية في Mongo: الفحص هنا هو ما يمنع أقسامًا يتيمة في الإعلانات.
  const field = table === "categories" ? "categoryId" : "cityId";
  const inUse = await Listing.countDocuments({ [field]: id });
  if (inUse > 0) throw ApiError.badRequest(`لا يمكن الحذف: مرتبط بـ ${inUse} إعلانًا`, "in_use");

  if (table === "categories") await Category.deleteOne({ _id: id });
  else await City.deleteOne({ _id: id });

  await logAdminAction(c.get("user").id, `delete_${table}`, table, id);
  return c.json({ ok: true });
});

// ── رسائل التواصل ──────────────────────────────────────────
const messagePatch = z.object({ status: z.enum(["open", "closed"]) });

messagesRoute.get("/", async (c) => {
  const rows = await ContactMessage.find().sort({ createdAt: -1 }).limit(200).lean();
  return c.json(rows.map(serializeContactMessage));
});

messagesRoute.patch("/:id", async (c) => {
  const id = c.req.param("id");
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest("معرّف غير صالح", "invalid_id");

  const parsed = messagePatch.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest("حالة غير مسموح بها");

  const doc = await ContactMessage.findByIdAndUpdate(id, { $set: { status: parsed.data.status } }, { new: true }).lean();
  if (!doc) throw ApiError.notFound("الرسالة غير موجودة");

  await logAdminAction(c.get("user").id, `message_${parsed.data.status}`, "contact_message", id);
  return c.json({ id, status: doc.status });
});
