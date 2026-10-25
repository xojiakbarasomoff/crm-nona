// Demo muhitga (:3101) SUN'IY namuna ma'lumotlarni API orqali qo'shadi: turoperatorlar, buyurtmalar, narxlar, qaytarimlar.
// Faqat lokal demo muhit uchun: lokal bo'lmagan manzilni va APP_MODE=demo bo'lmagan serverni rad etadi.
// Railway/production bazasiga HECH QACHON ishlatilmaydi (u yerga sun'iy turoperator yoki narx qo'shilmaydi).
import { createHmac } from 'node:crypto';
import { DEMO_WEB_PORT } from './common.mjs';

const U = process.argv[2] ?? `http://localhost:${DEMO_WEB_PORT}`;
const host = new URL(U).hostname;
if (!['localhost', '127.0.0.1'].includes(host)) {
  console.error(`Rad etildi: ${U} lokal emas. Sun'iy demo ma'lumot faqat lokal demo muhitga qo'shiladi.`);
  process.exit(2);
}
const PASS = 'Demo-parol-2026!';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

function totp(secret) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let v = 0;
  const out = [];
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
  const o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0');
}

class Sess {
  cookie = '';
  csrf = '';
  async call(method, path, body, extra = {}) {
    const res = await fetch(U + path, { method, headers: { 'content-type': 'application/json', cookie: this.cookie, ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const sc = res.headers.getSetCookie?.() ?? [];
    if (sc.length) this.cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const t = await res.text();
    let j = null;
    try {
      j = JSON.parse(t);
    } catch {
      /* matn */
    }
    return { status: res.status, body: j ?? t };
  }
  async login(email, totpSecret) {
    const r = await this.call('POST', '/api/v1/auth/login', { email, password: PASS, ...(totpSecret ? { totp: totp(totpSecret) } : {}) });
    if (r.status !== 200) throw new Error(`login ${email}: ${JSON.stringify(r.body)}`);
    this.csrf = r.body.csrfToken;
    return this;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const must = (r, what, ok = [200, 201, 202]) => {
  if (!ok.includes(r.status)) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

const admin = await new Sess().login('admin@demo.local', TOTP_SECRET);
const head = await new Sess().login('rahbar@demo.local');
const me = must(await head.call('GET', '/api/v1/me'), 'me');
if (me.appMode !== 'demo') {
  console.error('Rad etildi: server APP_MODE=demo emas.');
  process.exit(2);
}

// 1) Turoperatorlar va yetkazib beruvchilar (sun'iy, "(demo)" belgisi bilan)
const mk = async (name, kind, extra = {}) => {
  const r = await head.call('POST', '/api/v1/suppliers', { name, kind, ...extra });
  if (r.status === 201) return r.body;
  const list = (await head.call('GET', '/api/v1/suppliers?status=all')).body.items;
  return list.find((s) => s.name.toLowerCase() === name.toLowerCase());
};
const anex = await mk('Anex Tour (demo)', 'tour_operator', { contactPerson: 'Dilshod Karimov', phone: '+998 71 200 00 01', email: 'anex@demo.example', note: 'Turkiya, BAA yo‘nalishlari' });
const coral = await mk('Coral Travel (demo)', 'tour_operator', { contactPerson: 'Madina Aliyeva', phone: '+998 71 200 00 02', email: 'coral@demo.example', note: 'Misr, Turkiya' });
const pegas = await mk('Pegas Touristik (demo)', 'tour_operator', { contactPerson: 'Sardor Yusupov', phone: '+998 71 200 00 03', email: 'pegas@demo.example' });
const rixos = await mk('Rixos Sharm (demo)', 'hotel', { contactPerson: 'Reservation', phone: '+20 69 000 0000' });
const transfer = await mk('Dubai Transfers (demo)', 'transfer', { contactPerson: 'Dispatcher', phone: '+971 4 000 0000' });

// 2) Lidlar, buyurtmalar, narxlar
async function newLead(name, destination) {
  must(await admin.call('POST', '/api/v1/demo/lead-ads', { fullName: name, destination, platform: 'ig', phone: `+99890${Math.floor(1_000_000 + Math.random() * 8_999_999)}` }), 'lead', [202]);
  for (let i = 0; i < 40; i++) {
    const l = (await head.call('GET', `/api/v1/leads?search=${encodeURIComponent(name)}`)).body.items?.find((x) => x.amoLeadId);
    if (l) return l;
    await sleep(500);
  }
  throw new Error(`lead kutilmadi ${name}`);
}
const setOp = async (lead, op) => {
  const cur = must(await head.call('GET', `/api/v1/leads/${lead.id}`), 'lead').lead;
  must(await head.call('PATCH', `/api/v1/leads/${lead.id}`, { version: cur.version, tourOperatorId: op.id }), 'operator', [200]);
};
const mkOrder = async (lead, selling, ccy, net) => {
  let ord = must(await head.call('POST', '/api/v1/orders', { leadId: lead.id, ...(selling ? { agreedAmount: selling, currency: ccy } : {}) }), 'order');
  ord = must(await head.call('PATCH', `/api/v1/orders/${ord.id}`, { version: ord.version, saleEvidence: 'Shartnoma (demo)', ...(net ? { netPrice: net } : {}) }), 'order patch', [200]);
  return ord;
};
const win = async (lead) => must(await admin.call('POST', '/api/v1/demo/amo-native-edit', { leadId: lead.id, stage: 'WON' }), 'won', [202]);
const svc = (orderId, body) => head.call('POST', `/api/v1/orders/${orderId}/services`, body);
const tag = Date.now().toString().slice(-5);

const L = {};
L.a = await newLead(`Rahimova Nigora ${tag}`, 'Dubay'); await setOp(L.a, anex); L.oa = await mkOrder(L.a, '1200.00', 'USD', '1000.00');
L.b = await newLead(`Karimov Sherzod ${tag}`, 'Antalya'); await setOp(L.b, anex); L.ob = await mkOrder(L.b, '900.00', 'USD', '1000.00');
L.c = await newLead(`Aliyev Bobur ${tag}`, 'Sharm-el-Sheyx'); await setOp(L.c, coral); L.oc = await mkOrder(L.c, '15000000.00', 'UZS', '12500000.00');
L.d = await newLead(`Ergasheva Madina ${tag}`, 'Dubay'); await setOp(L.d, coral); L.od = await mkOrder(L.d, '2000.00', 'USD', '1650.00');
await svc(L.od.id, { serviceType: 'hotel', description: 'Rixos Premium (paketda)', amount: '1100.00', netAmount: '900.00', currency: 'USD', supplierId: rixos.id, includedInPackage: true, details: { hotelName: 'Rixos Premium Dubai', address: 'JBR, Dubay', checkIn: '2026-11-20', checkOut: '2026-11-27', roomType: 'Double Sea View', mealPlan: 'AI' } });
await svc(L.od.id, { serviceType: 'transfer', description: 'Aeroport — mehmonxona (paketda)', amount: '60.00', netAmount: '40.00', currency: 'USD', supplierId: transfer.id, includedInPackage: true, details: { route: 'DXB aeroport → Rixos Premium', pickupAt: '2026-11-20T09:30', vehicle: 'Minivan' } });
await svc(L.od.id, { serviceType: 'visa', description: 'BAA vizasi (paketdan tashqari)', amount: '120.00', netAmount: '80.00', currency: 'USD' });
L.e = await newLead(`Sobirov Jasur ${tag}`, 'Seul'); await setOp(L.e, pegas); L.oe = await mkOrder(L.e, '700.00', 'USD', null); // tannarx noma'lum
L.f = await newLead(`Tursunov Akmal ${tag}`, 'Istanbul'); await setOp(L.f, pegas); L.of = await mkOrder(L.f, '800.00', 'USD', '700.00'); // bekor qilinadi
L.g = await newLead(`Hamidova Shahlo ${tag}`, 'Bali'); await setOp(L.g, pegas); L.og = await mkOrder(L.g, '1500.00', 'USD', '1200.00'); // ochiq: kutilayotgan foyda
L.h = await newLead(`Qodirov Otabek ${tag}`, 'Tbilisi'); await setOp(L.h, anex); L.oh = await mkOrder(L.h, '600.00', 'USD', '500.00'); // to'liq qaytarim

for (const k of ['a', 'b', 'c', 'd', 'e', 'f', 'h']) {
  await win(L[k]);
  await sleep(400);
}
await sleep(6000);

// Bekor qilish
const cur = must(await head.call('GET', `/api/v1/orders/${L.of.id}`), 'order').order;
must(await head.call('PATCH', `/api/v1/orders/${L.of.id}`, { version: cur.version, fulfillmentState: 'cancelled' }), 'cancel', [200]);

// To'lovlar va MIJOZGA qaytarimlar
const pay = async (id, kind, amount, key) => must(await head.call('POST', `/api/v1/orders/${id}/payments`, { kind, amount, currency: 'USD', receivedAt: new Date().toISOString(), method: 'bank_transfer' }, { 'idempotency-key': key }), `${kind} ${amount}`, [201]);
await pay(L.oa.id, 'payment', '1200.00', `demo-pa-${tag}`);
await pay(L.oa.id, 'refund', '200.00', `demo-ra-${tag}`); // qisman qaytarim
await pay(L.oh.id, 'payment', '600.00', `demo-p-${tag}`);
await pay(L.oh.id, 'refund', '600.00', `demo-r-${tag}`); // to'liq qaytarim

// YETKAZIB BERUVCHIDAN qaytgan summa (mijoz qaytarimidan alohida)
must(await head.call('POST', `/api/v1/orders/${L.oh.id}/supplier-refunds`, { amount: '500.00', currency: 'USD', receivedAt: new Date().toISOString(), reference: 'ANX-CR-001', note: 'Safar bekor qilindi: to‘liq qaytarim' }, { 'idempotency-key': `demo-sr-${tag}` }), 'supplier refund', [201]);
must(await head.call('POST', `/api/v1/orders/${L.oa.id}/supplier-refunds`, { amount: '100.00', currency: 'USD', receivedAt: new Date().toISOString(), reference: 'ANX-CR-002', note: 'Qisman qaytarim' }, { 'idempotency-key': `demo-sr2-${tag}` }), 'supplier refund 2', [201]);

// Buyurtma operatorini alohida, sabab va audit bilan o'zgartirish (lid operatori emas)
const ob = must(await head.call('GET', `/api/v1/orders/${L.ob.id}`), 'order').order;
must(await head.call('PATCH', `/api/v1/orders/${L.ob.id}`, { version: ob.version, tourOperatorId: pegas.id, tourOperatorReason: 'Mijoz Pegas paketiga o‘tdi (demo)' }), 'operator change', [200]);

console.log(JSON.stringify({ orders: Object.fromEntries(Object.entries(L).filter(([k]) => k.startsWith('o')).map(([k, v]) => [k, v.orderNo])), tag }));
console.log('Tayyor. Demo muhit:', U, '(rahbar@demo.local / Demo-parol-2026!)');
