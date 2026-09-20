/**
 * المصادقة — ما كانت Supabase تقدّمه جاهزًا.
 *
 * تسجيل، دخول، تجديد، خروج، وGoogle عبر Authorization Code.
 * كلمات المرور بـ bcrypt، والتوكنات كما شُرح في lib/tokens.ts.
 */
import { Hono } from "hono";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { env, googleEnabled } from "../env.js";
import { ApiError, fromMongo } from "../lib/errors.js";
import { serializeUser } from "../lib/serialize.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { requireAuth } from "../middleware/auth.js";
import {
  signAccessToken,
  issueRefreshToken,
  consumeRefreshToken,
  revokeRefreshToken,
  revokeAllForUser,
} from "../lib/tokens.js";
import { unregisterAllDevices } from "../lib/push.js";
import { mailEnabled } from "../env.js";
import { sendPasswordResetCode, sendPasswordChangedNotice } from "../lib/mailer.js";
import { issueResetCode, verifyResetCode, remainingAttempts } from "../lib/passwordReset.js";
import { User } from "../models/index.js";

export const authRoute = new Hono();

const BCRYPT_ROUNDS = 12;

/** يوحّد القيم القديمة والجديدة إلى person/store. */
function toAccountType(raw: string | undefined): "person" | "store" {
  return raw === "store" || raw === "seller" ? "store" : "person";
}

/**
 * حدّ المحاولات على مرحلتين.
 *
 * الربط بعنوان IP وحده يبدو صحيحًا لكنه يؤذي المستخدمين الحقيقيين: مكاتب
 * وشبكات الهواتف في الأردن تشترك في عنوان واحد (CGNAT)، فيقفل موظّف واحد
 * الباب على عشرين زميلًا.
 *
 * الأصحّ: الحدّ الضيّق على البريد — وهو ما يوقف تخمين كلمة المرور فعلًا —
 * مع سقف أوسع على العنوان لإيقاف الإساءة الموزّعة من جهاز واحد.
 */
const authLimit = rateLimit({
  name: "auth-ip",
  limit: env.authRateLimit,
  windowMs: env.authRateWindowMs,
});

const loginEmailLimit = rateLimit({
  name: "auth-email",
  limit: env.loginEmailLimit,
  windowMs: env.authRateWindowMs,
  key: async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: string };
    return (body.email ?? "unknown").trim().toLowerCase();
  },
});

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email("بريد إلكتروني غير صالح"),
  password: z.string().min(8, "كلمة المرور يجب ألّا تقلّ عن 8 أحرف").max(200),
  full_name: z.string().trim().min(2, "الاسم قصير جدًا").max(120),
  phone: z.string().trim().max(40).optional(),
  /** القيم القديمة مقبولة لتوافق العملاء المنشورين، وتُحوَّل عند الحفظ. */
  account_type: z.enum(["person", "store", "buyer", "seller"]).default("person"),
  activity_type: z.string().trim().max(80).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("بريد إلكتروني غير صالح"),
  password: z.string().min(1, "أدخل كلمة المرور").max(200),
});

async function issueSession(user: { _id: unknown; email: string; roles?: string[] }) {
  const userId = String(user._id);
  const roles = Array.isArray(user.roles) ? user.roles : ["user"];
  return {
    access_token: signAccessToken({ sub: userId, email: user.email, roles }),
    refresh_token: await issueRefreshToken(userId),
  };
}

// ── تسجيل حساب جديد ────────────────────────────────────────
authRoute.post("/register", authLimit, async (c) => {
  const parsed = registerSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "بيانات غير صالحة");
  const body = parsed.data;

  const passwordHash = await bcrypt.hash(body.password, BCRYPT_ROUNDS);

  let user;
  try {
    user = await User.create({
      email: body.email,
      passwordHash,
      fullName: body.full_name,
      phone: body.phone ?? null,
      accountType: toAccountType(body.account_type),
      activityType: body.activity_type ?? null,
      roles: ["user"],
    });
  } catch (err) {
    throw fromMongo(err);
  }

  const session = await issueSession(user);
  return c.json({ user: serializeUser(user.toObject()), ...session }, 201);
});

// ── تسجيل الدخول ───────────────────────────────────────────
authRoute.post("/login", loginEmailLimit, authLimit, async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "بيانات غير صالحة");

  const user = await User.findOne({ email: parsed.data.email });

  // رسالة واحدة للحالتين: بريد غير موجود أو كلمة مرور خاطئة.
  // التمييز بينهما يكشف أي البُرد مسجّلة عندنا.
  const invalid = () => ApiError.unauthorized("البريد الإلكتروني أو كلمة المرور غير صحيحة", "invalid_credentials");

  if (!user?.passwordHash) {
    // نُجري مقارنة وهمية حتى يتساوى زمن الردّ ولا يُستدلّ على وجود الحساب.
    await bcrypt.compare(parsed.data.password, "$2a$12$" + "x".repeat(53));
    throw invalid();
  }
  if (!(await bcrypt.compare(parsed.data.password, user.passwordHash))) throw invalid();
  if (user.isBanned) throw ApiError.forbidden("هذا الحساب محظور", "banned");

  const session = await issueSession(user);
  return c.json({ user: serializeUser(user.toObject()), ...session });
});

// ── تجديد الجلسة ───────────────────────────────────────────
authRoute.post("/refresh", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { refresh_token?: string };
  if (!body.refresh_token) throw ApiError.unauthorized("لا يوجد توكن تجديد");

  const { userId, reuseDetected } = await consumeRefreshToken(body.refresh_token);
  if (reuseDetected) {
    throw ApiError.unauthorized("تم اكتشاف استخدام مشبوه، سجّل الدخول من جديد", "token_reuse");
  }
  if (!userId) throw ApiError.unauthorized("انتهت الجلسة، سجّل الدخول من جديد", "session_expired");

  const user = await User.findById(userId);
  if (!user) throw ApiError.unauthorized("الحساب غير موجود", "account_missing");
  if (user.isBanned) throw ApiError.forbidden("هذا الحساب محظور", "banned");

  const session = await issueSession(user);
  return c.json({ user: serializeUser(user.toObject()), ...session });
});

// ── الخروج ─────────────────────────────────────────────────
authRoute.post("/logout", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { refresh_token?: string; all?: boolean };
  if (body.refresh_token) await revokeRefreshToken(body.refresh_token);
  return c.json({ ok: true });
});

authRoute.post("/logout-all", requireAuth, async (c) => {
  const userId = c.get("user").id;
  await revokeAllForUser(userId);
  // وإلا استمرّت إشعارات الهاتف بالوصول بعد الخروج من كل الأجهزة.
  await unregisterAllDevices(userId);
  return c.json({ ok: true });
});

// ── المستخدم الحالي ────────────────────────────────────────
authRoute.get("/me", requireAuth, async (c) => {
  const user = await User.findById(c.get("user").id).lean();
  if (!user) throw ApiError.notFound("الحساب غير موجود");
  return c.json(serializeUser(user));
});

const profileSchema = z.object({
  full_name: z.string().trim().min(2, "الاسم قصير جدًا").max(120).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  account_type: z.enum(["person", "store", "buyer", "seller"]).optional(),
  activity_type: z.string().trim().max(80).nullable().optional(),
  city_id: z.string().nullable().optional(),
});

authRoute.patch("/me", requireAuth, async (c) => {
  const parsed = profileSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "بيانات غير صالحة");
  const p = parsed.data;

  // isBanned و roles غير مذكورين في المخطّط إطلاقًا، فلا سبيل لرفع الحظر
  // عن النفس أو منح الإدارة — وهي الثغرة التي كانت في نسخة PostgreSQL.
  const patch: Record<string, unknown> = {};
  if (p.full_name !== undefined) patch["fullName"] = p.full_name;
  if (p.phone !== undefined) patch["phone"] = p.phone;
  if (p.account_type !== undefined) patch["accountType"] = toAccountType(p.account_type);
  if (p.activity_type !== undefined) patch["activityType"] = p.activity_type;
  if (p.city_id !== undefined) patch["cityId"] = p.city_id;
  if (!Object.keys(patch).length) throw ApiError.badRequest("لا يوجد شيء لتحديثه");

  try {
    const user = await User.findByIdAndUpdate(c.get("user").id, patch, { new: true }).lean();
    if (!user) throw ApiError.notFound("الحساب غير موجود");
    return c.json(serializeUser(user));
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw fromMongo(err);
  }
});

const passwordSchema = z.object({
  current_password: z.string().max(200).optional(),
  new_password: z.string().min(8, "كلمة المرور يجب ألّا تقلّ عن 8 أحرف").max(200),
});

authRoute.post("/change-password", requireAuth, authLimit, async (c) => {
  const parsed = passwordSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "بيانات غير صالحة");

  const user = await User.findById(c.get("user").id);
  if (!user) throw ApiError.notFound("الحساب غير موجود");

  // حساب Google بلا كلمة مرور: يضع واحدة أوّل مرة دون مطالبته بالقديمة.
  if (user.passwordHash) {
    if (!parsed.data.current_password) throw ApiError.badRequest("أدخل كلمة المرور الحالية");
    if (!(await bcrypt.compare(parsed.data.current_password, user.passwordHash))) {
      throw ApiError.unauthorized("كلمة المرور الحالية غير صحيحة", "invalid_credentials");
    }
  }

  user.passwordHash = await bcrypt.hash(parsed.data.new_password, BCRYPT_ROUNDS);
  await user.save();

  // تغيير كلمة المرور يُنهي كل الجلسات الأخرى.
  await revokeAllForUser(String(user._id));
  const session = await issueSession(user);
  return c.json({ ok: true, ...session });
});

// ── Google ─────────────────────────────────────────────────
authRoute.get("/google/config", (c) =>
  c.json({ enabled: googleEnabled, client_id: googleEnabled ? env.googleClientId : null }),
);

const googleSchema = z.object({
  code: z.string().min(10, "رمز غير صالح"),
  redirect_uri: z.string().url("عنوان إعادة توجيه غير صالح"),
});

/**
 * تبادل رمز Google بتوكن ثم إنشاء الجلسة عندنا.
 * التبادل يتم على الخادم لأنه يتطلّب client_secret.
 */
authRoute.post("/google", authLimit, async (c) => {
  if (!googleEnabled) {
    throw ApiError.badRequest("تسجيل الدخول عبر Google غير مفعّل على هذا الخادم", "google_disabled");
  }

  const parsed = googleSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "بيانات غير صالحة");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: parsed.data.code,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      redirect_uri: parsed.data.redirect_uri,
      grant_type: "authorization_code",
    }),
  }).catch(() => null);

  if (!res?.ok) throw ApiError.badRequest("تعذّر التحقق من حساب Google", "google_exchange_failed");

  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) throw ApiError.badRequest("لم يُرجع Google هوية صالحة", "google_no_id_token");

  const payloadPart = tokens.id_token.split(".")[1];
  if (!payloadPart) throw ApiError.badRequest("هوية Google غير صالحة", "google_bad_token");
  const profile = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };

  // التوكن جاء من Google مباشرة عبر HTTPS ردًّا على سرّنا، فلا حاجة للتحقق
  // من توقيعه هنا — لكن نشترط بريدًا مُوثّقًا.
  if (!profile.sub || !profile.email || profile.email_verified === false) {
    throw ApiError.badRequest("حساب Google بلا بريد مُوثّق", "google_unverified");
  }

  const email = profile.email.toLowerCase();
  let user = await User.findOne({ $or: [{ googleId: profile.sub }, { email }] });

  if (user) {
    // ربط حساب موجود بنفس البريد بحساب Google.
    if (!user.googleId) user.googleId = profile.sub;
    if (!user.avatarUrl && profile.picture) user.avatarUrl = profile.picture;
    await user.save();
  } else {
    user = await User.create({
      email,
      googleId: profile.sub,
      fullName: profile.name?.trim() || email.split("@")[0],
      avatarUrl: profile.picture ?? null,
      roles: ["user"],
    });
  }

  if (user.isBanned) throw ApiError.forbidden("هذا الحساب محظور", "banned");

  const session = await issueSession(user);
  return c.json({ user: serializeUser(user.toObject()), ...session });
});

// ── استعادة كلمة المرور برمز OTP ───────────────────────────

const emailSchema = z.object({
  email: z.string().trim().toLowerCase().email("بريد إلكتروني غير صالح"),
});

const codeSchema = emailSchema.extend({
  code: z.string().trim().regex(/^\d{6}$/, "الرمز يتكوّن من ستّة أرقام"),
});

const resetSchema = codeSchema.extend({
  new_password: z.string().min(8, "كلمة المرور يجب ألّا تقلّ عن 8 أحرف").max(200),
});

/** حدّ لكل بريد: يمنع إغراق صندوق بريد شخص آخر برسائل استعادة. */
const otpRequestLimit = rateLimit({
  name: "otp-request",
  limit: env.otpRequestLimit,
  windowMs: 60 * 60 * 1000,
  key: async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: string };
    return (body.email ?? "unknown").trim().toLowerCase();
  },
});

/** حدّ على التحقق أيضًا: يمنع تجربة رموز من عناوين متعدّدة. */
const otpVerifyLimit = rateLimit({
  name: "otp-verify",
  limit: 20,
  windowMs: 60 * 60 * 1000,
  key: async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: string };
    return (body.email ?? "unknown").trim().toLowerCase();
  },
});

authRoute.get("/password-reset/config", (c) =>
  c.json({ enabled: mailEnabled, ttl_minutes: env.otpTtlMinutes, max_attempts: env.otpMaxAttempts }),
);

/** طلب رمز استعادة. */
authRoute.post("/password-reset/request", otpRequestLimit, authLimit, async (c) => {
  const parsed = emailSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "بريد غير صالح");

  if (!mailEnabled) {
    throw new ApiError(503, "mail_disabled", "خدمة البريد غير مفعّلة على الخادم");
  }

  const email = parsed.data.email;
  const user = await User.findOne({ email });

  // ردّ واحد سواء وُجد الحساب أم لا: التمييز يكشف أي البُرد مسجّلة عندنا.
  const ok = {
    ok: true,
    message: "إن كان البريد مسجّلًا لدينا فسيصلك رمز الاستعادة خلال دقائق",
    ttl_minutes: env.otpTtlMinutes,
  };

  if (!user) return c.json(ok);
  if (user.isBanned) return c.json(ok);

  // حساب Google بلا كلمة مرور: نسمح بالاستعادة ليضع واحدة ويدخل بالطريقتين.
  const { code, minutes } = await issueResetCode(String(user._id), email);
  const sent = await sendPasswordResetCode(email, code, minutes);

  // فشل الإرسال يُسجَّل ولا يُبلَّغ به المستخدم: ردّ مختلف هنا يكشف أن
  // البريد مسجّل لدينا، فيتحوّل هذا المسار إلى أداة لحصر حسابات المنصّة.
  if (!sent) {
    console.error("[auth] تعذّر إرسال رمز الاستعادة إلى", email);
  }

  return c.json(ok);
});

/**
 * التحقق من الرمز دون استهلاكه.
 * يسمح للواجهة بالانتقال إلى شاشة كلمة المرور الجديدة بثقة، بدل أن يكتشف
 * المستخدم خطأ الرمز بعد أن كتب كلمة مرور جديدة مرّتين.
 */
authRoute.post("/password-reset/verify", otpVerifyLimit, async (c) => {
  const parsed = codeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "بيانات غير صالحة");

  const result = await verifyResetCode(parsed.data.email, parsed.data.code, false);
  if (result.ok) return c.json({ ok: true });

  const messages = {
    invalid: "الرمز غير صحيح",
    expired: "انتهت صلاحية الرمز، اطلب رمزًا جديدًا",
    locked: "تجاوزت عدد المحاولات، اطلب رمزًا جديدًا",
  } as const;

  const left = result.reason === "invalid" ? await remainingAttempts(parsed.data.email) : 0;
  throw new ApiError(
    400,
    `otp_${result.reason}`,
    result.reason === "invalid" && left > 0
      ? `${messages.invalid} — بقيت ${left} محاولات`
      : messages[result.reason],
  );
});

/** تعيين كلمة المرور الجديدة. يستهلك الرمز. */
authRoute.post("/password-reset/confirm", otpVerifyLimit, async (c) => {
  const parsed = resetSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "بيانات غير صالحة");

  const result = await verifyResetCode(parsed.data.email, parsed.data.code, true);
  if (!result.ok) {
    const messages = {
      invalid: "الرمز غير صحيح",
      expired: "انتهت صلاحية الرمز، اطلب رمزًا جديدًا",
      locked: "تجاوزت عدد المحاولات، اطلب رمزًا جديدًا",
    } as const;
    throw new ApiError(400, `otp_${result.reason}`, messages[result.reason]);
  }

  const user = await User.findById(result.userId);
  if (!user) throw ApiError.notFound("الحساب غير موجود");

  user.passwordHash = await bcrypt.hash(parsed.data.new_password, BCRYPT_ROUNDS);
  await user.save();

  // من يستعيد كلمة المرور قد يكون حسابه مخترقًا: نُنهي كل الجلسات
  // ونُلغي أجهزة الإشعارات حتى لا يبقى للمهاجم أثر.
  await revokeAllForUser(String(user._id));
  await unregisterAllDevices(String(user._id));

  // تنبيه صاحب الحساب — لو لم يكن هو من غيّرها، يعرف فورًا.
  void sendPasswordChangedNotice(user.email);

  const session = await issueSession(user);
  return c.json({ user: serializeUser(user.toObject()), ...session });
});
