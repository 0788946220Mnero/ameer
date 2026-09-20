import type { ContentfulStatusCode } from "hono/utils/http-status";

/** خطأ يحمل رمز حالة HTTP ورسالة عربية صالحة للعرض للمستخدم. */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;

  constructor(status: ContentfulStatusCode, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  static badRequest(message = "طلب غير صالح", code = "bad_request") {
    return new ApiError(400, code, message);
  }
  static unauthorized(message = "يلزم تسجيل الدخول", code = "unauthorized") {
    return new ApiError(401, code, message);
  }
  static forbidden(message = "غير مصرّح لك بهذا الإجراء", code = "forbidden") {
    return new ApiError(403, code, message);
  }
  static notFound(message = "العنصر غير موجود", code = "not_found") {
    return new ApiError(404, code, message);
  }
  static conflict(message = "القيمة موجودة مسبقًا", code = "duplicate") {
    return new ApiError(409, code, message);
  }
  static tooMany(message = "طلبات كثيرة، حاول بعد قليل", code = "rate_limited") {
    return new ApiError(429, code, message);
  }
  static internal(message = "خطأ في الخادم", code = "internal_error") {
    return new ApiError(500, code, message);
  }
}

interface MongoLikeError {
  code?: number;
  name?: string;
  message?: string;
  errors?: Record<string, { message?: string }>;
  keyPattern?: Record<string, unknown>;
}

/**
 * يحوّل أخطاء mongoose إلى ApiError برسالة عربية.
 * أهمّها 11000 (مفتاح فريد مكرّر) وValidationError.
 */
export function fromMongo(error: unknown): ApiError {
  const e = error as MongoLikeError;

  if (e?.code === 11000) {
    const field = Object.keys(e.keyPattern ?? {})[0];
    const labels: Record<string, string> = {
      email: "البريد الإلكتروني مستخدم مسبقًا",
      slug: "هذا المعرّف مستخدم مسبقًا",
      userId: "لديك متجر بالفعل",
    };
    return ApiError.conflict(labels[field ?? ""] ?? "القيمة موجودة مسبقًا");
  }

  if (e?.name === "ValidationError" && e.errors) {
    const first = Object.values(e.errors)[0];
    return ApiError.badRequest(first?.message ?? "بيانات غير صالحة", "validation");
  }

  if (e?.name === "CastError") {
    return ApiError.badRequest("معرّف غير صالح", "invalid_id");
  }

  console.error("[mongo]", error);
  return ApiError.internal();
}
