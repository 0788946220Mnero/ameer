/**
 * إرسال البريد عبر SMTP.
 *
 * SMTP لا واجهة مزوّد بعينه: يعمل مع Brevo وZoho وResend وGmail دون ربط
 * المشروع بأي شركة. تغيير المزوّد لاحقًا يعني تغيير أربعة متغيّرات فقط.
 */
import nodemailer, { type Transporter } from "nodemailer";
import { env, mailEnabled } from "../env.js";

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!mailEnabled) return null;
  transporter ??= nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    // المنفذ 465 يبدأ مشفّرًا؛ 587 يرقّي الاتصال بـ STARTTLS.
    secure: env.smtpPort === 465,
    auth: { user: env.smtpUser, pass: env.smtpPass },
  });
  return transporter;
}

/** يتحقق من صحّة إعدادات SMTP عند الإقلاع بدل اكتشاف العطل مع أول مستخدم. */
export async function verifyMailer(): Promise<void> {
  const t = getTransporter();
  if (!t) {
    console.warn("[mail] SMTP غير مضبوط — استعادة كلمة المرور معطّلة");
    return;
  }
  try {
    await t.verify();
    console.log(`[mail] SMTP جاهز عبر ${env.smtpHost}`);
  } catch (err) {
    console.error(
      "[mail] تعذّر الاتصال بخادم البريد — استعادة كلمة المرور لن تعمل:",
      err instanceof Error ? err.message : err,
    );
  }
}

interface MailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

async function send(mail: MailInput): Promise<boolean> {
  const t = getTransporter();
  if (!t) return false;
  try {
    await t.sendMail({ from: env.smtpFrom, ...mail });
    return true;
  } catch (err) {
    console.error("[mail] فشل الإرسال:", err);
    return false;
  }
}

/** قالب عربي RTL بسيط يعمل في كل عملاء البريد. */
function template(title: string, body: string): string {
  return `<!doctype html>
<html lang="ar" dir="rtl"><body style="margin:0;padding:24px;background:#f7faf9;font-family:Tahoma,Arial,sans-serif;color:#102a43">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:14px;padding:28px;text-align:right">
    <div style="font-size:20px;font-weight:bold;color:#087f5b;margin-bottom:6px">جملة ماركت</div>
    <div style="font-size:13px;color:#6b7f7a;margin-bottom:22px">سوق الجملة في الأردن</div>
    <h1 style="font-size:18px;margin:0 0 14px">${title}</h1>
    ${body}
  </div>
  <div style="max-width:480px;margin:14px auto 0;text-align:center;font-size:12px;color:#6b7f7a">
    هذه رسالة آلية، لا تردّ عليها.
  </div>
</body></html>`;
}

export async function sendPasswordResetCode(
  to: string,
  code: string,
  minutes: number,
): Promise<boolean> {
  const body = `
    <p style="margin:0 0 16px;line-height:1.8;font-size:15px">
      وصلنا طلب لإعادة تعيين كلمة مرور حسابك. استخدم الرمز التالي:
    </p>
    <div style="margin:0 0 16px;padding:18px;background:#f0f7f4;border-radius:12px;text-align:center">
      <span style="font-size:32px;font-weight:bold;letter-spacing:10px;color:#087f5b;direction:ltr;display:inline-block">${code}</span>
    </div>
    <p style="margin:0 0 16px;line-height:1.8;font-size:14px;color:#6b7f7a">
      الرمز صالح لمدة ${minutes} دقيقة، ويُستخدم مرة واحدة فقط.
    </p>
    <p style="margin:0;line-height:1.8;font-size:14px;color:#6b7f7a">
      إن لم تطلب هذا، تجاهل الرسالة — لن يتغيّر شيء في حسابك.
    </p>`;

  return send({
    to,
    subject: `رمز استعادة كلمة المرور: ${code}`,
    html: template("استعادة كلمة المرور", body),
    text: `رمز استعادة كلمة المرور: ${code}\nصالح لمدة ${minutes} دقيقة ويُستخدم مرة واحدة.\nإن لم تطلب هذا، تجاهل الرسالة.`,
  });
}

/** تأكيد بعد تغيير كلمة المرور — ينبّه المستخدم لو لم يكن هو من غيّرها. */
export async function sendPasswordChangedNotice(to: string): Promise<boolean> {
  const body = `
    <p style="margin:0 0 16px;line-height:1.8;font-size:15px">
      تم تغيير كلمة مرور حسابك بنجاح، وأُنهيت كل الجلسات المفتوحة على الأجهزة الأخرى.
    </p>
    <p style="margin:0;line-height:1.8;font-size:14px;color:#6b7f7a">
      إن لم تكن أنت من غيّرها، استعد حسابك فورًا وغيّر كلمة المرور مرة أخرى.
    </p>`;

  return send({
    to,
    subject: "تم تغيير كلمة مرور حسابك",
    html: template("تم تغيير كلمة المرور", body),
    text: "تم تغيير كلمة مرور حسابك وأُنهيت كل الجلسات الأخرى. إن لم تكن أنت، استعد حسابك فورًا.",
  });
}
