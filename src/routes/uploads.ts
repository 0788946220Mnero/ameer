/**
 * توقيع رفع الصور إلى Cloudinary.
 *
 * الخادم لا يستقبل الملف: يوقّع فقط، والمتصفّح يرفع مباشرة إلى Cloudinary.
 * المجلد مثبّت داخل التوقيع، فلا يستطيع العميل الرفع خارج مجلد المشروع.
 */
import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { createUploadSignature } from "../lib/cloudinary.js";

export const uploadsRoute = new Hono();

uploadsRoute.post(
  "/signature",
  requireAuth,
  // سقف معقول: 60 صورة في الساعة لكل مستخدم.
  rateLimit({ name: "upload", limit: 60, windowMs: 60 * 60 * 1000, key: (c) => c.get("user").id }),
  (c) => c.json(createUploadSignature(c.get("user").id)),
);
