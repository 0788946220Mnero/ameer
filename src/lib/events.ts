/**
 * ناقل أحداث داخل الخادم — أساس التحديث الفوري.
 *
 * كل رسالة وكل إشعار يمرّان عبر هذا الخادم أصلًا، فهو يعرف لحظة وصولهما
 * دون حاجة إلى change streams (التي تتطلّب replica set واتصالًا دائمًا
 * لكل مشترك).
 *
 * حدّ التوسّع: عند تشغيل أكثر من نسخة على Railway، لا تعبر الأحداث بين
 * النسخ. لذلك يجمع بثّ SSE بين هذا الناقل واستقصاء دوري من القاعدة —
 * فيصل التحديث فورًا في الحالة الشائعة، وخلال ثوانٍ في أسوأ الأحوال.
 */
import { EventEmitter } from "node:events";

export interface MessageEvent {
  conversationId: string;
  messageId: string;
  senderId: string;
  recipientId: string;
  body: string;
  createdAt: string;
}

export interface NotificationEvent {
  userId: string;
  notificationId: string;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: string;
}

class Bus extends EventEmitter {
  emitMessage(e: MessageEvent): void {
    this.emit(`user:${e.recipientId}:message`, e);
    this.emit(`conv:${e.conversationId}`, e);
  }
  emitNotification(e: NotificationEvent): void {
    this.emit(`user:${e.userId}:notification`, e);
  }
}

export const bus = new Bus();
// كل مستخدم متصل يفتح مستمعين اثنين؛ الحدّ الافتراضي (10) يطلق تحذيرات كاذبة.
bus.setMaxListeners(0);
