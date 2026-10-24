import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'Demo-parol-2026!';
const ADMIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

function totp(secret: string) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let v = 0;
  const out: number[] = [];
  for (const c of secret) {
    v = (v << 5) | A.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((v >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', Buffer.from(out)).update(msg).digest();
  const o = h[19]! & 15;
  return String((((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1e6).padStart(6, '0');
}

async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Parol').fill(PASSWORD);
  await page.getByRole('button', { name: 'Kirish' }).click();
  if (email.startsWith('admin')) {
    await page.getByLabel('MFA kodi (6 raqam)').fill(totp(ADMIN_TOTP_SECRET));
    await page.getByRole('button', { name: 'Kirish' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Boshqaruv paneli' })).toBeVisible();
}

/** Calls the API with the page's session (same-origin through the Next.js rewrite). */
async function apiCall<T>(page: Page, path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ path, method, body }) => {
      const csrf = document.cookie.match(/(?:^|;\s*)crm_csrf=([^;]+)/)?.[1] ?? '';
      const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { path, method, body },
  );
}

async function createLeadViaDemo(page: Page, name: string) {
  const r = await apiCall<{ leadgenId: string }>(page, '/api/v1/demo/lead-ads', 'POST', { fullName: name, phone: `+99890${Math.floor(1_000_000 + Math.random() * 8_999_999)}`, platform: 'ig' });
  expect(r.status).toBe(202);
  await expect
    .poll(async () => (await apiCall<{ items: Array<{ name: string; amoLeadId: string | null }> }>(page, `/api/v1/leads?search=${encodeURIComponent(name)}`)).body.items.find((l) => l.amoLeadId)?.name ?? null, { timeout: 20_000 })
    .toContain(name);
  return (await apiCall<{ items: Array<{ id: string; ownerId: string }> }>(page, `/api/v1/leads?search=${encodeURIComponent(name)}`)).body.items[0]!;
}

test('login, DEMO banner and role-based navigation', async ({ page }) => {
  await login(page, 'menejer.a@demo.local');
  await expect(page.getByText(/DEMO REJIM/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Lidlar' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Foydalanuvchilar' })).toHaveCount(0);
  await page.goto('/users');
  await expect(page.getByText(/Ruxsat yo‘q/)).toBeVisible();
});

test('wrong password shows an error and no session', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('menejer.a@demo.local');
  await page.getByLabel('Parol').fill('noto‘g‘ri-parol');
  await page.getByRole('button', { name: 'Kirish' }).click();
  await expect(page.getByText('Email yoki parol noto‘g‘ri')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test('admin with MFA sees integrations; a manager cannot open another manager’s lead', async ({ page, browser }) => {
  await login(page, 'admin@demo.local');
  await page.getByRole('link', { name: 'Integratsiyalar' }).click();
  await expect(page.getByRole('heading', { name: 'Integratsiyalar' })).toBeVisible();
  await expect(page.getByText(/amocrm-demo \(DEMO\)/)).toBeVisible();
  const lead = await createLeadViaDemo(page, `E2E RBAC ${Date.now()}`);
  const owner = (await apiCall<{ items: Array<{ id: string; email: string }> }>(page, '/api/v1/users')).body.items.find((u) => u.id === lead.ownerId)!;
  const otherEmail = ['menejer.a@demo.local', 'menejer.b@demo.local', 'menejer.c@demo.local'].find((e) => e !== owner.email)!;
  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await login(other, otherEmail);
  await other.goto(`/leads/${lead.id}`);
  await expect(other.getByText('Topilmadi yoki sizga ochiq emas.')).toBeVisible();
  await ctx.close();
});

test('order flow: lead → order → segment → confirm → manual flight check', async ({ page }) => {
  await login(page, 'rahbar@demo.local');
  // The head has records.view_all; demo simulators need an admin, so create the lead as admin first.
  const adminCtx = await page.context().browser()!.newContext();
  const admin = await adminCtx.newPage();
  await login(admin, 'admin@demo.local');
  const name = `E2E Safar ${Date.now()}`;
  const lead = await createLeadViaDemo(admin, name);
  await adminCtx.close();

  await page.goto(`/leads/${lead.id}`);
  await expect(page.getByRole('heading', { name: new RegExp(name) })).toBeVisible();
  await page.getByRole('button', { name: 'Buyurtma yaratish' }).click();
  await expect(page.getByRole('heading', { name: /Buyurtma TR-\d{4}-\d{6}/ })).toBeVisible();

  await page.getByLabel('F.I.Sh.').fill('Ali Valiyev');
  await page.getByRole('button', { name: 'Qo‘shish' }).click();
  // Yo'lovchi nomi hujjat egasi ro'yxatida (<option>) ham uchraydi: tekshiruv yo'lovchilar bo'limi ichida.
  await expect(page.locator('section', { has: page.getByRole('heading', { name: 'Yo‘lovchilar' }) }).getByText('Ali Valiyev')).toBeVisible();

  const dep = new Date(Date.now() + 10 * 86400_000);
  const local = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(dep).replace(' ', 'T');
  await page.getByLabel('Qayerdan (IATA)').fill('TAS');
  await page.getByLabel('Qayerga (IATA)').fill('IST');
  await page.getByLabel('Aviakompaniya').fill('TK');
  await page.getByLabel('Reys raqami').fill('371');
  await page.getByLabel('Jo‘nash (aeroport vaqti)').fill(local);
  await page.getByRole('button', { name: 'Segmentni saqlash' }).click();
  await expect(page.getByText(/TAS–IST · TK 371/)).toBeVisible();
  await expect(page.getByText(/aeroport vaqti, Asia\/Tashkent/)).toBeVisible();

  await page.getByLabel('Xizmat').selectOption('confirmed');
  await expect(page.getByText(/Reys tekshiruvi T-168h/)).toBeVisible();

  await page.getByRole('button', { name: 'Tekshirishni boshlash' }).click();
  await expect(page.getByText('Reys tekshirilmoqda')).toBeVisible();
  await page.getByLabel('Izoh').fill('Aviakompaniya saytida tekshirildi');
  await page.getByRole('button', { name: 'Natijani saqlash' }).click();
  await expect(page.getByText('Reys ma’lumotlari tekshirildi').first()).toBeVisible();
  await expect(page.getByText(/manba: manual/)).toBeVisible();

  await page.getByRole('link', { name: 'Reyslar' }).click();
  await expect(page.getByRole('heading', { name: 'Reyslar' })).toBeVisible();
  await expect(page.getByText('TK 371').first()).toBeVisible();
});

test('attachment: upload in the lead card, virus scan by the worker, signed download', async ({ page, browser }) => {
  test.setTimeout(150_000);
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await login(admin, 'admin@demo.local');
  const name = `E2E Fayl ${Date.now()}`;
  const lead = await createLeadViaDemo(admin, name);
  await admin.goto('/integrations');
  await expect(admin.getByRole('heading', { name: 'Xavfsizlik va saqlash' })).toBeVisible();
  await expect(admin.getByRole('heading', { name: 'Sinxronlash va tarixni qayta olish' })).toBeVisible();
  await adminCtx.close();

  await login(page, 'rahbar@demo.local');
  await page.goto(`/leads/${lead.id}`);
  await page.getByLabel('Fayl yuklash').setInputFiles({ name: 'shartnoma.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% e2e test\n%%EOF') });
  await expect(page.getByText('shartnoma.pdf')).toBeVisible();
  await expect(page.getByText('Virus tekshiruvi kutilmoqda')).toBeVisible();
  // The worker housekeeping loop scans pending files (≤ 60 s); the list refreshes every 10 s.
  await expect(page.getByText('Tekshirildi')).toBeVisible({ timeout: 100_000 });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Yuklab olish' }).click();
  expect((await download).suggestedFilename()).toBe('shartnoma.pdf');
});

test('attachment: a disguised executable is rejected with a clear message', async ({ page, browser }) => {
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await login(admin, 'admin@demo.local');
  const lead = await createLeadViaDemo(admin, `E2E Spoof ${Date.now()}`);
  await adminCtx.close();
  await login(page, 'rahbar@demo.local');
  await page.goto(`/leads/${lead.id}`);
  await page.getByLabel('Fayl yuklash').setInputFiles({ name: 'rasm.pdf', mimeType: 'application/pdf', buffer: Buffer.from('MZ\x90\x00 not a pdf') });
  await expect(page.getByText('Fayl turi ruxsat etilmagan')).toBeVisible();
});

test('finance: turoperator → sotuv/tannarx → avtomatik foyda → paketga kiritilgan xizmat ikki marta sanalmaydi → dashboard', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await login(admin, 'admin@demo.local');
  const operatorName = `E2E Turoperator ${Date.now()}`;
  const op = await apiCall<{ id: string }>(admin, '/api/v1/suppliers', 'POST', { name: operatorName, kind: 'tour_operator', contactPerson: 'Aziz', phone: '+998901234567' });
  expect(op.status).toBe(201);
  const lead = await createLeadViaDemo(admin, `E2E Moliya ${Date.now()}`);

  await login(page, 'rahbar@demo.local');
  await page.goto(`/leads/${lead.id}`);
  await page.getByLabel('Turoperator', { exact: true }).selectOption({ label: operatorName });
  await expect(page.getByLabel('Turoperator', { exact: true })).toHaveValue(op.body.id);
  await page.getByRole('button', { name: 'Buyurtma yaratish' }).click();
  await expect(page.getByRole('heading', { name: /Buyurtma TR-\d{4}-\d{6}/ })).toBeVisible();

  // Paket: sotuv 1 200, tannarx 1 000 -> foyda 200 (avtomatik; qo'lda tahrirlanmaydi)
  await page.getByLabel('Sotuv narxi (mijozga, selling price)').fill('1200.00');
  await page.getByLabel('Tannarx (turoperatordan, net price)').fill('1000.00');
  await page.getByRole('button', { name: 'Saqlash', exact: true }).click();
  const finance = page.locator('section', { has: page.getByRole('heading', { name: 'Foyda hisobi (valyutalar alohida)' }) });
  await expect(finance.getByText('200 $', { exact: true })).toBeVisible();
  await expect(finance.getByText('Foyda = sotuv narxi − tannarx')).toBeVisible();

  // Paketga kiritilgan mehmonxona: jamiga qo'shilmaydi
  await page.getByLabel('Tavsif').fill('Hilton Dubai');
  await page.getByLabel('Mehmonxona nomi').fill('Hilton');
  await page.getByLabel('Kirish sanasi').fill('2026-12-01');
  await page.getByLabel('Chiqish sanasi').fill('2026-12-08');
  await page.getByLabel('Ovqatlanish turi').selectOption('BB');
  await page.locator('form.service-form').getByLabel('Sotuv narxi').fill('600.00');
  await page.locator('form.service-form').getByLabel('Tannarx').fill('500.00');
  await page.getByLabel('Paket narxiga kiritilgan').check();
  await page.getByRole('button', { name: 'Xizmatni saqlash' }).click();
  await expect(page.getByText('Paketga kiritilgan — jamiga qo‘shilmaydi')).toBeVisible();
  await expect(finance.getByText('200 $', { exact: true })).toBeVisible(); // o'zgarmadi

  // Paketdan tashqari viza: +100 sotuv, +60 tannarx -> foyda 240
  await page.getByLabel('Qator turi').selectOption('visa');
  await page.getByLabel('Tavsif').fill('Viza');
  await page.locator('form.service-form').getByLabel('Sotuv narxi').fill('100.00');
  await page.locator('form.service-form').getByLabel('Tannarx').fill('60.00');
  await page.getByRole('button', { name: 'Xizmatni saqlash' }).click();
  await expect(finance.getByText('240 $', { exact: true })).toBeVisible();
  await expect(finance.getByText('1 300 $', { exact: true })).toBeVisible();

  // Sotuv yopiladi (amoCRM'da), dashboard shu turoperator bo'yicha 240 foydani ko'rsatadi
  const won = await apiCall(admin, '/api/v1/demo/amo-native-edit', 'POST', { leadId: lead.id, stage: 'WON' });
  expect(won.status).toBe(202);
  await adminCtx.close();
  await page.goto('/dashboard');
  await page.getByRole('combobox', { name: 'Turoperator', exact: true }).selectOption(op.body.id);
  const block = page.locator('section.finance-block');
  await expect(block.getByText('Hisoblangan foyda').first()).toBeVisible({ timeout: 60_000 });
  await expect(block.getByText('240 $', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
});
