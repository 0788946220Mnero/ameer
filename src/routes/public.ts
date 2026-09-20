/** المسارات العامة: نموذج التواصل والبلاغات. */
import { Hono } from "hono";
import { z } from "zod";
import { Types } from "mongoose";
import { env } from "../env.js";
import { ApiError, fromMongo } from "../lib/errors.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { optionalAuth } from "../middleware/auth.js";
import { ContactMessage, Report } from "../models/index.js";

export const publicRoute = new Hono();

const contactSchema = z.object({
  name: z.string().trim().min(2, "الاسم قصير جدًا").max(120),
  contact: z.string().trim().min(3, "وسيلة التواصل قصيرة").max(160),
  message: z.string().trim().min(5, "الرسالة قصيرة جدًا").max(4000),
  /** حقل فخّ: يُفحص في المعالج لا في المخطّط. */
  website: z.string().max(200).optional(),
});

const reportSchema = z.object({
  listing_id: z.string().nullable().optional(),
  reason: z.string().trim().min(2).max(120),
  details: z.string().trim().max(2000).optional(),
});

const publicLimit = rateLimit({
  name: "public-write",
  limit: env.contactRateLimit,
  windowMs: env.contactRateWindowMs,
});

publicRoute.post("/contact", publicLimit, optionalAuth, async (c) => {
  const parsed = contactSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "بيانات غير صالحة");
  const { name, contact, message, website } = parsed.data;

  // البوت ملأ الحقل الفخّ: نجاح صامت حتى لا يعرف أنه كُشف.
  if (website?.trim()) return c.json({ ok: true }, 201);

  try {
    await ContactMessage.create({
      name,
      contact,
      message,
      userId: c.get("maybeUser")?.id ?? null,
      status: "open",
    });
  } catch (err) {
    throw fromMongo(err);
  }
  return c.json({ ok: true }, 201);
});

publicRoute.post("/reports", publicLimit, optionalAuth, async (c) => {
  const parsed = reportSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "بيانات غير صالحة");
  const b = parsed.data;

  const listingId = b.listing_id && Types.ObjectId.isValid(b.listing_id) ? b.listing_id : null;

  try {
    // هوية المبلّغ من التوكن لا من جسم الطلب — لا يمكن انتحالها.
    await Report.create({
      listingId,
      reporterId: c.get("maybeUser")?.id ?? null,
      reason: b.reason,
      details: b.details ?? null,
      status: "open",
    });
  } catch (err) {
    throw fromMongo(err);
  }
  return c.json({ ok: true }, 201);
});
