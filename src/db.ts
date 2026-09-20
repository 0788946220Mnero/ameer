import mongoose from "mongoose";
import { env } from "./env.js";

/**
 * الاتصال بـ MongoDB Atlas.
 *
 * mongoose يبني الفهارس المعرّفة في المخططات عند أول اتصال (autoIndex).
 * نتركه مفعّلًا: المجموعات هنا صغيرة نسبيًا والبناء يتم مرة واحدة، والبديل
 * — فهارس ناقصة صامتة — أسوأ بكثير.
 */

/** أسباب الفشل الشائعة، مرتّبة حسب تكرارها عمليًا. */
function explainConnectionError(message: string): string[] {
  const hints: string[] = [];

  if (/ECONNREFUSED/i.test(message)) {
    hints.push("لا يوجد خادم يستمع على العنوان المذكور — تأكّد أن MONGODB_URI صحيح.");
    hints.push("محليًا: هل MongoDB يعمل فعلًا؟");
  }
  if (/ENOTFOUND|EAI_AGAIN|querySrv/i.test(message)) {
    hints.push("تعذّر تحويل اسم النطاق — راجع اسم الـ cluster في MONGODB_URI.");
  }
  if (/Authentication failed|bad auth/i.test(message)) {
    hints.push("اسم المستخدم أو كلمة المرور خاطئة (Atlas ← Database Access).");
    hints.push(
      "إن كانت كلمة المرور تحوي @ أو : أو / أو # فيجب ترميزها: مثلًا @ تصبح %40.",
    );
  }
  if (/timed out|ETIMEDOUT|ServerSelection/i.test(message)) {
    hints.push(
      "غالبًا حجب شبكي: Atlas ← Network Access ← أضف 0.0.0.0/0 " +
        "(Railway لا يعطي عناوين ثابتة على الخطط العادية).",
    );
  }
  if (!hints.length) {
    hints.push("راجع MONGODB_URI وإعدادات Atlas.");
  }
  return hints;
}

const MAX_ATTEMPTS = 5;

export async function connectDb(): Promise<void> {
  mongoose.set("strictQuery", true);

  mongoose.connection.on("disconnected", () => {
    console.error("[db] انقطع الاتصال بقاعدة البيانات");
  });
  mongoose.connection.on("reconnected", () => {
    console.log("[db] عاد الاتصال بقاعدة البيانات");
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await mongoose.connect(env.mongoUri, {
        dbName: env.mongoDbName,
        serverSelectionTimeoutMS: 10000,
        // Atlas يغلق الاتصالات الخاملة؛ هذا يحافظ على المجمّع صحّيًا.
        maxPoolSize: 10,
        minPoolSize: 1,
      });
      console.log(`[db] متصل بقاعدة ${env.mongoDbName}`);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (attempt < MAX_ATTEMPTS) {
        // تراجع تصاعدي: قد يكون Atlas ما زال يستيقظ، أو الشبكة تتعافى.
        const waitMs = attempt * 3000;
        console.warn(
          `[db] تعذّر الاتصال (محاولة ${attempt}/${MAX_ATTEMPTS})، إعادة المحاولة بعد ${waitMs / 1000}ث`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      // الرسالة الأخيرة هي ما سيقرأه صاحب المشروع في سجل Railway،
      // فيجب أن تخبره بما يفعل لا أن تعرض أثر استدعاءات.
      console.error("");
      console.error("════════════════════════════════════════════════");
      console.error("[db] فشل الاتصال بقاعدة البيانات — الخدمة لن تعمل");
      console.error(`[db] السبب: ${message}`);
      console.error("");
      for (const hint of explainConnectionError(message)) {
        console.error(`  • ${hint}`);
      }
      console.error("════════════════════════════════════════════════");
      console.error("");
      process.exit(1);
    }
  }
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
