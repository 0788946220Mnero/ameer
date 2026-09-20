/**
 * حسابات المسافة والبحث بالقرب.
 *
 * الطريقة: مربّع إحداثيات يحصر المرشّحين في القاعدة (سريع ويستخدم الفهرس)،
 * ثم تنقية بمسافة هافرساين الحقيقية في الذاكرة (دقيق). المربّع وحده يعطي
 * زوايا أبعد من نصف القطر المطلوب، والتنقية تحذفها.
 */

const EARTH_RADIUS_KM = 6371;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** المسافة بين نقطتين بالكيلومترات. */
export function distanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * مربّع يحيط بدائرة نصف قطرها radiusKm حول نقطة.
 * درجة خط الطول تتقلّص كلّما ابتعدنا عن خطّ الاستواء، فنقسم على جيب تمام
 * خط العرض — بدون ذلك يكون المربّع ضيّقًا جدًا في الشمال وتضيع نتائج.
 */
export function boundingBox(lat: number, lng: number, radiusKm: number): BoundingBox {
  const latDelta = radiusKm / 111.32;
  const cos = Math.cos(toRad(lat));
  // قرب القطبين يقترب جيب التمام من الصفر؛ الحدّ الأدنى يمنع القسمة الهائلة.
  const lngDelta = radiusKm / (111.32 * Math.max(Math.abs(cos), 0.01));

  return {
    minLat: Math.max(-90, lat - latDelta),
    maxLat: Math.min(90, lat + latDelta),
    minLng: Math.max(-180, lng - lngDelta),
    maxLng: Math.min(180, lng + lngDelta),
  };
}

/** يتحقق أن الإحداثيات ضمن المدى الصالح. */
export function isValidCoords(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/** رابط اتجاهات يعمل على كل الأجهزة دون مفتاح خرائط. */
export function directionsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}
