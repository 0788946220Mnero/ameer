/**
 * تحويل مستندات Mongo إلى الشكل الذي تتوقّعه الواجهة.
 *
 * لماذا يدويًا بدل toJSON عام؟ لأن الإخفاء يجب أن يكون صريحًا: كلمة المرور
 * لا تخرج أبدًا، وبيانات تواصل البائع تخرج للمسجّلين فقط. القاعدة العامة
 * تنسى؛ الدالة الصريحة لا تنسى.
 *
 * كل معرّف يخرج باسم id (نصًا) لا _id، حتى تبقى الواجهة مستقلة عن Mongo.
 */

type Doc = Record<string, any>;

function id(v: unknown): string | null {
  if (!v) return null;
  return typeof v === "object" && "_id" in (v as Doc) ? String((v as Doc)._id) : String(v);
}

/** يعيد الكائن المرتبط كاملًا إن كان مُحمّلًا (populate)، أو null. */
function nested<T>(v: unknown, fn: (d: Doc) => T): T | null {
  if (!v || typeof v !== "object" || !("_id" in (v as Doc))) return null;
  return fn(v as Doc);
}

export function serializeCategory(d: Doc) {
  return {
    id: id(d._id)!,
    slug: d.slug,
    name_ar: d.nameAr,
    image_url: d.imageUrl ?? null,
    sort_order: d.sortOrder ?? 0,
  };
}

export function serializeCity(d: Doc) {
  return { id: id(d._id)!, slug: d.slug, name_ar: d.nameAr, sort_order: d.sortOrder ?? 0 };
}

/** الحسابات القديمة سُجّلت بـ buyer/seller؛ نوحّدها هنا مرة واحدة. */
export function normalizeAccountType(raw: unknown): "person" | "store" {
  return raw === "store" || raw === "seller" ? "store" : "person";
}

export function serializeUser(d: Doc) {
  const v = d.verification ?? {};
  return {
    id: id(d._id)!,
    email: d.email,
    full_name: d.fullName,
    phone: d.phone ?? null,
    account_type: normalizeAccountType(d.accountType),
    is_verified: v.status === "approved",
    verification: {
      status: v.status ?? "none",
      note: v.note ?? null,
      review_note: v.reviewNote ?? null,
      submitted_at: v.submittedAt ?? null,
      reviewed_at: v.reviewedAt ?? null,
    },
    activity_type: d.activityType ?? null,
    city_id: id(d.cityId),
    avatar_url: d.avatarUrl ?? null,
    is_banned: Boolean(d.isBanned),
    is_admin: Array.isArray(d.roles) && d.roles.includes("admin"),
    created_at: d.createdAt,
  };
}

/**
 * بيانات البائع. الهاتف والواتساب يخرجان فقط عندما يكون الطالب مسجّلًا —
 * هذا ما كانت تفعله سياسة seller_contacts في PostgreSQL.
 */
export function serializeSeller(d: Doc, opts: { includeContact: boolean }) {
  return {
    id: id(d._id)!,
    user_id: id(d.userId),
    slug: d.slug,
    name: d.name,
    activity_type: d.activityType ?? null,
    city_id: id(d.cityId),
    city: nested(d.cityId, serializeCity),
    bio: d.bio ?? null,
    address: d.address ?? null,
    lat: typeof d.lat === "number" ? d.lat : null,
    lng: typeof d.lng === "number" ? d.lng : null,
    logo_url: d.logoUrl ?? null,
    is_verified: Boolean(d.isVerified),
    phone: opts.includeContact ? (d.phone ?? null) : null,
    whatsapp: opts.includeContact ? (d.whatsapp ?? null) : null,
    created_at: d.createdAt,
  };
}

export function serializeListing(
  d: Doc,
  opts: { includeContact: boolean; distanceKm?: number | null },
) {
  const images = (d.images ?? [])
    .slice()
    .sort((a: Doc, b: Doc) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  return {
    id: id(d._id)!,
    user_id: id(d.userId),
    seller_id: id(d.sellerId),
    category_id: id(d.categoryId),
    city_id: id(d.cityId),
    kind: d.kind === "wanted" ? "wanted" : "offer",
    title: d.title,
    description: d.description,
    price: typeof d.price === "number" ? d.price : null,
    unit: d.unit,
    needed_by: d.neededBy ?? null,
    rating_avg: d.ratingAvg ?? 0,
    rating_count: d.ratingCount ?? 0,
    comment_count: d.commentCount ?? 0,
    min_order: d.minOrder,
    available_qty: d.availableQty ?? null,
    area: d.area ?? null,
    lat: typeof d.lat === "number" ? d.lat : null,
    lng: typeof d.lng === "number" ? d.lng : null,
    /** المسافة من موقع الباحث — تظهر فقط عند البحث بالقرب. */
    distance_km: opts.distanceKm ?? null,
    phone: opts.includeContact ? (d.phone ?? null) : null,
    has_whatsapp: Boolean(d.hasWhatsapp),
    has_delivery: Boolean(d.hasDelivery),
    status: d.status,
    is_featured: Boolean(d.isFeatured),
    views: d.views ?? 0,
    phone_clicks: d.phoneClicks ?? 0,
    chats_count: d.chatsCount ?? 0,
    created_at: d.createdAt,
    images: images.map((img: Doc) => ({ url: img.url, sort_order: img.sortOrder ?? 0 })),
    price_tiers: (d.priceTiers ?? []).map((t: Doc) => ({
      min_qty: t.minQty,
      max_qty: t.maxQty ?? null,
      price: t.price,
    })),
    category: nested(d.categoryId, serializeCategory),
    city: nested(d.cityId, serializeCity),
    seller: nested(d.sellerId, (s) => serializeSeller(s, opts)),
  };
}

export function serializeMessage(d: Doc) {
  return {
    id: id(d._id)!,
    conversation_id: id(d.conversationId),
    sender_id: id(d.senderId),
    body: d.body,
    read_at: d.readAt ?? null,
    created_at: d.createdAt,
  };
}

export function serializeConversation(d: Doc, viewerId: string) {
  return {
    id: id(d._id)!,
    listing_id: id(d.listingId),
    buyer_id: id(d.buyerId),
    seller_user_id: id(d.sellerUserId),
    last_message_at: d.lastMessageAt,
    last_message_body: d.lastMessageBody ?? null,
    created_at: d.createdAt,
    /** true عندما يكون المشاهد هو البائع في هذه المحادثة. */
    viewer_is_seller: id(d.sellerUserId) === viewerId,
    listing: nested(d.listingId, (l) => serializeListing(l, { includeContact: false })),
  };
}

export function serializeNotification(d: Doc) {
  return {
    id: id(d._id)!,
    type: d.type,
    title: d.title,
    body: d.body ?? null,
    link: d.link ?? null,
    read_at: d.readAt ?? null,
    created_at: d.createdAt,
  };
}

export function serializeReport(d: Doc) {
  return {
    id: id(d._id)!,
    listing_id: id(d.listingId),
    reason: d.reason,
    details: d.details ?? null,
    status: d.status,
    created_at: d.createdAt,
    listing: nested(d.listingId, (l) => ({
      id: id(l._id)!,
      title: l.title,
      status: l.status,
    })),
  };
}

export function serializeContactMessage(d: Doc) {
  return {
    id: id(d._id)!,
    name: d.name,
    contact: d.contact,
    message: d.message,
    status: d.status,
    created_at: d.createdAt,
  };
}

export function serializeAdminAction(d: Doc) {
  return {
    id: id(d._id)!,
    action: d.action,
    target_type: d.targetType,
    notes: d.notes ?? null,
    created_at: d.createdAt,
  };
}

/** تعليق أو تقييم مع صاحبه. */
export function serializeComment(d: Doc) {
  const author = d.userId && typeof d.userId === "object" && "_id" in d.userId ? d.userId : null;
  return {
    id: id(d._id)!,
    listing_id: id(d.listingId),
    body: d.body,
    rating: typeof d.rating === "number" ? d.rating : null,
    reply_body: d.replyBody ?? null,
    reply_at: d.replyAt ?? null,
    created_at: d.createdAt,
    author: author
      ? {
          id: id(author._id)!,
          full_name: author.fullName,
          account_type: normalizeAccountType(author.accountType),
          is_verified: author.verification?.status === "approved",
          avatar_url: author.avatarUrl ?? null,
        }
      : null,
  };
}

/** طلب توثيق كما يراه المدير — يتضمّن رابط الوثيقة. */
export function serializeVerificationRequest(d: Doc) {
  const v = d.verification ?? {};
  return {
    user_id: id(d._id)!,
    full_name: d.fullName,
    email: d.email,
    phone: d.phone ?? null,
    account_type: normalizeAccountType(d.accountType),
    status: v.status ?? "none",
    note: v.note ?? null,
    document_url: v.documentUrl ?? null,
    submitted_at: v.submittedAt ?? null,
  };
}
