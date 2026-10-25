/**
 * Maxfiylik siyosati (ommaviy, kirish talab qilmaydi). Meta ilovasi uchun «Privacy Policy URL».
 * Matn kod va konfiguratsiyadan olingan faktlarga tayanadi. Kompaniya rekvizitlari, aloqa manzili va saqlash muddatlari
 * KIRITILMAGAN (noma'lum): ular `COMPANY` va `RETENTION` ichida null bo'lib turadi va sahifada ochiq «kiritilishi kerak» deb ko'rinadi.
 * Ularni tasdiqlangan qiymatlar bilan to'ldirmaguncha sahifa nashrga tayyor hisoblanmaydi.
 */
// Tasdiqlangan (foydalanuvchi bergan): brend nomi, tuman, Instagram akkaunti. Yuridik nom, shahar, telefon, email — NOMA'LUM, kiritilmagan.
const COMPANY: { brand: string; legalName: string | null; district: string; city: string | null; instagram: string; phone: string | null; email: string | null } = {
  brand: 'NONA Travel',
  legalName: null,
  district: 'Mirzo Ulug‘bek tumani',
  city: null,
  instagram: '@nonatravel.uz',
  phone: null,
  email: null,
};
const RETENTION: { messageContentMonths: number | null; rawWebhookDays: number | null; technicalLogDays: number | null } = { messageContentMonths: null, rawWebhookDays: null, technicalLogDays: null };

const TBD = (what: string) => <mark>[{what} — kompaniya tomonidan kiritilishi kerak]</mark>;

export const metadata = { title: 'Maxfiylik siyosati — NONA Travel CRM' };

export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 760, margin: '40px auto', padding: '0 16px', lineHeight: 1.6 }}>
      <h1>Maxfiylik siyosati</h1>
      <p>
        Ushbu siyosat «NONA Travel CRM» tizimi (keyingi o‘rinlarda — «Tizim») Instagram Direct orqali kelgan murojaatlarni qabul qilish va qayta ishlashda qanday shaxsiy ma’lumotlarni
        olishini, qayerda ishlatishini, kimlar ko‘rishini va ularni o‘chirishni qanday so‘rash mumkinligini tushuntiradi.
      </p>

      <h2>1. Ma’lumotlar egasi</h2>
      <ul>
        <li>Brend nomi: {COMPANY.brand}</li>
        <li>Yuridik nomi: {COMPANY.legalName ?? TBD('kompaniyaning yuridik nomi')}</li>
        <li>Manzil: {COMPANY.district}, {COMPANY.city ?? TBD('shahar')}</li>
        <li>Instagram: {COMPANY.instagram}</li>
        <li>Telefon / email: {COMPANY.phone || COMPANY.email ? [COMPANY.phone, COMPANY.email].filter(Boolean).join(' · ') : TBD('telefon yoki email (ixtiyoriy, hozircha ko‘rsatilmagan)')}</li>
      </ul>

      <h2>2. Qanday ma’lumotlar olinadi</h2>
      <p>
        <b>Kompaniyaning Instagram akkaunti (ulanish vaqtida).</b> Kompaniya akkaunti egasi Instagram’ning rasmiy avtorizatsiya oynasida ruxsat beradi. Tizim akkauntning professional ID raqamini, foydalanuvchi nomini va akkaunt turini oladi,
        shuningdek Instagram bergan kirish tokenini saqlaydi. Parol Tizimga hech qachon kiritilmaydi. Token ma’lumotlar bazasida shifrlangan holda saqlanadi.
      </p>
      <p>
        <b>Instagram Direct orqali yozgan shaxslar.</b> Kompaniya akkauntiga Direct xabar yozilganda Tizim Meta’dan quyidagilarni oladi: yuboruvchining Instagram doirasidagi identifikatori, (agar berilsa) foydalanuvchi nomi, xabar matni, biriktirilgan
        fayllar haqida ma’lumot, xabar vaqti va (reklamadan kelgan bo‘lsa) reklama identifikatori. Xabarlarning o‘qilganligi haqidagi belgilar ham qabul qilinadi.
      </p>
      <p>
        <b>Mijoz kartasi.</b> Murojaat asosida Tizim kontakt va lid yozuvini yaratadi. Mijoz yoki xodim keyinchalik ism, telefon, email, sayohat talablari, yo‘lovchilar ma’lumoti, buyurtma va to‘lov yozuvlarini qo‘shishi mumkin.
      </p>

      <h2>3. Nima uchun ishlatiladi</h2>
      <ul>
        <li>kelgan murojaatni qabul qilish, kontakt/lidga bog‘lash va mas’ul menejerga biriktirish;</li>
        <li>mijozga javob berish (hozirgi holatda javob yuborish ulangan amoCRM chat kanaliga bog‘liq; u ulanmaguncha Tizimdan javob yuborilmaydi);</li>
        <li>javob berish muddatlarini (SLA) nazorat qilish, takroriy murojaatlarni aniqlash, eslatmalar yuborish;</li>
        <li>tur buyurtmalari, to‘lovlar va hisob yozuvlarini yuritish.</li>
      </ul>

      <h2>4. Kimlar ko‘radi</h2>
      <ul>
        <li>Kompaniyaning Tizimga kirgan xodimlari, rollariga qarab: menejer — o‘ziga biriktirilgan murojaatlar; savdo rahbari va administrator — kengroq ko‘lamda. Tannarx va foyda ma’lumotlari alohida ruxsat bilan ochiladi.</li>
        <li>Tizimdagi muhim amallar (masalan, ma’lumotni o‘chirish, ruxsat o‘zgartirish) audit jurnaliga yoziladi.</li>
        <li>
          Texnik xizmat ko‘rsatuvchilar: Tizim bulutli infratuzilmada (Railway: ilova, PostgreSQL va Redis) ishlaydi, Instagram ma’lumotlari esa Meta Platforms orqali keladi. Kompaniya amoCRM bilan integratsiyani yoqsa, murojaat va kontakt
          ma’lumotlari amoCRM’ga ham uzatilishi mumkin; hozir bu integratsiya ulanmagan. {TBD('boshqa xizmat ko‘rsatuvchilar ro‘yxati va ma’lumotlar joylashadigan mamlakat')}
        </li>
      </ul>

      <h2>5. Saqlash muddati</h2>
      <p>
        Saqlash siyosati Tizimda administrator tomonidan tasdiqlanadi; tasdiqlanmaguncha avtomatik tozalash ishlamaydi. Tasdiqlangach xom webhook ma’lumotlari, xabar matnlari va fayllar belgilangan muddat o‘tgach o‘chiriladi
        (to‘lov va buyurtma hisob yozuvlari qonuniy talablar uchun saqlanishi mumkin).
      </p>
      <ul>
        <li>Xabar matni: {RETENTION.messageContentMonths ? `${RETENTION.messageContentMonths} oy` : TBD('xabar matnini saqlash muddati')}</li>
        <li>Xom webhook ma’lumotlari: {RETENTION.rawWebhookDays ? `${RETENTION.rawWebhookDays} kun` : TBD('muddat')}</li>
        <li>Texnik loglar: {RETENTION.technicalLogDays ? `${RETENTION.technicalLogDays} kun` : TBD('muddat')}</li>
      </ul>

      <h2>6. Ma’lumotni o‘chirishni qanday so‘rash mumkin</h2>
      <ol>
        <li>
          <b>Instagram orqali:</b> Instagram sozlamalaridan «NONA Travel CRM» ilovasini olib tashlasangiz, Meta bizga o‘chirish so‘rovi yuboradi. Tizim bu so‘rovni qayd etadi, kompaniya akkaunti ulanishini to‘xtatadi (token o‘chiriladi)
          va administratorga bildirishnoma yuboradi.
        </li>
        <li>
          <b>Instagram Direct orqali:</b> {COMPANY.instagram} akkauntiga xabar yozing va «ma’lumotimni o‘chiring» deb ko‘rsating. Xabar kompaniya akkauntining Direct inbox’iga tushadi; kompaniyani kuzatmaydigan akkauntlardan yozilgan xabarlar «Message requests»
          bo‘limida turadi. Administrator mijoz kartasini topib «Shaxsiy ma’lumotlarni o‘chirish» amalini bajaradi.
        </li>
      </ol>
      <p>
        O‘chirishda ism, telefon, email, Instagram identifikatori va foydalanuvchi nomi, xabar matnlari, biriktirilgan fayllar va yo‘lovchi ma’lumotlari anonimlashtiriladi yoki o‘chiriladi; to‘lov va buyurtma summalari
        hisob yuritish uchun qoladi. amoCRM yoki Instagram’dagi nusxalar administrator tomonidan qo‘lda o‘chiriladi. O‘chirish bo‘yicha so‘rov holati{' '}
        <a href="/data-deletion">/data-deletion</a> sahifasida tushuntirilgan. Javob berish muddati: {TBD('so‘rovga javob berish muddati')}.
      </p>

      <h2>7. Xavfsizlik</h2>
      <p>
        Instagram tokenlari shifrlangan holda saqlanadi, Tizimga kirish rollar bo‘yicha cheklangan, muhim amallar audit jurnaliga yoziladi. Ma’lumotlar HTTPS orqali uzatiladi. Hech bir himoya to‘liq kafolat bermaydi; xavfsizlik hodisalari
        haqida xabar berish uchun yuqoridagi Instagram akkauntiga murojaat qiling.
      </p>

      <h2>8. O‘zgarishlar</h2>
      <p>Siyosat o‘zgarganda ushbu sahifa yangilanadi. Oxirgi tahrir sanasi: {TBD('tasdiqlangan sana')}.</p>
    </main>
  );
}
