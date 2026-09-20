/**
 * مُشغّل الحملات الدورية.
 *
 * يفحص كل دقيقة عن الحملات المستحقّة. الدقيقة دقّة كافية لإشعارات تسويقية،
 * وأقلّ منها يعني استعلامًا متكرّرًا بلا فائدة.
 *
 * حماية من التكرار: نحجز الحملة بتحديث ذرّي يزيح nextRunAt قبل الإرسال.
 * بدون هذا الحجز، تشغيل نسختين من الخدمة على Railway يرسل كل حملة مرّتين.
 */
import { Campaign } from "../models/index.js";
import { runCampaign } from "./broadcast.js";
import { computeNextRun } from "./schedule.js";

const TICK_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  // تشغيل سابق لم ينتهِ (حملة كبيرة): نتخطّى هذه الدورة بدل التراكم.
  if (running) return;
  running = true;

  try {
    const now = new Date();
    const due = await Campaign.find({
      active: true,
      nextRunAt: { $ne: null, $lte: now },
    })
      .select("_id schedule")
      .limit(20)
      .lean();

    for (const row of due) {
      const id = String(row._id);

      // الحجز: نحسب الموعد التالي ونكتبه قبل الإرسال. أي نسخة أخرى تفحص
      // الآن لن تجد الحملة مستحقّة، فلا يتكرّر الإرسال.
      const sch = row.schedule;
      if (!sch) continue;

      const next = computeNextRun(
        {
          type: (sch.type ?? "now") as never,
          hour: sch.hour ?? 10,
          minute: sch.minute ?? 0,
          weekday: sch.weekday ?? 0,
          dayOfMonth: sch.dayOfMonth ?? 1,
          runAt: sch.runAt ?? null,
        },
        // ثانية للأمام: لولاها لأعاد الحساب نفس اللحظة فتتكرّر الحملة فورًا.
        new Date(now.getTime() + 1000),
      );

      const claimed = await Campaign.findOneAndUpdate(
        { _id: id, active: true, nextRunAt: { $lte: now } },
        {
          $set: {
            nextRunAt: next,
            // الحملات غير المتكرّرة تُعطَّل بعد تشغيلها.
            ...(next ? {} : { active: false }),
          },
        },
      ).lean();

      if (!claimed) continue;

      try {
        const result = await runCampaign(id);
        console.log(`[scheduler] أُرسلت حملة "${claimed.title}" إلى ${result.recipients} مستخدمًا`);
      } catch (err) {
        console.error(`[scheduler] فشل إرسال الحملة ${id}:`, err);
      }
    }
  } catch (err) {
    // خطأ في الفحص لا يوقف المُشغّل: الدورة القادمة تحاول من جديد.
    console.error("[scheduler] خطأ في دورة الفحص:", err);
  } finally {
    running = false;
  }
}

export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  // لا يمنع الخروج النظيف عند إعادة النشر.
  timer.unref();
  console.log("[scheduler] مُشغّل الحملات يعمل — فحص كل دقيقة");
  // فحص أوّل فوري لالتقاط ما استُحقّ أثناء توقّف الخدمة.
  void tick();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
