/** الإشعارات — قائمة، وتعليم كمقروء. */
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { serializeNotification } from "../lib/serialize.js";
import { ApiError } from "../lib/errors.js";
import { pushEnabled } from "../env.js";
import { registerDevice, unregisterDevice } from "../lib/push.js";
import { Notification } from "../models/index.js";

export const notificationsRoute = new Hono();
notificationsRoute.use("*", requireAuth);

notificationsRoute.get("/", async (c) => {
  const rows = await Notification.find({ userId: c.get("user").id })
    .sort({ createdAt: -1 })
    .limit(30)
    .lean();
  const unread = await Notification.countDocuments({ userId: c.get("user").id, readAt: null });
  return c.json({ items: rows.map(serializeNotification), unread });
});

notificationsRoute.post("/read-all", async (c) => {
  await Notification.updateMany(
    { userId: c.get("user").id, readAt: null },
    { $set: { readAt: new Date() } },
  );
  return c.json({ ok: true });
});

notificationsRoute.post("/:id/read", async (c) => {
  // شرط userId يمنع تعليم إشعار شخص آخر كمقروء.
  await Notification.updateOne(
    { _id: c.req.param("id"), userId: c.get("user").id },
    { $set: { readAt: new Date() } },
  );
  return c.json({ ok: true });
});

// ── أجهزة الإشعارات الفورية ────────────────────────────────

const deviceSchema = z.object({
  token: z.string().trim().min(20, "رمز الجهاز غير صالح").max(500),
  platform: z.enum(["android", "ios", "web"]).default("android"),
});

/** هل الإشعارات الفورية مفعّلة على هذا الخادم؟ يسأل التطبيق قبل التسجيل. */
notificationsRoute.get("/push/config", (c) => c.json({ enabled: pushEnabled }));

/** يسجّل رمز الجهاز. يُستدعى عند كل فتح للتطبيق — الرموز تتغيّر أحيانًا. */
notificationsRoute.post("/devices", async (c) => {
  const parsed = deviceSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "بيانات غير صالحة");

  await registerDevice(c.get("user").id, parsed.data.token, parsed.data.platform);
  return c.json({ ok: true, push_enabled: pushEnabled });
});

/** يلغي تسجيل الجهاز — يُستدعى عند تسجيل الخروج. */
notificationsRoute.delete("/devices", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { token?: string };
  if (!body.token) throw ApiError.badRequest("رمز الجهاز مطلوب");

  await unregisterDevice(body.token);
  return c.json({ ok: true });
});
