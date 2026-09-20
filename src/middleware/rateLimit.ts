import type { MiddlewareHandler, Context } from "hono";
import { ApiError } from "../lib/errors.js";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 5 * 60 * 1000).unref();

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  name: string;
  /** قد يكون غير متزامن ليقرأ جسم الطلب (Hono يخزّنه مؤقتًا). */
  key?: (c: Context) => string | Promise<string>;
}

function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return headers.get("x-real-ip") ?? "unknown";
}

/**
 * محدّد معدّل في الذاكرة. كافٍ لنسخة واحدة على Railway؛ عند التوسّع
 * استبدل الخريطة بـ Redis دون تغيير أي استدعاء.
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  return async (c, next) => {
    const owner = options.key ? await options.key(c) : clientIp(c.req.raw.headers);
    const key = `${options.name}:${owner}`;
    const now = Date.now();

    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    } else if (bucket.count >= options.limit) {
      const seconds = Math.ceil((bucket.resetAt - now) / 1000);
      c.header("Retry-After", String(seconds));
      throw ApiError.tooMany(`طلبات كثيرة، حاول بعد ${seconds} ثانية`);
    } else {
      bucket.count += 1;
    }
    await next();
  };
}
