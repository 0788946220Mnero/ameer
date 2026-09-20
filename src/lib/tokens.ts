/**
 * إصدار التوكنات والتحقق منها.
 *
 * نمط مزدوج: توكن وصول قصير العمر (15 دقيقة) يُحمل في الذاكرة، وتوكن
 * تجديد طويل العمر يُخزَّن ويُدوَّر عند كل استخدام.
 *
 * لماذا التدوير؟ لأن التوكن الطويل هو الهدف الحقيقي لأي سرقة. عند كل
 * تجديد نُبطل القديم ونصدر جديدًا، فإن استُخدم توكن مُبطَل مرة أخرى عرفنا
 * أنه مسروق وأبطلنا كل جلسات المستخدم.
 *
 * ما كانت Supabase تقدّمه جاهزًا صار مسؤوليتنا هنا بالكامل.
 */
import jwt from "jsonwebtoken";
import { createHash, randomBytes } from "node:crypto";
import { env } from "../env.js";
import { RefreshToken } from "../models/index.js";

export interface AccessClaims {
  sub: string;
  email: string;
  roles: string[];
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, env.jwtSecret, {
    expiresIn: env.accessTokenTtl,
    issuer: "jumla",
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    const payload = jwt.verify(token, env.jwtSecret, { issuer: "jumla" });
    if (typeof payload === "string") return null;
    const { sub, email, roles } = payload as jwt.JwtPayload & Partial<AccessClaims>;
    if (!sub || !email) return null;
    return { sub, email, roles: Array.isArray(roles) ? roles : [] };
  } catch {
    return null;
  }
}

/** التوكن نفسه عشوائي بالكامل؛ لا يحمل أي معلومة ولا يُفكّ. */
function newRefreshValue(): string {
  return randomBytes(48).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function issueRefreshToken(userId: string): Promise<string> {
  const value = newRefreshValue();
  const expiresAt = new Date(Date.now() + env.refreshTokenDays * 24 * 60 * 60 * 1000);
  await RefreshToken.create({ userId, tokenHash: hashToken(value), expiresAt });
  return value;
}

export interface RefreshResult {
  userId: string | null;
  /** true عندما يُستخدم توكن مُبطَل مسبقًا — مؤشّر سرقة. */
  reuseDetected: boolean;
}

/**
 * يستهلك توكن تجديد ويصدر بديله.
 * يُبطل القديم في نفس العملية الذرّية، فلا يمكن استخدامه مرتين.
 */
export async function consumeRefreshToken(value: string): Promise<RefreshResult> {
  const tokenHash = hashToken(value);

  const record = await RefreshToken.findOneAndUpdate(
    { tokenHash, revokedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { revokedAt: new Date() } },
    { new: false },
  ).lean();

  if (record) return { userId: String(record.userId), reuseDetected: false };

  // لم نجده صالحًا: إمّا غير موجود أصلًا، أو مُبطَل سابقًا.
  const stale = await RefreshToken.findOne({ tokenHash }).lean();
  if (stale?.revokedAt) {
    // إعادة استخدام توكن مُبطَل: نفترض التسريب ونُنهي كل جلسات المستخدم.
    console.warn("[auth] إعادة استخدام توكن تجديد مُبطَل — إبطال كل جلسات المستخدم");
    await revokeAllForUser(String(stale.userId));
    return { userId: null, reuseDetected: true };
  }

  return { userId: null, reuseDetected: false };
}

export async function revokeRefreshToken(value: string): Promise<void> {
  await RefreshToken.updateOne(
    { tokenHash: hashToken(value), revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await RefreshToken.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}
