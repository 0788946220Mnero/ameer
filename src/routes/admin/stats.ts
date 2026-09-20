import { Hono } from "hono";
import { serializeAdminAction } from "../../lib/serialize.js";
import { Listing, Seller, User, Report, Category, City, AdminAction } from "../../models/index.js";

export const statsRoute = new Hono();

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * الأكثر تكرارًا (أقسام أو مدن) عبر تجميع في القاعدة.
 * في نسخة PostgreSQL كان هذا GROUP BY داخل دالة؛ هنا خطّ تجميع.
 */
async function topBy(field: "categoryId" | "cityId") {
  const rows = await Listing.aggregate<{ _id: unknown; total: number }>([
    { $match: { [field]: { $ne: null } } },
    { $group: { _id: `$${field}`, total: { $sum: 1 } } },
    { $sort: { total: -1 } },
    { $limit: 5 },
  ]);
  const ids = rows.map((r) => r._id);
  // النموذجان مفصولان عمدًا: توحيدهما في متغيّر واحد يجعل توقيع find اتحادًا
  // غير قابل للاستدعاء في TypeScript.
  const names =
    field === "categoryId"
      ? await Category.find({ _id: { $in: ids } }).select("nameAr").lean()
      : await City.find({ _id: { $in: ids } }).select("nameAr").lean();
  const map = new Map(names.map((n) => [String(n._id), n.nameAr as string]));
  return rows.map((r) => ({ name: map.get(String(r._id)) ?? "—", total: r.total }));
}

statsRoute.get("/", async (c) => {
  const [
    active_listings, pending_listings, rejected_listings,
    sellers, users, banned_users, open_reports,
    users_7d, users_30d, listings_7d, listings_30d,
    top_categories, top_cities,
  ] = await Promise.all([
    Listing.countDocuments({ status: "active" }),
    Listing.countDocuments({ status: "pending" }),
    Listing.countDocuments({ status: "rejected" }),
    Seller.countDocuments(),
    User.countDocuments(),
    User.countDocuments({ isBanned: true }),
    Report.countDocuments({ status: "open" }),
    User.countDocuments({ createdAt: { $gt: daysAgo(7) } }),
    User.countDocuments({ createdAt: { $gt: daysAgo(30) } }),
    Listing.countDocuments({ createdAt: { $gt: daysAgo(7) } }),
    Listing.countDocuments({ createdAt: { $gt: daysAgo(30) } }),
    topBy("categoryId"),
    topBy("cityId"),
  ]);

  return c.json({
    active_listings, pending_listings, rejected_listings,
    sellers, users, banned_users, open_reports,
    users_7d, users_30d, listings_7d, listings_30d,
    top_categories, top_cities,
  });
});

statsRoute.get("/actions", async (c) => {
  const rows = await AdminAction.find().sort({ createdAt: -1 }).limit(30).lean();
  return c.json(rows.map(serializeAdminAction));
});
