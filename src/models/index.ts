/**
 * نماذج MongoDB.
 *
 * ملاحظة على النمذجة: صور الإعلان وشرائح السعر مضمّنة داخل مستند الإعلان
 * لا في مجموعات منفصلة — لأنها تُقرأ دائمًا مع الإعلان ولا يُستعلم عنها
 * وحدها. هذا يلغي ثلاث عمليات join كانت في نسخة PostgreSQL.
 *
 * في المقابل تبقى الرسائل والمحادثات والمفضّلة مجموعات مستقلة، لأنها تنمو
 * بلا حدّ ولها دورة حياة خاصة.
 *
 * تحذير: لا يوجد في MongoDB ما يقابل RLS. كل الحماية التي كانت في سياسات
 * PostgreSQL انتقلت إلى طبقة الوسيط والمسارات في هذا الخادم.
 */
import { Schema, model, type InferSchemaType, type Model } from "mongoose";

const opts = { timestamps: true, versionKey: false } as const;

// ── المستخدمون ─────────────────────────────────────────────
const userSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    /** فارغ لحسابات Google التي لم تضع كلمة مرور بعد. */
    passwordHash: { type: String, default: null },
    googleId: { type: String, default: null },
    fullName: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, default: null, trim: true, maxlength: 40 },
    /**
     * نوع الحساب. القيمتان القديمتان (buyer/seller) مقبولتان للتوافق مع
     * الحسابات المسجّلة قبل هذا التقسيم؛ التسلسل يحوّلهما إلى person/store.
     */
    accountType: {
      type: String,
      enum: ["person", "store", "buyer", "seller"],
      default: "person",
    },
    activityType: { type: String, default: null },
    cityId: { type: Schema.Types.ObjectId, ref: "City", default: null },
    avatarUrl: { type: String, default: null },
    isBanned: { type: Boolean, default: false },
    roles: { type: [String], default: ["user"] },

    /**
     * التوثيق — مصدر حقيقة واحد للأشخاص والمتاجر معًا.
     * كان على المتجر وحده، فلم يكن للأفراد سبيل للتوثيق، وكان يعني شارتين
     * منفصلتين لو أضفنا توثيقًا ثانيًا.
     */
    verification: {
      status: {
        type: String,
        enum: ["none", "pending", "approved", "rejected"],
        default: "none",
      },
      /** صورة الوثيقة على Cloudinary — لا تخرج إلا للمديرين. */
      documentUrl: { type: String, default: null },
      documentPublicId: { type: String, default: null },
      /** ملاحظة مقدّم الطلب. */
      note: { type: String, default: null, maxlength: 500 },
      /** سبب الرفض كما يكتبه المدير. */
      reviewNote: { type: String, default: null, maxlength: 500 },
      submittedAt: { type: Date, default: null },
      reviewedAt: { type: Date, default: null },
      reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    },
  },
  opts,
);
userSchema.index({ googleId: 1 }, { sparse: true });
userSchema.index({ roles: 1 });
// لوحة التحكم تعرض طلبات التوثيق المعلّقة.
userSchema.index({ "verification.status": 1, "verification.submittedAt": -1 });
userSchema.index({ createdAt: -1 });

// ── التصنيفات والمدن ───────────────────────────────────────
const categorySchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, trim: true },
    nameAr: { type: String, required: true, trim: true, maxlength: 80 },
    imageUrl: { type: String, default: null },
    sortOrder: { type: Number, default: 0 },
  },
  opts,
);
categorySchema.index({ sortOrder: 1 });

const citySchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, trim: true },
    nameAr: { type: String, required: true, trim: true, maxlength: 80 },
    sortOrder: { type: Number, default: 0 },
  },
  opts,
);
citySchema.index({ sortOrder: 1 });

// ── البائعون ───────────────────────────────────────────────
const sellerSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    slug: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    activityType: { type: String, default: null },
    cityId: { type: Schema.Types.ObjectId, ref: "City", default: null },
    bio: { type: String, default: null, maxlength: 2000 },
    /** العنوان النصّي كما يكتبه البائع: الشارع، المنطقة، معالم قريبة. */
    address: { type: String, default: null, maxlength: 300 },
    /**
     * الإحداثيات كأرقام مستقلّة لا GeoJSON.
     * السبب: البحث هنا يتم بمربّع إحداثيات ثم تنقية بالمسافة الحقيقية،
     * وهو يعمل على أي خادم متوافق مع MongoDB. لو احتجت لاحقًا أداء أعلى
     * على ملايين الإعلانات، التحويل إلى 2dsphere تغيير محدود في الاستعلام.
     */
    lat: { type: Number, default: null, min: -90, max: 90 },
    lng: { type: Number, default: null, min: -180, max: 180 },
    logoUrl: { type: String, default: null },
    logoPublicId: { type: String, default: null },
    /** بيانات التواصل تُحجب عن غير المسجّلين في طبقة المسار، لا هنا. */
    phone: { type: String, default: null, trim: true, maxlength: 40 },
    whatsapp: { type: String, default: null, trim: true, maxlength: 40 },
    isVerified: { type: Boolean, default: false },
  },
  opts,
);

// ── الإعلانات ──────────────────────────────────────────────
const listingImageSchema = new Schema(
  {
    url: { type: String, required: true },
    /** معرّف Cloudinary — لازم لحذف الصورة فعليًا عند حذف الإعلان. */
    publicId: { type: String, required: true },
    sortOrder: { type: Number, default: 0 },
  },
  { _id: false },
);

const priceTierSchema = new Schema(
  {
    minQty: { type: Number, required: true, min: 1 },
    maxQty: { type: Number, default: null },
    price: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const listingSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    /**
     * نوع الإعلان:
     *   offer  — معروض: تاجر يعرض بضاعة للبيع.
     *   wanted — مطلوب: مشترٍ يطلب بضاعة ويستقبل عروض التجار.
     */
    kind: { type: String, enum: ["offer", "wanted"], default: "offer" },
    /**
     * المتجر. مطلوب للمعروض فقط: طلب الشراء يكتبه فرد قد لا يملك متجرًا،
     * واشتراط المتجر كان سيمنع نصف المستخدمين من استخدام القسم الجديد.
     */
    sellerId: { type: Schema.Types.ObjectId, ref: "Seller", default: null },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", required: true },
    cityId: { type: Schema.Types.ObjectId, ref: "City", required: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    /** للمعروض: سعر الوحدة. للمطلوب: الميزانية التقريبية وقد تكون فارغة. */
    price: { type: Number, default: null, min: 0 },
    unit: { type: String, required: true, trim: true, maxlength: 40 },
    /** المنصّة للجملة: أقل كمية للطلب لا تقلّ عن 2. */
    minOrder: { type: Number, required: true, min: 2 },
    availableQty: { type: Number, default: null, min: 0 },
    area: { type: String, default: null, trim: true, maxlength: 120 },
    /**
     * نسخة من إحداثيات البائع.
     * البحث بالقرب يستعلم عن الإعلانات مباشرة؛ بدون هذه النسخة نحتاج
     * جلب كل البائعين القريبين أولًا ثم تصفية الإعلانات بهم — استعلامان
     * بدل واحد، ويسوء مع نموّ عدد المتاجر. تُحدَّث عند تغيير موقع المتجر.
     */
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    phone: { type: String, default: null, trim: true, maxlength: 40 },
    hasWhatsapp: { type: Boolean, default: false },
    hasDelivery: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["pending", "active", "rejected", "paused"],
      default: "active",
    },
    isFeatured: { type: Boolean, default: false },
    views: { type: Number, default: 0 },
    phoneClicks: { type: Number, default: 0 },
    chatsCount: { type: Number, default: 0 },
    images: { type: [listingImageSchema], default: [] },
    priceTiers: { type: [priceTierSchema], default: [] },

    /** للمطلوب: متى ينتهي الطلب. بعده يُعتبر منتهيًا ولا يظهر في التصفّح. */
    neededBy: { type: Date, default: null },

    /**
     * ملخّص التعليقات والتقييم، محفوظ مع الإعلان.
     * حسابه بالتجميع عند كل عرض يقرأ مجموعة التعليقات كاملة لعرض نجمة واحدة.
     */
    ratingAvg: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
  },
  opts,
);
// فهارس مركّبة تخدم شاشة التصفّح: الحالة أولًا لأنها في كل استعلام عام.
// النوع في مقدّمة كل فهرس: كل استعلام عام يحدّد معروضًا أو مطلوبًا.
listingSchema.index({ kind: 1, status: 1, createdAt: -1 });
listingSchema.index({ kind: 1, status: 1, categoryId: 1, createdAt: -1 });
listingSchema.index({ status: 1, createdAt: -1 });
listingSchema.index({ status: 1, categoryId: 1, createdAt: -1 });
listingSchema.index({ status: 1, cityId: 1, createdAt: -1 });
listingSchema.index({ status: 1, isFeatured: -1, createdAt: -1 });
listingSchema.index({ userId: 1, createdAt: -1 });
listingSchema.index({ sellerId: 1, status: 1 });
// يخدم البحث بالقرب: الحالة أولًا لأنها في كل استعلام عام.
listingSchema.index({ status: 1, lat: 1, lng: 1 });
listingSchema.index({ title: "text", description: "text" });

// ── المحادثات والرسائل ─────────────────────────────────────
const conversationSchema = new Schema(
  {
    listingId: { type: Schema.Types.ObjectId, ref: "Listing", required: true },
    buyerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    sellerUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    lastMessageAt: { type: Date, default: Date.now },
    /**
     * نصّ آخر رسالة مخزّن مع المحادثة نفسها.
     * البديل — تجميع بـ $first على كل الرسائل عند كل فتح لقائمة المحادثات —
     * يقرأ مجموعة تنمو بلا حدّ ليعرض سطرًا واحدًا. التخزين هنا يجعل قائمة
     * المحادثات استعلامًا واحدًا مهما بلغ عدد الرسائل.
     */
    lastMessageBody: { type: String, default: null, maxlength: 200 },
    lastMessageSenderId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  opts,
);
// محادثة واحدة لكل (إعلان، مشترٍ) — يمنع تكرار المحادثات على نفس الإعلان.
conversationSchema.index({ listingId: 1, buyerId: 1 }, { unique: true });
conversationSchema.index({ buyerId: 1, lastMessageAt: -1 });
conversationSchema.index({ sellerUserId: 1, lastMessageAt: -1 });

const messageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true },
    senderId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    body: { type: String, required: true, trim: true, maxlength: 4000 },
    readAt: { type: Date, default: null },
  },
  opts,
);
messageSchema.index({ conversationId: 1, createdAt: 1 });

// ── الإشعارات والمفضّلة والمشاهدات ─────────────────────────
const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, required: true },
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, default: null, maxlength: 1000 },
    link: { type: String, default: null },
    readAt: { type: Date, default: null },
  },
  opts,
);
notificationSchema.index({ userId: 1, createdAt: -1 });

const favoriteSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    listingId: { type: Schema.Types.ObjectId, ref: "Listing", required: true },
  },
  opts,
);
favoriteSchema.index({ userId: 1, listingId: 1 }, { unique: true });

const recentViewSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    listingId: { type: Schema.Types.ObjectId, ref: "Listing", required: true },
    viewedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
recentViewSchema.index({ userId: 1, listingId: 1 }, { unique: true });
recentViewSchema.index({ userId: 1, viewedAt: -1 });

// ── البلاغات ورسائل التواصل وسجل الإدارة ───────────────────
const reportSchema = new Schema(
  {
    listingId: { type: Schema.Types.ObjectId, ref: "Listing", default: null },
    reporterId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reason: { type: String, required: true, maxlength: 120 },
    details: { type: String, default: null, maxlength: 2000 },
    status: { type: String, enum: ["open", "reviewed", "dismissed"], default: "open" },
  },
  opts,
);
reportSchema.index({ status: 1, createdAt: -1 });

const contactMessageSchema = new Schema(
  {
    name: { type: String, required: true, maxlength: 120 },
    contact: { type: String, required: true, maxlength: 160 },
    message: { type: String, required: true, maxlength: 4000 },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    status: { type: String, enum: ["open", "closed"], default: "open" },
  },
  opts,
);
contactMessageSchema.index({ status: 1, createdAt: -1 });

const adminActionSchema = new Schema(
  {
    adminId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    action: { type: String, required: true },
    targetType: { type: String, required: true },
    targetId: { type: String, default: null },
    notes: { type: String, default: null, maxlength: 500 },
  },
  opts,
);
adminActionSchema.index({ createdAt: -1 });

// ── توكنات التجديد ─────────────────────────────────────────
const refreshTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    /** نخزّن بصمة التوكن لا التوكن نفسه: تسريب القاعدة لا يمنح جلسات. */
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  opts,
);
refreshTokenSchema.index({ userId: 1 });
// حذف تلقائي بعد انتهاء الصلاحية — يبقي المجموعة نظيفة بلا مهام دورية.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ── رموز أجهزة الإشعارات ───────────────────────────────────
const deviceTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    /** رمز FCM. فريد عالميًا: الجهاز الواحد له رمز واحد مهما تعدّد المستخدمون. */
    token: { type: String, required: true, unique: true },
    platform: { type: String, enum: ["android", "ios", "web"], default: "android" },
    /** يُحدَّث عند كل تسجيل، ويُستخدم لتنظيف الأجهزة المهجورة لاحقًا. */
    lastSeenAt: { type: Date, default: Date.now },
  },
  opts,
);
deviceTokenSchema.index({ userId: 1 });

// ── رموز استعادة كلمة المرور ───────────────────────────────
const passwordResetSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    email: { type: String, required: true, lowercase: true, index: true },
    /**
     * بصمة الرمز لا الرمز نفسه، موقّعة بسرّ الخادم (HMAC).
     * الرمز ستّة أرقام فقط، فالتجزئة العادية تُكسر بالقوة الغاشمة في ثوانٍ
     * لو تسرّبت القاعدة. التوقيع بالسرّ يجعل ذلك مستحيلًا دون السرّ نفسه.
     */
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    /** محاولات خاطئة. تجاوز الحدّ يُبطل الرمز فورًا. */
    attempts: { type: Number, default: 0 },
    usedAt: { type: Date, default: null },
  },
  opts,
);
// حذف تلقائي بعد انتهاء الصلاحية بساعة — لا مهام دورية.
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

// ── حملات الإشعارات ────────────────────────────────────────
const campaignSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    body: { type: String, default: null, trim: true, maxlength: 500 },
    /** مسار داخل التطبيق يُفتح عند الضغط، مثل /listings. */
    link: { type: String, default: null, trim: true, maxlength: 300 },

    /** من يستقبلها. */
    audience: {
      type: { type: String, enum: ["all", "buyers", "sellers", "admins", "city"], default: "all" },
      cityId: { type: Schema.Types.ObjectId, ref: "City", default: null },
    },

    /**
     * الجدولة. "now" تُرسل فورًا مرة واحدة، و"once" في موعد محدّد،
     * والباقي يتكرّر بالتوقيت المحلّي المضبوط في TIMEZONE.
     */
    schedule: {
      type: { type: String, enum: ["now", "once", "daily", "weekly", "monthly"], default: "now" },
      /** ساعة ودقيقة بالتوقيت المحلّي للتكرار. */
      hour: { type: Number, default: 10, min: 0, max: 23 },
      minute: { type: Number, default: 0, min: 0, max: 59 },
      /** 0 الأحد … 6 السبت — للتكرار الأسبوعي. */
      weekday: { type: Number, default: 0, min: 0, max: 6 },
      /** يوم الشهر للتكرار الشهري. */
      dayOfMonth: { type: Number, default: 1, min: 1, max: 28 },
      /** موعد الإرسال لنوع "once". */
      runAt: { type: Date, default: null },
    },

    /** إيقاف مؤقّت دون حذف الحملة. */
    active: { type: Boolean, default: true },
    /** موعد التشغيل القادم — المُشغّل يستعلم عنه. */
    nextRunAt: { type: Date, default: null },
    lastRunAt: { type: Date, default: null },

    stats: {
      runs: { type: Number, default: 0 },
      lastRecipients: { type: Number, default: 0 },
      totalRecipients: { type: Number, default: 0 },
    },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  opts,
);
// المُشغّل يبحث عن الحملات المستحقّة كل دقيقة؛ هذا الفهرس يخدمه.
campaignSchema.index({ active: 1, nextRunAt: 1 });

// ── إعدادات المنصّة ────────────────────────────────────────
const settingSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  opts,
);

// ── التعليقات والتقييمات ───────────────────────────────────
const commentSchema = new Schema(
  {
    listingId: { type: Schema.Types.ObjectId, ref: "Listing", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    body: { type: String, required: true, trim: true, maxlength: 1000 },
    /**
     * التقييم من 1 إلى 5 — للمعروض فقط، وواحد لكل مستخدم لكل إعلان.
     * على المطلوب يبقى فارغًا: التعليق هناك عرضُ سعر أو سؤال لا حكم على جودة.
     */
    rating: { type: Number, default: null, min: 1, max: 5 },
    /** ردّ صاحب الإعلان على التعليق. */
    replyBody: { type: String, default: null, trim: true, maxlength: 1000 },
    replyAt: { type: Date, default: null },
    hidden: { type: Boolean, default: false },
  },
  opts,
);
commentSchema.index({ listingId: 1, createdAt: -1 });
commentSchema.index({ userId: 1 });

export type UserDoc = InferSchemaType<typeof userSchema>;
export type ListingDoc = InferSchemaType<typeof listingSchema>;
export type SellerDoc = InferSchemaType<typeof sellerSchema>;

export const User: Model<UserDoc> = model<UserDoc>("User", userSchema);
export const Category = model("Category", categorySchema);
export const City = model("City", citySchema);
export const Seller: Model<SellerDoc> = model<SellerDoc>("Seller", sellerSchema);
export const Listing: Model<ListingDoc> = model<ListingDoc>("Listing", listingSchema);
export const Conversation = model("Conversation", conversationSchema);
export const Message = model("Message", messageSchema);
export const Notification = model("Notification", notificationSchema);
export const Favorite = model("Favorite", favoriteSchema);
export const RecentView = model("RecentView", recentViewSchema);
export const Report = model("Report", reportSchema);
export const ContactMessage = model("ContactMessage", contactMessageSchema);
export const AdminAction = model("AdminAction", adminActionSchema);
export const RefreshToken = model("RefreshToken", refreshTokenSchema);
export const DeviceToken = model("DeviceToken", deviceTokenSchema);
export const PasswordReset = model("PasswordReset", passwordResetSchema);
export const Campaign = model("Campaign", campaignSchema);
export const Setting = model("Setting", settingSchema);
export const Comment = model("Comment", commentSchema);
