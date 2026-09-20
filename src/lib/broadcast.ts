/**
 * إرسال حملات الإشعارات.
 *
 * الإشعار يصل بطريقتين معًا: سجلّ داخل التطبيق (يظهر في جرس الإشعارات)،
 * وإشعار نظام على الهاتف عبر FCM إن كان مضبوطًا.
 *
 * الإرسال يتم على دفعات لا دفعة واحدة: حملة على عشرة آلاف مستخدم تعني
 * عشرة آلاف مستند، وإدراجها معًا يستهلك ذاكرة الخدمة ويخنق القاعدة.
 */
import { Campaign, Notification, User } from "../models/index.js";
import { sendPushToUser } from "./push.js";

const INSERT_BATCH = 500;
/** إشعارات الهاتف المرسلة بالتوازي في وقت واحد. */
const PUSH_CONCURRENCY = 20;

export type AudienceType = "all" | "buyers" | "sellers" | "admins" | "city";

export interface Audience {
  type: AudienceType;
  cityId?: string | null;
}

/** يبني مرشّح المستخدمين. المحظورون مستثنون دائمًا. */
export function audienceFilter(audience: Audience): Record<string, unknown> {
  const base: Record<string, unknown> = { isBanned: { $ne: true } };

  switch (audience.type) {
    case "buyers":
      // الحسابات القديمة سُجّلت بـ buyer؛ نشملها حتى لا يسقط نصف الجمهور.
      return { ...base, accountType: { $in: ["person", "buyer"] } };
    case "sellers":
      return { ...base, accountType: { $in: ["store", "seller"] } };
    case "admins":
      return { ...base, roles: "admin" };
    case "city":
      return audience.cityId ? { ...base, cityId: audience.cityId } : base;
    default:
      return base;
  }
}

export async function countAudience(audience: Audience): Promise<number> {
  return User.countDocuments(audienceFilter(audience));
}

export interface CampaignContent {
  title: string;
  body?: string | null;
  link?: string | null;
}

export interface SendResult {
  recipients: number;
}

/**
 * يرسل محتوى إلى جمهور.
 * يعيد عدد من وصلهم فعلًا.
 */
export async function sendToAudience(
  audience: Audience,
  content: CampaignContent,
): Promise<SendResult> {
  const filter = audienceFilter(audience);
  const cursor = User.find(filter).select("_id").lean().cursor();

  let batch: string[] = [];
  let total = 0;

  const flush = async () => {
    if (!batch.length) return;
    const ids = batch;
    batch = [];

    await Notification.insertMany(
      ids.map((userId) => ({
        userId,
        type: "campaign",
        title: content.title,
        body: content.body ?? null,
        link: content.link ?? null,
      })),
      { ordered: false },
    );

    // إشعارات الهاتف على دفعات متوازية محدودة: بلا حدّ نفتح آلاف الطلبات
    // نحو FCM في وقت واحد فيخنق الخدمة.
    for (let i = 0; i < ids.length; i += PUSH_CONCURRENCY) {
      await Promise.all(
        ids.slice(i, i + PUSH_CONCURRENCY).map((userId) =>
          sendPushToUser(userId, {
            title: content.title,
            body: content.body ?? null,
            link: content.link ?? null,
          }),
        ),
      );
    }

    total += ids.length;
  };

  for await (const user of cursor) {
    batch.push(String(user._id));
    if (batch.length >= INSERT_BATCH) await flush();
  }
  await flush();

  return { recipients: total };
}

/** يشغّل حملة محفوظة ويحدّث إحصاءاتها. */
export async function runCampaign(campaignId: string): Promise<SendResult> {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new Error("الحملة غير موجودة");

  // المخطّط يضمن وجود الحقلين، لكن مستندًا قديمًا قد يسبق إضافتهما.
  const audience = campaign.audience ?? { type: "all", cityId: null };

  const result = await sendToAudience(
    {
      type: (audience.type ?? "all") as AudienceType,
      cityId: audience.cityId ? String(audience.cityId) : null,
    },
    { title: campaign.title, body: campaign.body ?? null, link: campaign.link ?? null },
  );

  const stats = campaign.stats ?? { runs: 0, lastRecipients: 0, totalRecipients: 0 };
  campaign.lastRunAt = new Date();
  campaign.stats = {
    runs: (stats.runs ?? 0) + 1,
    lastRecipients: result.recipients,
    totalRecipients: (stats.totalRecipients ?? 0) + result.recipients,
  };
  await campaign.save();

  return result;
}
