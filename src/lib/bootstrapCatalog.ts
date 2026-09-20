/**
 * بذر الأقسام والمدن عند الإقلاع.
 *
 * لماذا تلقائيًا؟ لأن المنصّة بلا أقسام ومدن لا تعمل إطلاقًا: لا يمكن إضافة
 * إعلان ولا تصفّح. وطلب تشغيل أمر يدوي على الاستضافة عقبة بلا مقابل.
 *
 * آمن للتكرار تمامًا: لا يكتب شيئًا إن كانت المجموعة غير فارغة، فلا يعيد
 * إنشاء ما حذفته من اللوحة ولا يلمس تعديلاتك على الأسماء.
 */
import { Category, City } from "../models/index.js";

const CATEGORIES: [string, string][] = [
  ["food", "مواد غذائية"],
  ["electronics", "إلكترونيات"],
  ["clothing", "ملابس وأقمشة"],
  ["home", "أدوات منزلية"],
  ["cosmetics", "مستحضرات تجميل"],
  ["tools", "عدد ومواد بناء"],
  ["stationery", "قرطاسية"],
  ["toys", "ألعاب"],
  ["agri", "منتجات زراعية"],
  ["auto", "قطع سيارات"],
  ["jewelry", "إكسسوارات ومجوهرات"],
  ["seasonal", "مواسم ومناسبات"],
  ["other", "أخرى"],
];

const CITIES: [string, string][] = [
  ["amman", "عمّان"],
  ["zarqa", "الزرقاء"],
  ["irbid", "إربد"],
  ["aqaba", "العقبة"],
  ["salt", "السلط"],
  ["mafraq", "المفرق"],
];

export async function bootstrapCatalog(): Promise<void> {
  try {
    if ((await Category.countDocuments()) === 0) {
      await Category.insertMany(
        CATEGORIES.map(([slug, nameAr], i) => ({ slug, nameAr, sortOrder: i + 1 })),
      );
      console.log(`[seed] أُضيف ${CATEGORIES.length} قسمًا`);
    }

    if ((await City.countDocuments()) === 0) {
      await City.insertMany(CITIES.map(([slug, nameAr], i) => ({ slug, nameAr, sortOrder: i + 1 })));
      console.log(`[seed] أُضيفت ${CITIES.length} مدن`);
    }
  } catch (err) {
    // فشل البذر لا يمنع الخدمة من العمل؛ الأقسام تُضاف يدويًا من اللوحة.
    console.error("[seed] تعذّر بذر الأقسام والمدن:", err);
  }
}
