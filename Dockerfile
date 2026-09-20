# ---- مرحلة البناء ----
FROM node:20-alpine AS build
WORKDIR /app

# ملف القفل يُنسخ إن وُجد فقط (النجمة تمنع فشل COPY عند غيابه).
COPY package.json package-lock.json* ./

# npm ci أسرع ويضمن نسخًا مطابقة، لكنه يفشل بلا ملف قفل.
# هذا الشرط يجعل البناء يعمل في الحالتين بدل أن ينهار من أول سطر.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- مرحلة التشغيل ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
  && npm cache clean --force

COPY --from=build /app/dist ./dist

# تشغيل بمستخدم غير جذري
USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
