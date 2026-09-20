/**
 * توثيق الحسابات — للأشخاص والمتاجر بنفس المسار.
 *
 * كان التوثيق على المتجر وحده، فلم يكن للأفراد سبيل إليه. نقله إلى المستخدم
 * يعطي شارة واحدة ومصدر حقيقة واحدًا مهما كان نوع الحساب.
 */
import { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "../lib/errors.js";
import { serializeUser } from "../lib/serialize.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { verifyUploadedImage } from "../lib/cloudinary.js";
import { User } from "../models/index.js";

export const verificationRoute = new Hono();
verificationRoute.use("*", requireAuth);

const submitSchema = z.object({
  /** معرّف صورة الوثيقة على Cloudinary — تُرفع كما تُرفع صور الإعلانات. */
  document_public_id: z.string().trim().min(3).max(300).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

verificationRoute.get("/", async (c) => {
  const user = await User.findById(c.get("user").id).lean();
  if (!user) throw ApiError.notFound("الحساب غير موجود");
  return c.json(serializeUser(user).verification);
});

verificationRoute.post(
  "/",
  rateLimit({ name: "verify-submit", limit: 5, windowMs: 24 * 60 * 60 * 1000, key: (c) => c.get("user").id }),
  async (c) => {
    const parsed = submitSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "بيانات غير صالحة");

    const user = await User.findById(c.get("user").id);
    if (!user) throw ApiError.notFound("الحساب غير موجود");

    const status = user.verification?.status ?? "none";
    if (status === "approved") throw ApiError.badRequest("حسابك موثّق بالفعل", "already_verified");
    if (status === "pending") throw ApiError.badRequest("طلبك قيد المراجعة", "already_pending");

    let documentUrl: string | null = null;
    const publicId = parsed.data.document_public_id ?? null;
    if (publicId) {
      // نفس فحص صور الإعلانات: نتأكّد أن الصورة موجودة وداخل مجلد المشروع،
      // وإلا أمكن حقن أي رابط خارجي في طلب التوثيق.
      const meta = await verifyUploadedImage(publicId);
      if (!meta) throw ApiError.badRequest("صورة الوثيقة غير صالحة", "invalid_image");
      documentUrl = meta.url;
    }

    user.verification = {
      status: "pending",
      documentUrl,
      documentPublicId: publicId,
      note: parsed.data.note ?? null,
      reviewNote: null,
      submittedAt: new Date(),
      reviewedAt: null,
      reviewedBy: null,
    };
    await user.save();

    return c.json(serializeUser(user.toObject()).verification, 201);
  },
);
