/**
 * ترقية المديرين المعرّفين في متغيّر ADMIN_EMAILS.
 *
 * لماذا عند الإقلاع؟ لأن أوّل مدير لا يمكن أن يرقّيه أحد — لا يوجد مدير بعد.
 * البديل تشغيل أمر على الخادم، وهو غير متاح بسهولة على كل منصّات الاستضافة.
 *
 * السلوك: تُطبَّق القائمة عند كل إقلاع. أي بريد فيها يبقى مديرًا حتى لو
 * نُزعت عنه الصلاحية من اللوحة. للتحكّم الكامل من اللوحة، احذف المتغيّر
 * بعد ترقية أوّل مدير.
 *
 * لا يُنشئ حسابات: البريد يجب أن يكون مسجّلًا من الواجهة أوّلًا.
 */
import { env } from "../env.js";
import { User } from "../models/index.js";

export async function bootstrapAdmins(): Promise<void> {
  if (!env.adminEmails.length) return;

  for (const email of env.adminEmails) {
    try {
      const user = await User.findOne({ email });
      if (!user) {
        console.warn(
          `[admin] لا يوجد حساب بالبريد ${email} — سجّله من الواجهة ثم أعد تشغيل الخدمة`,
        );
        continue;
      }
      if (user.roles?.includes("admin")) continue;

      user.roles = [...new Set([...(user.roles ?? ["user"]), "admin"])];
      await user.save();
      console.log(`[admin] ${email} صار مديرًا — سجّل خروجًا ودخولًا ليسري التغيير`);
    } catch (err) {
      // فشل الترقية لا يمنع الخدمة من العمل.
      console.error(`[admin] تعذّرت ترقية ${email}:`, err);
    }
  }
}
