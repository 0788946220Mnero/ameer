/**
 * قراءة متغيّرات البيئة والتحقق منها عند الإقلاع.
 * الخدمة تتوقّف فورًا إذا نقص متغيّر إلزامي، بدل أن تفشل لاحقًا وسط طلب.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(`[env] المتغيّر الإلزامي ${name} غير معرّف`);
    process.exit(1);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

const jwtSecret = required("JWT_SECRET");
if (jwtSecret.length < 32) {
  console.error("[env] JWT_SECRET قصير جدًا — استخدم 32 حرفًا على الأقل");
  process.exit(1);
}

export const env = {
  nodeEnv: optional("NODE_ENV", "development"),
  port: Number(optional("PORT", "8787")),

  /** رابط اتصال MongoDB Atlas. */
  mongoUri: required("MONGODB_URI"),
  mongoDbName: optional("MONGODB_DB", "jumla"),

  /** سرّ توقيع التوكنات — أي تغيير له يُخرج كل المستخدمين. */
  jwtSecret,
  accessTokenTtl: optional("ACCESS_TOKEN_TTL", "15m"),
  refreshTokenDays: Number(optional("REFRESH_TOKEN_DAYS", "30")),

  /** Cloudinary — رفع الصور وحذفها. */
  cloudinaryCloudName: required("CLOUDINARY_CLOUD_NAME"),
  cloudinaryApiKey: required("CLOUDINARY_API_KEY"),
  cloudinaryApiSecret: required("CLOUDINARY_API_SECRET"),
  cloudinaryFolder: optional("CLOUDINARY_FOLDER", "jumla/listings"),

  /**
   * البريد الصادر — لازم لاستعادة كلمة المرور.
   * أي مزوّد SMTP يعمل: Brevo، Zoho، Resend، Gmail بكلمة مرور تطبيق.
   */
  smtpHost: optional("SMTP_HOST", ""),
  smtpPort: Number(optional("SMTP_PORT", "587")),
  smtpUser: optional("SMTP_USER", ""),
  smtpPass: optional("SMTP_PASS", ""),
  /** المرسل الظاهر للمستخدم. */
  smtpFrom: optional("SMTP_FROM", "جملة ماركت <no-reply@jumla.jo>"),

  /**
   * مدّة صلاحية رمز الاستعادة بالدقائق.
   * المدّة الطويلة مريحة للمستخدم، وحدّ المحاولات أدناه هو ما يحميها.
   */
  otpTtlMinutes: Number(optional("OTP_TTL_MINUTES", "60")),
  /** محاولات خاطئة قبل إبطال الرمز نهائيًا. */
  otpMaxAttempts: Number(optional("OTP_MAX_ATTEMPTS", "5")),
  /** طلبات استعادة مسموحة لكل بريد في الساعة. */
  otpRequestLimit: Number(optional("OTP_REQUEST_LIMIT", "4")),

  /**
   * الإشعارات الفورية عبر Firebase Cloud Messaging — اختيارية بالكامل.
   * إن لم تُضبط الثلاثة، يعمل كل شيء عدا إشعارات الهاتف.
   * القيم من ملف حساب الخدمة: Firebase ← Project settings ← Service accounts.
   */
  firebaseProjectId: optional("FIREBASE_PROJECT_ID", ""),
  firebaseClientEmail: optional("FIREBASE_CLIENT_EMAIL", ""),
  /**
   * المفتاح الخاص. منصّات الاستضافة لا تحفظ أسطرًا جديدة في المتغيّرات،
   * فنقبل \n المكتوبة حرفيًا ونحوّلها إلى أسطر حقيقية.
   */
  firebasePrivateKey: optional("FIREBASE_PRIVATE_KEY", "").replace(/\\n/g, "\n"),

  /** تسجيل الدخول عبر Google — اختياري؛ الزر يُعطَّل إن لم يُضبط. */
  googleClientId: optional("GOOGLE_CLIENT_ID", ""),
  googleClientSecret: optional("GOOGLE_CLIENT_SECRET", ""),

  /**
   * بُرد تُمنح صلاحية المدير تلقائيًا عند كل إقلاع.
   * يغني عن تشغيل أوامر على الخادم لترقية أوّل مدير.
   */
  adminEmails: optional("ADMIN_EMAILS", "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),

  /** التوقيت المحلّي لجدولة الحملات. الأردن: Asia/Amman. */
  timezone: optional("TIMEZONE", "Asia/Amman"),

  corsOrigins: optional("CORS_ORIGINS", "http://localhost:8080")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean),

  contactRateLimit: Number(optional("CONTACT_RATE_LIMIT", "5")),
  contactRateWindowMs: Number(optional("CONTACT_RATE_WINDOW_MS", String(10 * 60 * 1000))),
  /** سقف واسع لكل عنوان IP — الشبكات المشتركة تمرّ منه بلا إزعاج. */
  authRateLimit: Number(optional("AUTH_RATE_LIMIT", "40")),
  /** سقف ضيّق لكل بريد — هذا ما يوقف تخمين كلمة المرور. */
  loginEmailLimit: Number(optional("LOGIN_EMAIL_LIMIT", "6")),
  authRateWindowMs: Number(optional("AUTH_RATE_WINDOW_MS", String(10 * 60 * 1000))),
  adminRateLimit: Number(optional("ADMIN_RATE_LIMIT", "240")),
  adminRateWindowMs: Number(optional("ADMIN_RATE_WINDOW_MS", String(60 * 1000))),
} as const;

export const isProd = env.nodeEnv === "production";
export const googleEnabled = Boolean(env.googleClientId && env.googleClientSecret);
export const mailEnabled = Boolean(env.smtpHost && env.smtpUser && env.smtpPass);
export const pushEnabled = Boolean(
  env.firebaseProjectId && env.firebaseClientEmail && env.firebasePrivateKey,
);
