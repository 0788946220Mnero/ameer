import { Hono } from "hono";
import { z } from "zod";
import { Types } from "mongoose";
import { ApiError, fromMongo } from "../../lib/errors.js";
import { serializeReport, serializeSeller } from "../../lib/serialize.js";
import { logAdminAction } from "../../lib/audit.js";
import { Report, Seller } from "../../models/index.js";

export const reportsRoute = new Hono();
export const adminSellersRoute = new Hono();

const REPORT_STATUSES = ["open", "reviewed", "dismissed"] as const;
const reportPatch = z.object({ status: z.enum(REPORT_STATUSES) });

reportsRoute.get("/", async (c) => {
  const rows = await Report.find()
    .sort({ createdAt: -1 })
    .limit(200)
    .populate({ path: "listingId", select: "title status" } as never)
    .lean();
  return c.json(rows.map(serializeReport));
});

reportsRoute.patch("/:id", async (c) => {
  const id = c.req.param("id");
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest("معرّف غير صالح", "invalid_id");

  const parsed = reportPatch.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest("حالة البلاغ غير مسموح بها");

  const doc = await Report.findByIdAndUpdate(id, { $set: { status: parsed.data.status } }, { new: true }).lean();
  if (!doc) throw ApiError.notFound("البلاغ غير موجود");

  await logAdminAction(c.get("user").id, `report_${parsed.data.status}`, "report", id);
  return c.json({ id, status: doc.status });
});

// ── البائعون ───────────────────────────────────────────────
const sellerPatch = z.object({ is_verified: z.boolean() });

adminSellersRoute.get("/", async (c) => {
  const rows = await Seller.find().sort({ createdAt: -1 }).limit(300).populate("cityId").lean();
  return c.json(rows.map((s) => serializeSeller(s, { includeContact: true })));
});

adminSellersRoute.patch("/:id", async (c) => {
  const id = c.req.param("id");
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest("معرّف غير صالح", "invalid_id");

  const parsed = sellerPatch.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest("قيمة التوثيق غير صالحة");

  let doc;
  try {
    doc = await Seller.findByIdAndUpdate(id, { $set: { isVerified: parsed.data.is_verified } }, { new: true }).lean();
  } catch (err) {
    throw fromMongo(err);
  }
  if (!doc) throw ApiError.notFound("البائع غير موجود");

  await logAdminAction(
    c.get("user").id,
    parsed.data.is_verified ? "verify_seller" : "unverify_seller",
    "seller", id, doc.name,
  );
  return c.json({ id, name: doc.name, is_verified: doc.isVerified });
});
