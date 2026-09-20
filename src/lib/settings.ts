/**
 * قراءة إعدادات المنصّة.
 *
 * تُخزَّن مؤقّتًا لثوانٍ: بدون ذلك نقرأ القاعدة عند كل إنشاء إعلان وكل زيارة
 * للصفحة الرئيسية. والتأخير المقبول هنا نصف دقيقة — المدير يغيّر إعدادًا
 * ويراه بعد لحظات، وهذا كافٍ.
 */
import { Setting } from "../models/index.js";

export const SETTING_DEFAULTS = {
  site_name: "جملة ماركت",
  site_tagline: "سوق الجملة في الأردن",
  contact_email: "",
  contact_phone: "",
  contact_whatsapp: "",
  listings_paused: false,
  announcement: "",
  moderate_new_listings: false,
} as const;

export type SettingsShape = Record<string, unknown>;

const CACHE_MS = 30_000;
let cache: { value: SettingsShape; at: number } | null = null;

export async function getSettings(force = false): Promise<SettingsShape> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  try {
    const rows = await Setting.find().lean();
    const stored = Object.fromEntries(rows.map((r) => [r.key as string, r.value]));
    cache = { value: { ...SETTING_DEFAULTS, ...stored }, at: Date.now() };
  } catch (err) {
    // فشل القراءة لا يوقف المنصّة: نعمل بالقيم الافتراضية.
    console.error("[settings] تعذّرت القراءة، استُخدمت القيم الافتراضية:", err);
    cache = { value: { ...SETTING_DEFAULTS }, at: Date.now() };
  }

  return cache.value;
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const all = await getSettings();
  const value = all[key];
  return (value === undefined || value === null ? fallback : value) as T;
}

/** يُستدعى بعد أي حفظ حتى يسري التغيير فورًا لا بعد انتهاء التخزين المؤقّت. */
export function invalidateSettings(): void {
  cache = null;
}
