/**
 * جدولة بالتوقيت المحلّي.
 *
 * الخادم يعمل بتوقيت UTC، والمدير يفكّر بتوقيت عمّان. حملة «كل يوم 10 صباحًا»
 * يجب أن تصل العاشرة في الأردن لا العاشرة UTC.
 *
 * لا نستخدم مكتبة تواريخ: Intl مدمج في Node ويعطي الإزاحة الصحيحة لأي
 * منطقة في أي تاريخ، بما في ذلك التوقيت الصيفي حيث يُطبَّق.
 */
import { env } from "../env.js";

/** إزاحة المنطقة عن UTC بالدقائق في لحظة معيّنة. */
function offsetMinutes(at: Date, timeZone: string): number {
  // نُنسّق نفس اللحظة بالمنطقتين ونطرح: الفارق هو الإزاحة.
  const local = new Date(at.toLocaleString("en-US", { timeZone }));
  const utc = new Date(at.toLocaleString("en-US", { timeZone: "UTC" }));
  return Math.round((local.getTime() - utc.getTime()) / 60000);
}

/** أجزاء الوقت المحلّي في لحظة معيّنة. */
export function localParts(at: Date, timeZone = env.timezone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(parts["year"]),
    month: Number(parts["month"]),
    day: Number(parts["day"]),
    hour: Number(parts["hour"] === "24" ? "0" : parts["hour"]),
    minute: Number(parts["minute"]),
    weekday: weekdays.indexOf(String(parts["weekday"])),
  };
}

/** يبني لحظة UTC من وقت محلّي مطلوب. */
function fromLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone = env.timezone,
): Date {
  // تخمين أوّل يفترض أن القيم UTC، ثم نصحّحه بالإزاحة الفعلية عند تلك اللحظة.
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const off = offsetMinutes(new Date(guess), timeZone);
  return new Date(guess - off * 60000);
}

export interface ScheduleInput {
  type: "now" | "once" | "daily" | "weekly" | "monthly";
  hour: number;
  minute: number;
  weekday: number;
  dayOfMonth: number;
  runAt?: Date | null;
}

/**
 * الموعد التالي بعد لحظة معيّنة.
 * يعيد null للحملات التي لا تتكرّر بعد تشغيلها.
 */
export function computeNextRun(
  schedule: ScheduleInput,
  after: Date = new Date(),
): Date | null {
  const { type, hour, minute, weekday, dayOfMonth } = schedule;

  if (type === "now") return after;

  if (type === "once") {
    if (!schedule.runAt) return null;
    return schedule.runAt.getTime() > after.getTime() ? schedule.runAt : null;
  }

  const now = localParts(after);

  if (type === "daily") {
    let candidate = fromLocal(now.year, now.month, now.day, hour, minute);
    // فات موعد اليوم: ننتقل للغد.
    if (candidate.getTime() <= after.getTime()) {
      const t = new Date(candidate.getTime() + 24 * 3600 * 1000);
      const p = localParts(t);
      candidate = fromLocal(p.year, p.month, p.day, hour, minute);
    }
    return candidate;
  }

  if (type === "weekly") {
    // كم يومًا حتى اليوم المطلوب من الأسبوع.
    let delta = (weekday - now.weekday + 7) % 7;
    let candidate = fromLocal(now.year, now.month, now.day + delta, hour, minute);
    if (candidate.getTime() <= after.getTime()) {
      delta += 7;
      candidate = fromLocal(now.year, now.month, now.day + delta, hour, minute);
    }
    return candidate;
  }

  // شهري: اليوم محدود بـ28 في المخطّط، فلا مشكلة مع فبراير والأشهر القصيرة.
  let month = now.month;
  let year = now.year;
  let candidate = fromLocal(year, month, dayOfMonth, hour, minute);
  if (candidate.getTime() <= after.getTime()) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    candidate = fromLocal(year, month, dayOfMonth, hour, minute);
  }
  return candidate;
}

/** وصف عربي للجدولة — يُعرض في لوحة التحكم. */
export function describeSchedule(schedule: ScheduleInput): string {
  const t = (n: number) => String(n).padStart(2, "0");
  const time = `${t(schedule.hour)}:${t(schedule.minute)}`;
  const days = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

  switch (schedule.type) {
    case "now":
      return "إرسال فوري";
    case "once":
      return schedule.runAt
        ? `مرة واحدة في ${new Date(schedule.runAt).toLocaleString("ar", { timeZone: env.timezone })}`
        : "مرة واحدة (بلا موعد)";
    case "daily":
      return `يوميًا الساعة ${time}`;
    case "weekly":
      return `كل ${days[schedule.weekday] ?? "الأحد"} الساعة ${time}`;
    case "monthly":
      return `يوم ${schedule.dayOfMonth} من كل شهر الساعة ${time}`;
  }
}
