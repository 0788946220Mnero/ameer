import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";

import { env, isProd } from "./env.js";
import { connectDb } from "./db.js";
import { bootstrapAdmins } from "./lib/bootstrapAdmins.js";
import { bootstrapCatalog } from "./lib/bootstrapCatalog.js";
import { verifyMailer } from "./lib/mailer.js";
import { ApiError } from "./lib/errors.js";
import { requireAuth, requireAdmin } from "./middleware/auth.js";
import { rateLimit } from "./middleware/rateLimit.js";

import { authRoute } from "./routes/auth.js";
import { catalogRoute } from "./routes/catalog.js";
import { listingsRoute } from "./routes/listings.js";
import { sellersRoute } from "./routes/sellers.js";
import { favoritesRoute } from "./routes/favorites.js";
import { notificationsRoute } from "./routes/notifications.js";
import { uploadsRoute } from "./routes/uploads.js";
import { chatsRoute } from "./routes/chats.js";
import { publicRoute } from "./routes/public.js";
import { commentsRoute } from "./routes/comments.js";
import { verificationRoute } from "./routes/verification.js";
import { statsRoute } from "./routes/admin/stats.js";
import { adminListingsRoute } from "./routes/admin/listings.js";
import { reportsRoute, adminSellersRoute } from "./routes/admin/moderation.js";
import { adminUsersRoute } from "./routes/admin/users.js";
import { taxonomyRoute, messagesRoute } from "./routes/admin/content.js";
import { campaignsRoute, settingsRoute } from "./routes/admin/campaigns.js";
import { startScheduler } from "./lib/scheduler.js";

const app = new Hono();

app.use("*", logger());
app.use("*", secureHeaders());

app.use(
  "*",
  cors({
    origin: (origin) => {
      // طلبات بلا Origin (curl، فحص الصحة) مسموحة؛ المتصفّح دائمًا يرسل Origin.
      if (!origin) return origin;
      return env.corsOrigins.includes(origin.replace(/\/$/, "")) ? origin : null;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
    credentials: false,
  }),
);

app.get("/health", (c) =>
  c.json({ status: "ok", service: "jumla-backend", time: new Date().toISOString() }),
);
app.get("/", (c) => c.json({ service: "jumla-backend", docs: "/health" }));

// ── مسارات عامة وموثّقة ────────────────────────────────────
const v1 = new Hono();
v1.route("/auth", authRoute);
v1.route("/catalog", catalogRoute);
v1.route("/listings", listingsRoute);
v1.route("/listings", commentsRoute);
v1.route("/verification", verificationRoute);
v1.route("/sellers", sellersRoute);
v1.route("/favorites", favoritesRoute);
v1.route("/notifications", notificationsRoute);
v1.route("/uploads", uploadsRoute);
v1.route("/chats", chatsRoute);
v1.route("/", publicRoute);

// ── المسارات الإدارية ──────────────────────────────────────
const admin = new Hono();
admin.use("*", requireAuth);
admin.use("*", requireAdmin);
admin.use(
  "*",
  rateLimit({
    name: "admin",
    limit: env.adminRateLimit,
    windowMs: env.adminRateWindowMs,
    key: (c) => c.get("user").id,
  }),
);
admin.route("/stats", statsRoute);
admin.route("/listings", adminListingsRoute);
admin.route("/reports", reportsRoute);
admin.route("/sellers", adminSellersRoute);
admin.route("/users", adminUsersRoute);
admin.route("/taxonomy", taxonomyRoute);
admin.route("/messages", messagesRoute);
admin.route("/campaigns", campaignsRoute);
admin.route("/settings", settingsRoute);
v1.route("/admin", admin);

app.route("/api/v1", v1);

app.notFound((c) => c.json({ error: "المسار غير موجود", code: "not_found" }, 404));

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  console.error("[unhandled]", err);
  return c.json(
    {
      error: "خطأ غير متوقّع في الخادم",
      code: "internal_error",
      ...(isProd ? {} : { detail: err.message }),
    },
    500,
  );
});

// الاتصال بالقاعدة قبل قبول أي طلب: بدء الاستماع أولًا يعني ردّ 500 على
// كل طلب يصل في أول ثوانٍ من الإقلاع.
await connectDb();
await bootstrapCatalog();
await bootstrapAdmins();
await verifyMailer();
startScheduler();

const server = serve({ fetch: app.fetch, port: env.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`[jumla-backend] يعمل على المنفذ ${info.port} — البيئة: ${env.nodeEnv}`);
  console.log(`[jumla-backend] النطاقات المسموحة: ${env.corsOrigins.join(", ") || "(لا شيء)"}`);
});

// بدون هذا المعالج يخرج فشل الاستماع كأثر استدعاءات خام لا يفهمه أحد.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[jumla-backend] المنفذ ${env.port} مشغول بالفعل — أوقف العملية الأخرى أو غيّر PORT`);
  } else {
    console.error("[jumla-backend] تعذّر بدء الاستماع:", err.message);
  }
  process.exit(1);
});

// إنهاء نظيف عند إعادة النشر: Railway يرسل SIGTERM قبل إيقاف النسخة.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[jumla-backend] استُلم ${signal} — إيقاف الخدمة`);
    server.close(() => process.exit(0));
    // مهلة قصوى حتى لا تعلق النسخة إن تأخّر إغلاق اتصالات البثّ.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
