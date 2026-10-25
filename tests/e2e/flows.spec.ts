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
  await page.getByLabel('Логин').fill(email);
  await page.getByLabel('Пароль').fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  if (email.startsWith('admin')) {
    await page.getByLabel('Код MFA (6 цифр)').fill(totp(ADMIN_TOTP_SECRET));
    await page.getByRole('button', { name: 'Войти' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Панель управления' })).toBeVisible();
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
    .poll(async () => (await apiCall<{ items: Array<{ name: string; ownerId: string | null }> }>(page, `/api/v1/leads?search=${encodeURIComponent(name)}`)).body.items.find((l) => l.ownerId)?.name ?? '')
    .toContain(name);
  return (await apiCall<{ items: Array<{ id: string; ownerId: string }> }>(page, `/api/v1/leads?search=${encodeURIComponent(name)}`)).body.items[0]!;
}

/** «ГГГГ-ММ-ДДTЧЧ:мм» → «ДД.ММ.ГГГГ ЧЧ:мм» (так вводятся дата и время в интерфейсе). */
const dmyHm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)} ${iso.slice(11, 16)}`;

test('вход, предупреждение о подключениях и навигация по ролям', async ({ page }) => {
  await login(page, 'menejer.a@demo.local');
  await expect(page.getByText(/Входящие сообщения Instagram/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Лиды' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Пользователи' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Дубликаты' })).toHaveCount(0);
  await page.goto('/users');
  await expect(page.getByText(/Нет доступа/)).toBeVisible();
});

test('неверный пароль показывает ошибку и не создаёт сеанс', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Логин').fill('menejer.a@demo.local');
  await page.getByLabel('Пароль').fill('неверный-пароль');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByText('Неверный логин или пароль')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test('администратор с MFA видит интеграции; менеджер не открывает чужой лид', async ({ page, browser }) => {
  await login(page, 'admin@demo.local');
  await page.getByRole('link', { name: 'Интеграции' }).click();
  await expect(page.getByRole('heading', { name: 'Интеграции' })).toBeVisible();
  await expect(page.getByText(/amocrm/i)).toHaveCount(0);
  const lead = await createLeadViaDemo(page, `E2E RBAC ${Date.now()}`);
  const owner = (await apiCall<{ items: Array<{ id: string; email: string }> }>(page, '/api/v1/users')).body.items.find((u) => u.id === lead.ownerId)!;
  const otherEmail = ['menejer.a@demo.local', 'menejer.b@demo.local', 'menejer.c@demo.local'].find((e) => e !== owner.email)!;
  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await login(other, otherEmail);
  await other.goto(`/leads/${lead.id}`);
  await expect(other.getByText('Не найдено или недоступно для вас.')).toBeVisible();
  await ctx.close();
});

test('заказ: лид → заказ → сегмент → подтверждение → ручная проверка рейса', async ({ page }) => {
  await login(page, 'admin2@demo.local');
  const adminCtx = await page.context().browser()!.newContext();
  const admin = await adminCtx.newPage();
  await login(admin, 'admin@demo.local');
  const name = `E2E Safar ${Date.now()}`;
  const lead = await createLeadViaDemo(admin, name);
  await adminCtx.close();

  await page.goto(`/leads/${lead.id}`);
  await expect(page.getByRole('heading', { name: new RegExp(name) })).toBeVisible();
  await page.getByRole('button', { name: 'Создать заказ' }).click();
  await expect(page.getByRole('heading', { name: /Заказ TR-\d{4}-\d{6}/ })).toBeVisible();

  await page.getByLabel('Имя и фамилия').fill('Ali Valiyev');
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(page.locator('section', { has: page.getByRole('heading', { name: 'Пассажиры' }) }).getByText('Ali Valiyev')).toBeVisible();

  const dep = new Date(Date.now() + 10 * 86400_000);
  const local = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(dep).replace(' ', 'T');
  await page.getByLabel('Откуда (IATA)').fill('TAS');
  await page.getByLabel('Куда (IATA)').fill('IST');
  await page.getByLabel('Авиакомпания').fill('TK');
  await page.getByLabel('Номер рейса').fill('371');
  await page.getByLabel('Вылет (время аэропорта)').fill(dmyHm(local));
  await page.getByRole('button', { name: 'Сохранить сегмент' }).click();
  await expect(page.getByText(/TAS–IST · TK 371/)).toBeVisible();
  await expect(page.getByText(/время аэропорта, Asia\/Tashkent/)).toBeVisible();

  await page.getByLabel('Исполнение').selectOption('confirmed');
  await expect(page.getByText(/T-168h/).first()).toBeVisible();

  await page.getByRole('button', { name: 'Начать проверку' }).click();
  await expect(page.getByText('Рейс проверяется').first()).toBeVisible();
  await page.getByLabel('Заметка', { exact: true }).fill('Проверено на сайте авиакомпании');
  await page.getByRole('button', { name: 'Сохранить результат' }).click();
  await expect(page.getByText('Данные рейса проверены').first()).toBeVisible();
  await expect(page.getByText(/источник: вручную/)).toBeVisible();

  await page.getByRole('link', { name: 'Рейсы' }).click();
  await expect(page.getByRole('heading', { name: 'Рейсы' })).toBeVisible();
  await expect(page.getByText('TK 371').first()).toBeVisible();
});

test('вложение: загрузка в карточке лида, проверка на вирусы воркером, подписанная ссылка', async ({ page, browser }) => {
  test.setTimeout(150_000);
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await login(admin, 'admin@demo.local');
  const name = `E2E Fayl ${Date.now()}`;
  const lead = await createLeadViaDemo(admin, name);
  await admin.goto('/integrations');
  await expect(admin.getByRole('heading', { name: 'Безопасность и хранение' })).toBeVisible();
  await adminCtx.close();

  await login(page, 'admin2@demo.local');
  await page.goto(`/leads/${lead.id}`);
  await page.getByLabel('Загрузить файл').setInputFiles({ name: 'shartnoma.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% e2e test\n%%EOF') });
  await expect(page.getByText('shartnoma.pdf')).toBeVisible();
  await expect(page.getByText('Ожидает проверки на вирусы')).toBeVisible();
  // Цикл обслуживания воркера проверяет ожидающие файлы (≤ 60 с); список обновляется каждые 10 с.
  await expect(page.getByText('Проверен', { exact: true })).toBeVisible({ timeout: 100_000 });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать' }).click();
  expect((await download).suggestedFilename()).toBe('shartnoma.pdf');
});

test('вложение: замаскированный исполняемый файл отклоняется с понятным сообщением', async ({ page, browser }) => {
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await login(admin, 'admin@demo.local');
  const lead = await createLeadViaDemo(admin, `E2E Spoof ${Date.now()}`);
  await adminCtx.close();
  await login(page, 'admin2@demo.local');
  await page.goto(`/leads/${lead.id}`);
  await page.getByLabel('Загрузить файл').setInputFiles({ name: 'rasm.pdf', mimeType: 'application/pdf', buffer: Buffer.from('MZ\x90\x00 not a pdf') });
  await expect(page.getByText(/Содержимое файла не соответствует/)).toBeVisible();
});

test('финансы: туроператор → продажа/себестоимость → автоматическая прибыль → услуга в пакете не считается дважды', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await login(admin, 'admin@demo.local');
  const operatorName = `E2E Turoperator ${Date.now()}`;
  const op = await apiCall<{ id: string }>(admin, '/api/v1/suppliers', 'POST', { name: operatorName, kind: 'tour_operator', contactPerson: 'Aziz', phone: '+998901234567' });
  expect(op.status).toBe(201);
  const lead = await createLeadViaDemo(admin, `E2E Moliya ${Date.now()}`);
  await adminCtx.close();

  await login(page, 'admin2@demo.local');
  await page.goto(`/leads/${lead.id}`);
  await page.getByLabel('Туроператор', { exact: true }).selectOption({ label: operatorName });
  await expect(page.getByLabel('Туроператор', { exact: true })).toHaveValue(op.body.id);
  await page.getByRole('button', { name: 'Создать заказ' }).click();
  await expect(page.getByRole('heading', { name: /Заказ TR-\d{4}-\d{6}/ })).toBeVisible();

  // Пакет: продажа 1 200, себестоимость 1 000 -> прибыль 200 (автоматически; вручную не редактируется)
  await page.getByLabel('Цена продажи (для клиента)').fill('1200.00');
  await page.getByLabel('Себестоимость (от туроператора)').fill('1000.00');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  const finance = page.locator('section', { has: page.getByRole('heading', { name: 'Расчёт прибыли (валюты отдельно)' }) });
  await expect(finance.getByText('200 $', { exact: true }).first()).toBeVisible();
  await expect(finance.getByText('Первоначальная прибыль = цена продажи − себестоимость')).toBeVisible();

  // Отель, входящий в пакет: в итог не добавляется
  await page.getByLabel('Описание').fill('Hilton Dubai');
  await page.getByLabel('Название отеля').fill('Hilton');
  await page.getByLabel('Дата заезда').fill('01.12.2026');
  await page.getByLabel('Дата выезда').fill('08.12.2026');
  await page.getByLabel('Тип питания').selectOption('BB');
  await page.locator('form.service-form').getByLabel('Цена продажи').fill('600.00');
  await page.locator('form.service-form').getByLabel('Себестоимость').fill('500.00');
  await page.getByLabel('Входит в цену пакета').check();
  await page.getByRole('button', { name: 'Сохранить услугу' }).click();
  await expect(page.getByText('Входит в пакет — в итог не добавляется')).toBeVisible();
  await expect(finance.getByText('200 $', { exact: true }).first()).toBeVisible(); // не изменилось

  // Виза вне пакета: +100 продажа, +60 себестоимость -> прибыль 240
  await page.getByLabel('Тип строки').selectOption('visa');
  await page.getByLabel('Описание').fill('Виза');
  await page.locator('form.service-form').getByLabel('Цена продажи').fill('100.00');
  await page.locator('form.service-form').getByLabel('Себестоимость').fill('60.00');
  await page.getByRole('button', { name: 'Сохранить услугу' }).click();
  await expect(finance.getByText('240 $', { exact: true }).first()).toBeVisible();
  await expect(finance.getByText('1 300 $', { exact: true }).first()).toBeVisible();

  // Панель управления: фильтры «Найти» / «Сбросить»
  await page.goto('/dashboard');
  await page.getByRole('combobox', { name: 'Туроператор', exact: true }).selectOption(op.body.id);
  await page.getByRole('button', { name: 'Найти' }).click();
  await expect(page.getByRole('heading', { name: 'Воронка продаж' })).toBeVisible();
  await page.getByRole('button', { name: 'Сбросить' }).click();
});

test('роль «Пользователь» видит данные, но кнопок изменения нет, а сервер отклоняет запись', async ({ page }) => {
  await login(page, 'user@demo.local');
  await page.goto('/leads');
  await expect(page.getByRole('heading', { name: 'Лиды' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Создать лид/ })).toHaveCount(0);
  const r = await apiCall<{ error: { code: string } }>(page, '/api/v1/leads', 'POST', { firstName: 'X' });
  expect(r.status).toBe(403);
  expect(r.body.error.code).toBe('READ_ONLY_ROLE');
});
