/**
 * المحادثات — بديل قنوات Supabase Realtime.
 *
 * البثّ عبر SSE: اتصال HTTP واحد طويل الأمد، يعمل عبر أي وكيل أو جدار
 * ناري دون إعداد خاص (خلاف WebSocket)، ويعيد المتصفّح وصله تلقائيًا.
 *
 * مصدران للأحداث في نفس البثّ:
 *   1. ناقل داخل الخادم — يصل فورًا في الحالة الشائعة.
 *   2. استقصاء كل 10 ثوانٍ — شبكة أمان تضمن العمل حتى لو كانت الرسالة
 *      قد كُتبت على نسخة أخرى من الخدمة على Railway.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { Types } from "mongoose";
import { ApiError, fromMongo } from "../lib/errors.js";
import { serializeConversation, serializeMessage } from "../lib/serialize.js";
import { requireAuth } from "../middleware/auth.js";
import { verifyAccessToken } from "../lib/tokens.js";
import { bus, type MessageEvent } from "../lib/events.js";
import { sendPushToUser } from "../lib/push.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { Conversation, Message, Listing, Notification, User } from "../models/index.js";

export const chatsRoute = new Hono();

function objectId(raw: string | undefined): Types.ObjectId {
  if (!raw || !Types.ObjectId.isValid(raw)) throw ApiError.badRequest("معرّف غير صالح", "invalid_id");
  return new Types.ObjectId(raw);
}

/** يتحقق أن المستخدم طرف في المحادثة — بديل سياسة RLS القديمة. */
async function loadMembership(conversationId: Types.ObjectId, userId: string) {
  const conv = await Conversation.findById(conversationId).lean();
  if (!conv) throw ApiError.notFound("المحادثة غير موجودة");
  const isMember = String(conv.buyerId) === userId || String(conv.sellerUserId) === userId;
  if (!isMember) throw ApiError.forbidden("لست طرفًا في هذه المحادثة");
  const otherId = String(conv.buyerId) === userId ? String(conv.sellerUserId) : String(conv.buyerId);
  return { conv, otherId };
}

// ── قائمة المحادثات ────────────────────────────────────────
chatsRoute.get("/", requireAuth, async (c) => {
  const userId = c.get("user").id;
  const convs = await Conversation.find({ $or: [{ buyerId: userId }, { sellerUserId: userId }] })
    .sort({ lastMessageAt: -1 })
    .limit(100)
    .populate({ path: "listingId", populate: [{ path: "categoryId" }, { path: "cityId" }] } as never)
    .lean();

  // عدّ غير المقروء لكل محادثة. القائمة محدودة بـ100 والفهرس
  // (conversationId, createdAt) يخدم العدّ، فالتكلفة مقبولة — وهذا يتفادى
  // خطّ تجميع لا تدعمه كل نسخ MongoDB المتوافقة.
  const unreadPairs = await Promise.all(
    convs.map(async (conv) => [
      String(conv._id),
      await Message.countDocuments({ conversationId: conv._id, readAt: null, senderId: { $ne: userId } }),
    ] as const),
  );
  const unreadMap = new Map(unreadPairs);

  return c.json(
    convs.map((conv) => ({
      ...serializeConversation(conv, userId),
      unread_count: unreadMap.get(String(conv._id)) ?? 0,
      last_message: conv.lastMessageBody ?? null,
    })),
  );
});

chatsRoute.get("/unread-count", requireAuth, async (c) => {
  const userId = c.get("user").id;
  const convs = await Conversation.find({ $or: [{ buyerId: userId }, { sellerUserId: userId }] })
    .select("_id")
    .lean();
  const count = await Message.countDocuments({
    conversationId: { $in: convs.map((x) => x._id) },
    readAt: null,
    senderId: { $ne: userId },
  });
  return c.json({ count });
});

// ── فتح محادثة على إعلان ───────────────────────────────────
chatsRoute.post("/open", requireAuth, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { listing_id?: string };
  const listingId = objectId(body.listing_id);
  const userId = c.get("user").id;

  const listing = await Listing.findById(listingId).select("userId status").lean();
  if (!listing || listing.status !== "active") throw ApiError.notFound("الإعلان غير متاح");
  if (String(listing.userId) === userId) {
    throw ApiError.badRequest("لا يمكنك مراسلة نفسك على إعلانك", "self_chat");
  }

  try {
    // الفهرس الفريد (listingId, buyerId) يضمن محادثة واحدة مهما تكرّر الضغط.
    const conv = await Conversation.findOneAndUpdate(
      { listingId, buyerId: userId },
      { $setOnInsert: { listingId, buyerId: userId, sellerUserId: listing.userId, lastMessageAt: new Date() } },
      { new: true, upsert: true },
    ).lean();
    return c.json({ id: String(conv._id) }, 201);
  } catch (err) {
    throw fromMongo(err);
  }
});

// ── رسائل محادثة ───────────────────────────────────────────
chatsRoute.get("/:id/messages", requireAuth, async (c) => {
  const convId = objectId(c.req.param("id"));
  const userId = c.get("user").id;
  const { conv } = await loadMembership(convId, userId);

  const messages = await Message.find({ conversationId: convId }).sort({ createdAt: 1 }).limit(500).lean();

  // تعليم رسائل الطرف الآخر كمقروءة عند فتح المحادثة.
  void Message.updateMany(
    { conversationId: convId, senderId: { $ne: userId }, readAt: null },
    { $set: { readAt: new Date() } },
  ).catch(() => undefined);

  const full = await Conversation.findById(convId)
    .populate({ path: "listingId", populate: [{ path: "categoryId" }, { path: "cityId" }, { path: "sellerId" }] } as never)
    .lean();

  return c.json({
    conversation: serializeConversation(full ?? conv, userId),
    messages: messages.map(serializeMessage),
  });
});

const sendSchema = z.object({ body: z.string().trim().min(1, "الرسالة فارغة").max(4000, "الرسالة طويلة جدًا") });

chatsRoute.post(
  "/:id/messages",
  requireAuth,
  // سقف الإرسال: 30 رسالة في الدقيقة — يمنع الإغراق دون إزعاج محادثة طبيعية.
  rateLimit({ name: "chat-send", limit: 30, windowMs: 60 * 1000, key: (c) => c.get("user").id }),
  async (c) => {
    const convId = objectId(c.req.param("id"));
    const userId = c.get("user").id;
    const { otherId } = await loadMembership(convId, userId);

    const parsed = sendSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? "رسالة غير صالحة");

    const msg = await Message.create({ conversationId: convId, senderId: userId, body: parsed.data.body });
    await Conversation.updateOne(
      { _id: convId },
      {
        $set: {
          lastMessageAt: new Date(),
          lastMessageBody: parsed.data.body.slice(0, 200),
          lastMessageSenderId: userId,
        },
      },
    );

    const sender = await User.findById(userId).select("fullName").lean();
    const notif = await Notification.create({
      userId: otherId,
      type: "message",
      title: `رسالة جديدة من ${sender?.fullName ?? "مستخدم"}`,
      body: parsed.data.body.slice(0, 120),
      link: `/chats/${String(convId)}`,
    });

    const event: MessageEvent = {
      conversationId: String(convId),
      messageId: String(msg._id),
      senderId: userId,
      recipientId: otherId,
      body: msg.body,
      createdAt: new Date().toISOString(),
    };
    bus.emitMessage(event);
    bus.emitNotification({
      userId: otherId,
      notificationId: String(notif._id),
      title: notif.title,
      body: notif.body ?? null,
      link: notif.link ?? null,
      createdAt: new Date().toISOString(),
    });

    // إشعار الهاتف: لا يُنتظر حتى لا يتأخّر ردّ الإرسال على المستخدم.
    void sendPushToUser(otherId, {
      title: notif.title,
      body: notif.body ?? null,
      link: notif.link ?? null,
    });

    return c.json(serializeMessage(msg.toObject()), 201);
  },
);

// ── البثّ الفوري ───────────────────────────────────────────
/**
 * EventSource في المتصفّح لا يسمح بترويسات مخصّصة، فلا يمكن إرسال
 * Authorization. لذلك يُمرَّر التوكن في سلسلة الاستعلام هنا — وهو استثناء
 * مقصود ومحدود: توكن الوصول يعيش 15 دقيقة فقط، والاتصال عبر HTTPS.
 */
chatsRoute.get("/stream", (c) => {
  const token = c.req.query("token");
  const claims = token ? verifyAccessToken(token) : null;
  if (!claims) throw ApiError.unauthorized("توكن غير صالح للبثّ");
  const userId = claims.sub;

  return streamSSE(c, async (stream) => {
    let closed = false;
    stream.onAbort(() => {
      closed = true;
      bus.off(`user:${userId}:message`, onMessage);
      bus.off(`user:${userId}:notification`, onNotification);
    });

    const send = (event: string, data: unknown) =>
      stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => undefined);

    const onMessage = (e: MessageEvent) => void send("message", e);
    const onNotification = (e: unknown) => void send("notification", e);
    bus.on(`user:${userId}:message`, onMessage);
    bus.on(`user:${userId}:notification`, onNotification);

    await send("ready", { ok: true });

    // شبكة الأمان: استقصاء دوري يلتقط ما كُتب على نسخة أخرى من الخدمة،
    // ونبضة تمنع الوكلاء من إغلاق الاتصال الخامل.
    let since = new Date();
    while (!closed) {
      await stream.sleep(10_000);
      if (closed) break;

      try {
        const convs = await Conversation.find({ $or: [{ buyerId: userId }, { sellerUserId: userId }] })
          .select("_id")
          .lean();
        const fresh = await Message.find({
          conversationId: { $in: convs.map((x) => x._id) },
          senderId: { $ne: userId },
          createdAt: { $gt: since },
        })
          .sort({ createdAt: 1 })
          .limit(50)
          .lean();

        if (fresh.length) {
          since = new Date();
          for (const m of fresh) {
            await send("message", {
              conversationId: String(m.conversationId),
              messageId: String(m._id),
              senderId: String(m.senderId),
              recipientId: userId,
              body: m.body,
              createdAt: (m as { createdAt?: Date }).createdAt?.toISOString() ?? new Date().toISOString(),
            });
          }
        } else {
          await send("ping", { t: Date.now() });
        }
      } catch (err) {
        console.error("[sse] فشل الاستقصاء الاحتياطي", err);
      }
    }
  });
});
