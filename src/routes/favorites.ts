/** المفضّلة — إضافة وإزالة ومعرفة الحالة. */
import { Hono } from "hono";
import { Types } from "mongoose";
import { ApiError } from "../lib/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { Favorite } from "../models/index.js";

export const favoritesRoute = new Hono();
favoritesRoute.use("*", requireAuth);

/** معرّفات المفضّلة فقط — تكفي لتلوين القلوب في القوائم. */
favoritesRoute.get("/ids", async (c) => {
  const rows = await Favorite.find({ userId: c.get("user").id }).select("listingId").lean();
  return c.json(rows.map((r) => String(r.listingId)));
});

favoritesRoute.put("/:listingId", async (c) => {
  const listingId = c.req.param("listingId");
  if (!Types.ObjectId.isValid(listingId)) throw ApiError.badRequest("معرّف غير صالح", "invalid_id");
  // upsert يجعل العملية متكرّرة الاستدعاء بلا أثر جانبي.
  await Favorite.updateOne(
    { userId: c.get("user").id, listingId },
    { $setOnInsert: { userId: c.get("user").id, listingId } },
    { upsert: true },
  );
  return c.json({ ok: true, favorited: true });
});

favoritesRoute.delete("/:listingId", async (c) => {
  const listingId = c.req.param("listingId");
  if (!Types.ObjectId.isValid(listingId)) throw ApiError.badRequest("معرّف غير صالح", "invalid_id");
  await Favorite.deleteOne({ userId: c.get("user").id, listingId });
  return c.json({ ok: true, favorited: false });
});
