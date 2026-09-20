/**
 * استعادة كلمة المرور برمز OTP.
 *
 * التصميم يوازن بين راحة المستخدم والأمان:
 *
 *   • الرمز ستّة أرقام ومدّته ساعة افتراضيًا — مريح لمن يفتح بريده متأخرًا.
 *   • الحماية ليست في قِصَر المدّة بل في حدّ المحاولات: خمس محاولات خاطئة
 *     تُبطل الرمز نهائيًا. أي أن احتمال التخمين 5 من مليون مهما طالت المدّة.
 *   • الرمز يُخزَّن كبصمة HMAC بسرّ الخادم، فتسريب القاعدة لا يكشفه.
 *   • رمز واحد فعّال لكل حساب: طلب جديد يُبطل السابق.
 */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";
import { PasswordReset } from "../models/index.js";

/** ستّة أرقام مولّدة عشوائيًا تشفيريًا، لا بـ Math.random. */
function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashCode(code: string): string {
  return createHmac("sha256", env.jwtSecret).update(code).digest("hex");
}

/** مقارنة ثابتة الزمن — المقارنة العادية تسرّب الرمز حرفًا حرفًا. */
function matches(code: string, hash: string): boolean {
  const a = Buffer.from(hashCode(code));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface IssuedCode {
  code: string;
  minutes: number;
}

/**
 * ينشئ رمزًا جديدًا ويُبطل أي رمز سابق لنفس الحساب.
 * يعيد الرمز الخام مرة واحدة فقط — لا يمكن استرجاعه بعدها.
 */
export async function issueResetCode(userId: string, email: string): Promise<IssuedCode> {
  // إبطال ما سبق: وجود رمزين فعّالين يضاعف فرص التخمين بلا فائدة للمستخدم.
  await PasswordReset.updateMany(
    { userId, usedAt: null },
    { $set: { usedAt: new Date() } },
  );

  const code = generateCode();
  await PasswordReset.create({
    userId,
    email,
    codeHash: hashCode(code),
    expiresAt: new Date(Date.now() + env.otpTtlMinutes * 60 * 1000),
  });

  return { code, minutes: env.otpTtlMinutes };
}

export type VerifyResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid" | "expired" | "locked" };

/**
 * يتحقق من الرمز.
 * `consume` يحدّد ما إذا كان الرمز يُستهلك: شاشة إدخال الرمز تتحقق دون
 * استهلاك، وشاشة كلمة المرور الجديدة تستهلكه.
 */
export async function verifyResetCode(
  email: string,
  code: string,
  consume: boolean,
): Promise<VerifyResult> {
  const record = await PasswordReset.findOne({ email: email.toLowerCase(), usedAt: null }).sort({
    createdAt: -1,
  });

  if (!record) return { ok: false, reason: "invalid" };

  if (record.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }

  if (record.attempts >= env.otpMaxAttempts) {
    // مُبطَل فعلًا؛ نُعلّمه مستخدمًا حتى لا يُفحص مرة أخرى.
    record.usedAt = new Date();
    await record.save();
    return { ok: false, reason: "locked" };
  }

  if (!matches(code, record.codeHash)) {
    record.attempts += 1;
    // الوصول إلى الحدّ بهذه المحاولة يُبطل الرمز فورًا لا في المرة التالية.
    if (record.attempts >= env.otpMaxAttempts) record.usedAt = new Date();
    await record.save();
    return { ok: false, reason: record.attempts >= env.otpMaxAttempts ? "locked" : "invalid" };
  }

  if (consume) {
    record.usedAt = new Date();
    await record.save();
  }

  return { ok: true, userId: String(record.userId) };
}

/** كم محاولة بقيت — يُعرض للمستخدم حتى لا يُفاجأ بإبطال الرمز. */
export async function remainingAttempts(email: string): Promise<number> {
  const record = await PasswordReset.findOne({ email: email.toLowerCase(), usedAt: null })
    .sort({ createdAt: -1 })
    .lean();
  if (!record) return 0;
  return Math.max(0, env.otpMaxAttempts - record.attempts);
}
