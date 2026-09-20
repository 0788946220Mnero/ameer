import type { MiddlewareHandler } from "hono";
import { ApiError } from "../lib/errors.js";
import { verifyAccessToken } from "../lib/tokens.js";
import { User } from "../models/index.js";

export interface AuthUser {
  id: string;
  email: string;
  roles: string[];
  isAdmin: boolean;
}

declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser;
    maybeUser: AuthUser | null;
  }
}

function readBearer(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token && token.split(".").length === 3 ? token : null;
}

/**
 * يقرأ الهوية من التوكن إن وُجد، دون أن يشترطها.
 * يُستخدم في المسارات العامة التي تتغيّر نتيجتها حسب تسجيل الدخول
 * (مثل إظهار هاتف البائع).
 */
export const optionalAuth: MiddlewareHandler = async (c, next) => {
  const token = readBearer(c.req.header("authorization"));
  const claims = token ? verifyAccessToken(token) : null;
  c.set(
    "maybeUser",
    claims
      ? {
          id: claims.sub,
          email: claims.email,
          roles: claims.roles,
          isAdmin: claims.roles.includes("admin"),
        }
      : null,
  );
  await next();
};

/**
 * يشترط توكن وصول صالحًا.
 *
 * التحقق من التوقيع محلي (لا نداء شبكة)، لكننا نقرأ المستخدم من القاعدة
 * أيضًا: التوكن يعيش 15 دقيقة، ولو حُظر مستخدم خلالها فيجب أن يُمنع فورًا
 * لا بعد انتهاء توكنه.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const token = readBearer(c.req.header("authorization"));
  if (!token) throw ApiError.unauthorized("لا يوجد توكن مصادقة");

  const claims = verifyAccessToken(token);
  if (!claims) {
    throw ApiError.unauthorized("انتهت الجلسة، سجّل الدخول من جديد", "session_expired");
  }

  let user;
  try {
    user = await User.findById(claims.sub).select("email roles isBanned").lean();
  } catch (err) {
    console.error("[auth] تعذّر الوصول إلى قاعدة البيانات", err);
    throw new ApiError(503, "db_unavailable", "تعذّر الوصول إلى قاعدة البيانات، حاول بعد قليل");
  }

  if (!user) throw ApiError.unauthorized("الحساب غير موجود", "account_missing");
  if (user.isBanned) throw ApiError.forbidden("هذا الحساب محظور", "banned");

  const roles = Array.isArray(user.roles) ? user.roles : [];
  c.set("user", {
    id: String(user._id),
    email: user.email,
    roles,
    isAdmin: roles.includes("admin"),
  });
  await next();
};

/** يشترط صلاحية المدير. يُستدعى دائمًا بعد requireAuth. */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  if (!c.get("user").isAdmin) throw ApiError.forbidden("هذه الصفحة للمديرين فقط");
  await next();
};
