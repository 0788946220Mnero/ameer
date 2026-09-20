/** الأقسام والمدن — قراءة عامة، تُخزَّن مؤقتًا في المتصفّح. */
import { Hono } from "hono";
import { Category, City } from "../models/index.js";
import { serializeCategory, serializeCity } from "../lib/serialize.js";
import { getSettings } from "../lib/settings.js";

export const catalogRoute = new Hono();

catalogRoute.get("/categories", async (c) => {
  const rows = await Category.find().sort({ sortOrder: 1 }).lean();
  c.header("Cache-Control", "public, max-age=300");
  return c.json(rows.map(serializeCategory));
});

catalogRoute.get("/cities", async (c) => {
  const rows = await City.find().sort({ sortOrder: 1 }).lean();
  c.header("Cache-Control", "public, max-age=300");
  return c.json(rows.map(serializeCity));
});

/**
 * الإعدادات العامة التي تعرضها الواجهة.
 * نُخرج ما يُعرض للزوّار فقط — مفاتيح الإدارة لا تخرج من هنا.
 */
catalogRoute.get("/settings", async (c) => {
  const s = await getSettings();
  c.header("Cache-Control", "public, max-age=60");
  return c.json({
    site_name: s["site_name"] ?? "جملة ماركت",
    site_tagline: s["site_tagline"] ?? "",
    announcement: s["announcement"] ?? "",
    contact_email: s["contact_email"] ?? "",
    contact_phone: s["contact_phone"] ?? "",
    contact_whatsapp: s["contact_whatsapp"] ?? "",
    listings_paused: s["listings_paused"] === true,
  });
});
