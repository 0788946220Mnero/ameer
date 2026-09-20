import { Hono } from "hono";
import { z } from "zod";
import { Types } from "mongoose";
import { ApiError, fromMongo } from "../../lib/errors.js";
import { logAdminAction } from "../../lib/audit.js";
import { countAudience, sendToAudience, runCampaign, type AudienceType } from "../../lib/broadcast.js";
import { computeNextRun, describeSchedule } from "../../lib/schedule.js";
import { Campaign, Setting } from "../../models/index.js";
import { invalidateSettings } from "../../lib/settings.js";
import { env, pushEnabled, mailEnabled } from "../../env.js";

export const campaignsRoute = new Hono();
export const settingsRoute = new Hono();

const audienceSchema = z.object({
  type: z.enum(["all", "buyers", "sellers", "admins", "city"]).default("all"),
  city_id: z.string().nullable().optional(),
});

const scheduleSchema = z.object({
  type: z.enum(["now", "once", "daily", "weekly", "monthly"]).default("now"),
  hour: z.number().int().min(0).max(23).default(10),
  minute: z.number().int().min(0).max(59).default(0),
  weekday: z.number().int().min(0).max(6).default(0),
  /** محدود بـ28 حتى لا تختفي الحملة في فبراير. */
  day_of_month: z.number().int().min(1).max(28).default(1),
  run_at: z.string().datetime().nullable().optional(),
});

const campaignSchema = z.object({
  title: z.string().trim().min(3, "العنوان قصير جدًا").max(120),
  body: z.string().trim().max(500).nullable().optional(),
  link: z.string().trim().max(300).nullable().optional(),
  audience: audienceSchema.default({ type: "all" }),
  schedule: scheduleSchema.default({
    type: "now",
    hour: 10,
    minute: 0,
    weekday: 0,
    day_of_month: 1,
  }),
  active: z.boolean().default(true),
});

type ScheduleBody = z.infer<typeof scheduleSchema>;

function toSchedule(s: ScheduleBody) {
  return {
    type: s.type,
    hour: s.hour,
    minute: s.minute,
    weekday: s.weekday,
    dayOfMonth: s.day_of_month,
    runAt: s.run_at ? new Date(s.run_at) : null,
  };
}

function serializeCampaign(d: Record<string, any>) {
  const sch = d.schedule ?? {};
  return {
    id: String(d._id),
    title: d.title,
    body: d.body ?? null,
    link: d.link ?? null,
    audience: {
      type: d.audience?.type ?? "all",
      city_id: d.audience?.cityId ? String(d.audience.cityId) : null,
    },
    schedule: {
      type: sch.type ?? "now",
      hour: sch.hour ?? 10,
      minute: sch.minute ?? 0,
      weekday: sch.weekday ?? 0,
      day_of_month: sch.dayOfMonth ?? 1,
      run_at: sch.runAt ?? null,
    },
    schedule_label: describeSchedule({
      type: sch.type ?? "now",
      hour: sch.hour ?? 10,
      minute: sch.minute ?? 0,
      weekday: sch.weekday ?? 0,
      dayOfMonth: sch.dayOfMonth ?? 1,
      runAt: sch.runAt ?? null,
    }),
    active: Boolean(d.active),
    next_run_at: d.nextRunAt ?? null,
    last_run_at: d.lastRunAt ?? null,
    stats: {
      runs: d.stats?.runs ?? 0,
      last_recipients: d.stats?.lastRecipients ?? 0,
      total_recipients: d.stats?.totalRecipients ?? 0,
    },
    created_at: d.createdAt,
  };
}

// ── الحملات ────────────────────────────────────────────────

campaignsRoute.get("/", async (c) => {
  const rows = await Campaign.find().sort({ createdAt: -1 }).limit(200).lean();
  return c.json(rows.map(serializeCampaign));
});

/** عدد من ستصلهم الحملة — يُعرض قبل الإرسال. */
campaignsRoute.post("/preview", async (c) => {
  const parsed = audienceSchema.safeParse(
    ((await c.req.json().catch(() => ({}))) as { audience?: unknown }).audience ?? {},
  );
  if (!parsed.success) throw ApiError.badRequest("جمهور غير صالح");

  const count = await countAudience({
    type: parsed.data.type as AudienceType,
    cityId: parsed.data.city_id ?? null,
  });
  return c.json({ recipients: count });
});

campaignsRoute.post("/", async (c) => {
  const parsed = campaignSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "بيانات غير صالحة");
  const b = parsed.data;
  const admin = c.get("user");

  const schedule = toSchedule(b.schedule);
  if (schedule.type === "once" && !schedule.runAt) {
    throw ApiError.badRequest("حدّد موعد الإرسال");
  }

  const cityId =
    b.audience.type === "city" && b.audience.city_id && Types.ObjectId.isValid(b.audience.city_id)
      ? b.audience.city_id
      : null;
  if (b.audience.type === "city" && !cityId) throw ApiError.badRequest("اختر المدينة");

  try {
    const created = await Campaign.create({
      title: b.title,
      body: b.body ?? null,
      link: b.link ?? null,
      audience: { type: b.audience.type, cityId },
      schedule,
      active: b.active,
      nextRunAt: b.active ? computeNextRun(schedule) : null,
      createdBy: admin.id,
    });

    await logAdminAction(admin.id, "create_campaign", "campaign", String(created._id), b.title);

    // "الآن" يُرسل فورًا بدل انتظار دورة المُشغّل.
    if (schedule.type === "now" && b.active) {
      const result = await runCampaign(String(created._id));
      await Campaign.updateOne({ _id: created._id }, { $set: { active: false, nextRunAt: null } });
      const fresh = await Campaign.findById(created._id).lean();
      return c.json({ ...serializeCampaign(fresh!), sent_now: result.recipients }, 201);
    }

    return c.json(serializeCampaign(created.toObject()), 201);
  } catch (err) {
    throw fromMongo(err);
  }
});

campaignsRoute.patch("/:id", async (c) => {
  const id = c.req.param("id");
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest("معرّف غير صالح", "invalid_id");

  const parsed = campaignSchema.partial().safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "بيانات غير صالحة");
  const b = parsed.data;

  const campaign = await Campaign.findById(id);
  if (!campaign) throw ApiError.notFound("الحملة غير موجودة");

  if (b.title !== undefined) campaign.title = b.title;
  if (b.body !== undefined) campaign.body = b.body ?? null;
  if (b.link !== undefined) campaign.link = b.link ?? null;
  if (b.audience !== undefined) {
    campaign.audience = {
      type: b.audience.type,
      cityId:
        b.audience.type === "city" && b.audience.city_id ? (b.audience.city_id as never) : null,
    };
  }
  if (b.schedule !== undefined) campaign.schedule = toSchedule(b.schedule) as never;
  if (b.active !== undefined) campaign.active = b.active;

  // أي تغيير في الجدولة أو التفعيل يعيد حساب الموعد القادم.
  const sch = campaign.schedule;
  campaign.nextRunAt =
    campaign.active && sch
      ? computeNextRun({
          type: (sch.type ?? "now") as never,
          hour: sch.hour ?? 10,
          minute: sch.minute ?? 0,
          weekday: sch.weekday ?? 0,
          dayOfMonth: sch.dayOfMonth ?? 1,
          runAt: sch.runAt ?? null,
        })
      : null;

  try {
    await campaign.save();
  } catch (err) {
    throw fromMongo(err);
  }

  await logAdminAction(c.get("user").id, "update_campaign", "campaign", id, campaign.title);
  return c.json(serializeCampaign(campaign.toObject()));
});

campaignsRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest("معرّف غير صالح", "invalid_id");

  const campaign = await Campaign.findByIdAndDelete(id).lean();
  if (!campaign) throw ApiError.notFound("الحملة غير موجودة");

  await logAdminAction(c.get("user").id, "delete_campaign", "campaign", id, campaign.title);
  return c.json({ ok: true });
});

/** إرسال فوري لحملة محفوظة، دون المساس بجدولتها. */
campaignsRoute.post("/:id/send", async (c) => {
  const id = c.req.param("id");
  if (!Types.ObjectId.isValid(id)) throw ApiError.badRequest("معرّف غير صالح", "invalid_id");

  const campaign = await Campaign.findById(id).lean();
  if (!campaign) throw ApiError.notFound("الحملة غير موجودة");

  const result = await runCampaign(id);
  await logAdminAction(c.get("user").id, "send_campaign", "campaign", id, campaign.title);
  return c.json({ ok: true, recipients: result.recipients });
});

/** إشعار سريع بلا حفظ حملة — للحالات العاجلة. */
const quickSchema = z.object({
  title: z.string().trim().min(3, "العنوان قصير جدًا").max(120),
  body: z.string().trim().max(500).nullable().optional(),
  link: z.string().trim().max(300).nullable().optional(),
  audience: audienceSchema.default({ type: "all" }),
});

campaignsRoute.post("/quick-send", async (c) => {
  const parsed = quickSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "بيانات غير صالحة");
  const b = parsed.data;

  const result = await sendToAudience(
    { type: b.audience.type as AudienceType, cityId: b.audience.city_id ?? null },
    { title: b.title, body: b.body ?? null, link: b.link ?? null },
  );

  await logAdminAction(c.get("user").id, "quick_notification", "campaign", null, b.title);
  return c.json({ ok: true, recipients: result.recipients });
});

// ── إعدادات المنصّة ────────────────────────────────────────

/** الإعدادات القابلة للتحرير من اللوحة، بقيمها الافتراضية. */
const SETTING_DEFAULTS: Record<string, unknown> = {
  site_name: "جملة ماركت",
  site_tagline: "سوق الجملة في الأردن",
  contact_email: "",
  contact_phone: "",
  contact_whatsapp: "",
  /** يوقف نشر إعلانات جديدة دون إغلاق الموقع. */
  listings_paused: false,
  /** رسالة شريط تظهر أعلى الموقع. اتركها فارغة لإخفائها. */
  announcement: "",
  /** مراجعة الإعلانات الجديدة قبل نشرها بدل النشر التلقائي. */
  moderate_new_listings: false,
};

const settingsSchema = z.record(z.unknown());

settingsRoute.get("/", async (c) => {
  const rows = await Setting.find().lean();
  const stored = Object.fromEntries(rows.map((r) => [r.key as string, r.value]));

  return c.json({
    settings: { ...SETTING_DEFAULTS, ...stored },
    /** حالة الخدمات — تُعرض في اللوحة بدل تخمين سبب تعطّل ميزة. */
    services: {
      push_enabled: pushEnabled,
      mail_enabled: mailEnabled,
      timezone: env.timezone,
    },
  });
});

settingsRoute.put("/", async (c) => {
  const parsed = settingsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw ApiError.badRequest("بيانات غير صالحة");

  const admin = c.get("user");
  const entries = Object.entries(parsed.data).filter(([key]) => key in SETTING_DEFAULTS);
  if (!entries.length) throw ApiError.badRequest("لا يوجد إعداد معروف لتحديثه");

  await Promise.all(
    entries.map(([key, value]) =>
      Setting.findOneAndUpdate(
        { key },
        { $set: { value, updatedBy: admin.id } },
        { upsert: true },
      ),
    ),
  );

  // بدون الإبطال يبقى الإعداد القديم فعّالًا حتى ينتهي التخزين المؤقّت،
  // فيظنّ المدير أن الحفظ لم ينجح.
  invalidateSettings();
  await logAdminAction(admin.id, "update_settings", "settings", null, entries.map(([k]) => k).join(", "));

  const rows = await Setting.find().lean();
  const stored = Object.fromEntries(rows.map((r) => [r.key as string, r.value]));
  return c.json({ settings: { ...SETTING_DEFAULTS, ...stored } });
});
