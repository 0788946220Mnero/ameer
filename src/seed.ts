/**
 * بذر البيانات — بديل الهجرات في نسخة PostgreSQL.
 *
 * آمن للتكرار: يبني الأقسام والمدن فقط إن كانت المجموعات فارغة، ولا يمسّ
 * أي بيانات موجودة. يشغَّل مرة واحدة بعد أول نشر:
 *     npm run build && npm run seed
 *
 * ولترقية حساب إلى مدير:
 *     npm run seed -- --admin=your@email.com
 */
import bcrypt from "bcryptjs";
import { connectDb, disconnectDb } from "./db.js";
import { Category, City, User } from "./models/index.js";

const CATEGORIES = [
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
] as const;

const CITIES = [
  ["amman", "عمّان"],
  ["zarqa", "الزرقاء"],
  ["irbid", "إربد"],
  ["aqaba", "العقبة"],
  ["salt", "السلط"],
  ["mafraq", "المفرق"],
] as const;

async function seedCatalog(): Promise<void> {
  if ((await Category.countDocuments()) === 0) {
    await Category.insertMany(
      CATEGORIES.map(([slug, nameAr], i) => ({ slug, nameAr, sortOrder: i + 1 })),
    );
    console.log(`✅ أُضيف ${CATEGORIES.length} قسمًا`);
  } else {
    console.log("· الأقسام موجودة — تُركت كما هي");
  }

  if ((await City.countDocuments()) === 0) {
    await City.insertMany(CITIES.map(([slug, nameAr], i) => ({ slug, nameAr, sortOrder: i + 1 })));
    console.log(`✅ أُضيفت ${CITIES.length} مدن`);
  } else {
    console.log("· المدن موجودة — تُركت كما هي");
  }
}

/**
 * ترقية أوّل مدير.
 * في نسخة PostgreSQL كانت تُنفَّذ باستعلام SQL يدوي؛ هنا أمر واضح.
 */
async function promote(email: string): Promise<void> {
  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user) {
    console.error(`❌ لا يوجد حساب بالبريد ${email} — سجّل الحساب من الواجهة أولًا`);
    return;
  }
  const roles = new Set(user.roles ?? ["user"]);
  roles.add("admin");
  user.roles = [...roles];
  await user.save();
  console.log(`✅ ${email} صار مديرًا — سجّل خروجًا ودخولًا ليسري التغيير`);
}

/** حساب مدير جاهز للتجربة المحلية فقط. */
async function createDemoAdmin(email: string, password: string): Promise<void> {
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    console.log(`· ${email} موجود مسبقًا`);
    return;
  }
  await User.create({
    email: email.toLowerCase(),
    passwordHash: await bcrypt.hash(password, 12),
    fullName: "مدير النظام",
    roles: ["user", "admin"],
  });
  console.log(`✅ أُنشئ حساب مدير: ${email}`);
}

async function main(): Promise<void> {
  await connectDb();
  await seedCatalog();

  const args = process.argv.slice(2);
  const adminArg = args.find((a) => a.startsWith("--admin="));
  if (adminArg) await promote(adminArg.split("=")[1] ?? "");

  const demoArg = args.find((a) => a.startsWith("--demo-admin="));
  if (demoArg) {
    const [email, password] = (demoArg.split("=")[1] ?? "").split(":");
    if (email && password) await createDemoAdmin(email, password);
    else console.error("❌ الصيغة: --demo-admin=email:password");
  }

  await disconnectDb();
  console.log("تم.");
}

main().catch(async (err) => {
  console.error("فشل البذر:", err);
  await disconnectDb();
  process.exit(1);
});
