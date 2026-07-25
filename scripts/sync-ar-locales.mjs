#!/usr/bin/env node
/** Sync locales/ar from locales/en (issue #629). */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const enDir = join(root, 'apps/web/src/i18n/locales/en');
const arDir = join(root, 'apps/web/src/i18n/locales/ar');
mkdirSync(arDir, { recursive: true });

const PHRASES = [
  ['Preferences', 'التفضيلات'],
  ['Display language', 'لغة العرض'],
  ['System (browser default)', 'النظام (افتراضي المتصفح)'],
  ['Language', 'اللغة'],
  ['Save', 'حفظ'],
  ['Cancel', 'إلغاء'],
  ['Delete', 'حذف'],
  ['Edit', 'تعديل'],
  ['Loading…', 'جارٍ التحميل…'],
  ['Saving…', 'جارٍ الحفظ…'],
  ['Retry', 'إعادة المحاولة'],
  ['Inventory', 'المخزون'],
  ['Encounters', 'المواجهات'],
  ['Sessions', 'الجلسات'],
  ['Compendium', 'الموسوعة'],
  ['Admin', 'الإدارة'],
  ['No campaign selected.', 'لم يتم اختيار حملة.'],
  ['No campaign selected', 'لم يتم اختيار حملة'],
  ['Party stash', 'مخزن الحزب'],
  ['Couldn\'t load', 'تعذّر تحميل'],
  ['Couldn\'t save', 'تعذّر الحفظ'],
  ['Couldn\'t update', 'تعذّر التحديث'],
  ['Couldn\'t delete', 'تعذّر الحذف'],
  ['Couldn\'t add', 'تعذّر الإضافة'],
  ['Couldn\'t create', 'تعذّر الإنشاء'],
  ['Couldn\'t search', 'تعذّر البحث'],
  ['Not found.', 'غير موجود.'],
  ['Not found', 'غير موجود'],
  ['That action failed.', 'فشل هذا الإجراء.'],
  ['Session Zero', 'الجلسة الصفرية'],
  ['No sessions yet', 'لا توجد جلسات بعد'],
  ['No encounters yet', 'لا توجد مواجهات بعد'],
  ['No users yet', 'لا يوجد مستخدمون بعد'],
  ['No API tokens yet', 'لا توجد رموز API بعد'],
  ['No rule packs installed', 'لم يتم تثبيت حزم القواعد'],
  ['No session-zero charter yet', 'لا يوجد ميثاق للجلسة الصفرية بعد'],
];

function arize(s) {
  let out = s;
  for (const [en, ar] of PHRASES) out = out.split(en).join(ar);
  return out;
}

function walk(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(walk);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'string' ? arize(v) : walk(v);
  }
  return out;
}

for (const file of readdirSync(enDir).filter((f) => f.endsWith('.json'))) {
  const data = JSON.parse(readFileSync(join(enDir, file), 'utf8'));
  writeFileSync(join(arDir, file), JSON.stringify(walk(data), null, 2) + '\n');
}
console.log('sync-ar-locales: ok');
