/**
 * الإشعارات الفورية عبر Firebase Cloud Messaging (HTTP v1).
 *
 * لماذا بلا firebase-admin؟ المطلوب هنا شيء واحد: إرسال رسالة إلى رمز جهاز.
 * حزمة الإدارة الكاملة تجرّ اعتماديات كثيرة مقابل ذلك. ما نحتاجه فعلًا هو
 * تبادل JWT موقّع بتوكن وصول، ثم نداء HTTP — وهو ما في هذا الملف.
 *
 * الميزة اختيارية بالكامل: إن لم تُضبط متغيّرات Firebase، تُتجاهل الدوال
 * بصمت ويبقى كل شيء آخر يعمل، بما فيه الإشعارات داخل التطبيق عبر SSE.
 */
import jwt from "jsonwebtoken";
import { env, pushEnabled } from "../env.js";
import { DeviceToken } from "../models/index.js";

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

interface CachedToken {
  value: string;
  expiresAt: number;
}

let cached: CachedToken | null = null;

/**
 * توكن وصول صالح لساعة. نخزّنه مؤقّتًا: بدون ذلك نوقّع JWT ونناد Google
 * قبل كل إشعار، فتتضاعف زمن الإرسال بلا داعٍ.
 */
async function getAccessToken(): Promise<string | null> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;

  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: env.firebaseClientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    },
    env.firebasePrivateKey,
    { algorithm: "RS256" },
  );

  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });

    if (!res.ok) {
      console.error("[push] تعذّر الحصول على توكن FCM:", res.status, await res.text());
      return null;
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    cached = {
      value: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return cached.value;
  } catch (err) {
    console.error("[push] فشل الاتصال بخادم توكنات Google:", err);
    return null;
  }
}

export interface PushPayload {
  title: string;
  body?: string | null;
  /** مسار داخل التطبيق يُفتح عند الضغط على الإشعار، مثل /chats/123. */
  link?: string | null;
}

/** يسجّل رمز جهاز لمستخدم. آمن للتكرار. */
export async function registerDevice(
  userId: string,
  token: string,
  platform: "android" | "ios" | "web",
): Promise<void> {
  // الرمز فريد عالميًا: لو سجّل مستخدم آخر دخوله على نفس الجهاز،
  // تنتقل ملكية الرمز إليه بدل أن تصل إشعارات الأول إلى الثاني.
  await DeviceToken.findOneAndUpdate(
    { token },
    { $set: { userId, platform, lastSeenAt: new Date() } },
    { upsert: true },
  );
}

export async function unregisterDevice(token: string): Promise<void> {
  await DeviceToken.deleteOne({ token });
}

/** يحذف كل أجهزة المستخدم — يُستدعى عند الخروج من كل الجلسات. */
export async function unregisterAllDevices(userId: string): Promise<void> {
  await DeviceToken.deleteMany({ userId });
}

async function sendToToken(
  accessToken: string,
  token: string,
  payload: PushPayload,
): Promise<"ok" | "stale" | "error"> {
  const message = {
    message: {
      token,
      notification: {
        title: payload.title,
        ...(payload.body ? { body: payload.body } : {}),
      },
      // البيانات تصل التطبيق حتى لو كان مغلقًا، ويستخدمها لفتح الشاشة الصحيحة.
      data: {
        link: payload.link ?? "/",
      },
      android: {
        priority: "HIGH" as const,
        notification: {
          sound: "default",
          // يوحّد الإشعارات المتتالية من نفس المحادثة في إشعار واحد.
          tag: payload.link ?? "general",
          color: "#087F5B",
        },
      },
    },
  };

  try {
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${env.firebaseProjectId}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      },
    );

    if (res.ok) return "ok";

    // 404 أو UNREGISTERED: التطبيق أُزيل أو الرمز انتهى.
    // نحذفه حتى لا تتراكم رموز ميتة تبطئ كل إرسال لاحق.
    if (res.status === 404 || res.status === 400) {
      const text = await res.text();
      if (/UNREGISTERED|INVALID_ARGUMENT|NOT_FOUND/i.test(text)) return "stale";
      console.error("[push] رفض FCM:", res.status, text.slice(0, 200));
      return "error";
    }

    console.error("[push] فشل الإرسال:", res.status);
    return "error";
  } catch (err) {
    console.error("[push] خطأ شبكة أثناء الإرسال:", err);
    return "error";
  }
}

/**
 * يرسل إشعارًا إلى كل أجهزة مستخدم.
 *
 * لا يرمي استثناء أبدًا ولا يُنتظر: فشل الإشعار يجب ألّا يُسقط إرسال رسالة
 * أو تغيير حالة إعلان. الإشعار داخل التطبيق (SSE) يصل في كل الأحوال.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!pushEnabled) return;

  try {
    const devices = await DeviceToken.find({ userId }).select("token").lean();
    if (!devices.length) return;

    const accessToken = await getAccessToken();
    if (!accessToken) return;

    const results = await Promise.all(
      devices.map(async (d) => ({
        token: d.token as string,
        result: await sendToToken(accessToken, d.token as string, payload),
      })),
    );

    const stale = results.filter((r) => r.result === "stale").map((r) => r.token);
    if (stale.length) {
      await DeviceToken.deleteMany({ token: { $in: stale } });
      console.log(`[push] حُذف ${stale.length} رمز جهاز منتهٍ`);
    }
  } catch (err) {
    console.error("[push] خطأ غير متوقّع:", err);
  }
}
