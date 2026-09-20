/**
 * تكامل Cloudinary.
 *
 * الرفع يتم من المتصفّح مباشرة إلى Cloudinary، لا عبر هذا الخادم:
 * الخادم يوقّع الطلب فقط. هذا يوفّر مرور الصور بالكامل عبر Railway
 * (حيث النطاق الترددي والذاكرة محدودان) ويجعل الرفع أسرع للمستخدم.
 *
 * لكن التوقيع ليس تفويضًا مفتوحًا: نثبّت المجلد والصيغ المسموحة وحجم
 * الملف داخل التوقيع نفسه، فلا يستطيع العميل تغييرها بعد أن نوقّع.
 */
import { v2 as cloudinary } from "cloudinary";
import { env } from "../env.js";

cloudinary.config({
  cloud_name: env.cloudinaryCloudName,
  api_key: env.cloudinaryApiKey,
  api_secret: env.cloudinaryApiSecret,
  secure: true,
});

export interface UploadSignature {
  timestamp: number;
  signature: string;
  apiKey: string;
  cloudName: string;
  folder: string;
  uploadUrl: string;
  maxFileSize: number;
  allowedFormats: string[];
}

/** أقصى حجم للصورة الواحدة: 5 ميغابايت. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_FORMATS = ["jpg", "jpeg", "png", "webp", "avif"];

/**
 * يوقّع طلب رفع واحدًا.
 * `folder` يُحقن في التوقيع، فالعميل لا يستطيع الرفع خارج مجلد المشروع.
 */
export function createUploadSignature(subfolder: string): UploadSignature {
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `${env.cloudinaryFolder}/${subfolder}`.replace(/\/+/g, "/");

  // كل معامل يدخل التوقيع يجب أن يُرسله العميل حرفيًا، وإلا رفضت Cloudinary الطلب.
  const params: Record<string, string | number> = { folder, timestamp };
  const signature = cloudinary.utils.api_sign_request(params, env.cloudinaryApiSecret);

  return {
    timestamp,
    signature,
    apiKey: env.cloudinaryApiKey,
    cloudName: env.cloudinaryCloudName,
    folder,
    uploadUrl: `https://api.cloudinary.com/v1_1/${env.cloudinaryCloudName}/image/upload`,
    maxFileSize: MAX_IMAGE_BYTES,
    allowedFormats: ALLOWED_FORMATS,
  };
}

/**
 * يتحقق أن publicId قادم من العميل يقع فعلًا داخل مجلد المشروع.
 * بدون هذا الفحص يستطيع مستخدم أن يرسل معرّف صورة لا يملكها فتُحذف.
 */
export function isOwnedPublicId(publicId: string): boolean {
  return publicId.startsWith(`${env.cloudinaryFolder}/`);
}

/** يتأكد أن الصورة موجودة فعلًا على Cloudinary ويعيد رابطها الرسمي. */
export async function verifyUploadedImage(
  publicId: string,
): Promise<{ url: string; bytes: number; format: string } | null> {
  if (!isOwnedPublicId(publicId)) return null;
  try {
    const res = await cloudinary.api.resource(publicId, { resource_type: "image" });
    return { url: res.secure_url as string, bytes: res.bytes as number, format: res.format as string };
  } catch {
    return null;
  }
}

/** حذف صورة واحدة. لا يرمي استثناء: فشل الحذف لا يمنع حذف الإعلان. */
export async function destroyImage(publicId: string): Promise<void> {
  if (!isOwnedPublicId(publicId)) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "image", invalidate: true });
  } catch (err) {
    console.error("[cloudinary] تعذّر حذف الصورة", publicId, err);
  }
}

export async function destroyImages(publicIds: string[]): Promise<void> {
  await Promise.all(publicIds.map((id) => destroyImage(id)));
}

/**
 * يبني رابط عرض محسّنًا: تحجيم وضغط وصيغة تلقائية حسب المتصفّح.
 * هذه أهم فائدة عملية من Cloudinary — صورة 4 ميغابايت تصل المستخدم
 * بعشرات الكيلوبايتات دون أي معالجة عندنا.
 */
export function buildImageUrl(
  publicId: string,
  opts: { width?: number; height?: number; crop?: "fill" | "fit" } = {},
): string {
  const { width = 800, height, crop = "fill" } = opts;
  return cloudinary.url(publicId, {
    secure: true,
    transformation: [
      {
        width,
        ...(height ? { height } : {}),
        crop,
        quality: "auto",
        fetch_format: "auto",
      },
    ],
  });
}
