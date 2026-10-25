# Foydalanish yo‘riqnomasi: turoperatorlar, narx va foyda, hujjatlar

Bu yo‘riqnoma NONA Travel CRM’dagi yangi imkoniyatlar uchun. Demo rejimda ma’lumotlar sun’iy.

## 1. Turoperator tanlash (menejer, rahbar)

1. **Lidlar** → lidni oching. O‘ng tomondagi **Turoperator** bo‘limida ro‘yxatdan tanlang.
2. Esda tuting: **«Manba»** (masalan, Instagram Ads) — mijoz qayerdan kelgan; **turoperator** — xizmatni kim yetkazadi. Ular alohida.
3. Ro‘yxatda kerakli turoperator bo‘lmasa, rahbarga ayting: u **Turoperatorlar** bo‘limida yangisini yaratadi.

## 2. Narx va foyda (buyurtma kartasi)

1. Lid kartasida **Buyurtma yaratish** → buyurtma kartasi ochiladi.
2. **Turpaket, turoperator va narx** bo‘limida: **Sotuv narxi** (mijozga), **Tannarx** (turoperatordan), **Valyuta** → **Saqlash**.
3. **Foyda avtomatik hisoblanadi** (maydonga qo‘lda yozilmaydi): `Foyda = sotuv narxi − tannarx`. Manfiy bo‘lsa, qizil rangda ko‘rsatiladi.
4. **Tannarxni bilmasangiz, bo‘sh qoldiring.** Tizim uni 0 deb hisoblamaydi: foyda «**Aniqlanmagan**» bo‘ladi va dashboard’da bunday buyurtmalar soni ko‘rinadi.
5. «**Foyda hisobi**» jadvali valyutalar bo‘yicha alohida: USD va so‘m bir-biriga qo‘shilmaydi.

> **Eslatma.** Foyda qo‘shimcha xarajatlarni (komissiya, soliq, bank to‘lovlari, valyuta farqi) hisobga olmaydi. Bu buxgalteriya bo‘yicha yakuniy «sof foyda» emas.

## 3. Xizmatlar: mehmonxona, transfer va boshqalar

**Xizmatlar** bo‘limida «Yangi xizmat qatori»:

- **Mehmonxona:** nomi, manzil, kirish/chiqish sanasi (chiqish kirishdan keyin), xona turi, ovqatlanish turi (RO, BB, HB, FB, AI, UAI).
- **Transfer:** yo‘nalish, sana va vaqt, transport.
- Har bir qatorda: yetkazib beruvchi, sotuv narxi, tannarx, valyuta.
- **«Paket narxiga kiritilgan»** belgisi: agar xizmat turpaket narxiga allaqachon kiritilgan bo‘lsa, belgilang — u jamiga **ikkinchi marta qo‘shilmaydi**. Paketdan tashqari xizmat (masalan, viza) belgilanmaydi va jamiga qo‘shiladi.
- Qatorni **Tahrirlash** yoki **Olib tashlash** mumkin. Narx o‘zgarishlari «O‘zgarishlar tarixi»ga eski va yangi qiymat bilan yoziladi.
- Aviachipta va reyslar — **Reys segmentlari** bo‘limida (ko‘p segmentli).

Paket narxi bo‘lmasa ham bo‘ladi: u holda jami — narxli xizmatlar yig‘indisi.

## 4. Hujjatlar

**Hujjatlar** bo‘limida: **Hujjat turi** (pasport, hisob-faktura, to‘lov cheki, aviachipta, vaucher, boshqa) va **Kimga tegishli** (buyurtma, yo‘lovchi yoki mijoz) ni tanlab, **Fayl yuklash**.

- Fayl virus tekshiruvidan o‘tgach «Tekshirildi» bo‘ladi va yuklab olish mumkin; yuklab olish havolasi qisqa muddatli va faqat sizga tegishli.
- **Pasport** faqat PDF yoki rasm; ro‘yxatda «Pasport nusxasi» deb ko‘rsatiladi. Uni faqat o‘z mijozingiz/buyurtmangiz doirasida ko‘rasiz.
- Noto‘g‘ri turda yuklangan bo‘lsa, qatordagi ro‘yxatdan turini o‘zgartiring.

## 5. Dashboard (rahbar, administrator; menejer — faqat o‘z doirasi)

**Boshqaruv paneli** → **Moliya: sotuv, tannarx va foyda**:

- **Jami sotuv summasi**, **Jami tannarx**, **Hisoblangan foyda** (marja bilan), **Foyda aniqlanmagan** buyurtmalar soni — valyuta bo‘yicha.
- **Kutilayotgan foyda** — hali yopilmagan (ochiq) buyurtmalardan; bu tasdiqlangan foyda emas.
- **Turoperatorlar kesimida** va **Menejerlar kesimida**.
- Filtrlar: davr, manba, **turoperator**, **valyuta**, kesim. Eksport: **Buyurtmalar CSV (foyda)** (rahbar/administrator).

Qoidalar (qisqa; to‘liq matn — «Hisoblash qoidalari»):
- Tasdiqlangan sotuv — davrda «Sotuv yakunlandi» bo‘lgan lidlarning bekor qilinmagan buyurtmalari.
- **Bekor qilingan** buyurtma jamiga kirmaydi, lekin summalari tarixda saqlanadi va alohida ko‘rsatiladi.
- Qaytarim **dastlabki foydani** o‘zgartirmaydi; u **«Qaytarimdan keyingi foyda»**da alohida ko‘rinadi (mijozga qaytarim va yetkazib beruvchidan qaytgan summa alohida qayd etiladi).
- Tannarxi kiritilmagan buyurtma tannarx va foyda jamiga kirmaydi (0 emas), faqat sotuv jamiga kiradi.

## 6. Turoperatorlar ma’lumotnomasi (rahbar, administrator)

**Turoperatorlar** bo‘limi: nom, turi, mas’ul shaxs, telefon, email, izoh. **Arxivlash** — yangi tanlovdan chiqaradi, lekin eski buyurtmalar va narxlar o‘zgarmaydi. Menejerlar faqat nomlarni ko‘radi (aloqa ma’lumotlarisiz).

## 7. Demo

Mahalliy demoda sun’iy turoperatorlar («… (demo)») va buyurtmalar bor. Kirish: `rahbar@demo.local` / `Demo-parol-2026!` (lokal), yoki Railway demosida `user1` / `123123123`. Demo ma’lumotlar production’da ishlamaydi.

## 8. Qaytarimlar va operator o‘zgartirish (yangi)

- **Mijozga qaytarim:** buyurtma kartasi → «Mijoz to‘lovlari» → tur «Qaytarim». Valyuta buyurtma valyutasi bilan bir xil, summa to‘langandan oshmasin.
- **Yetkazib beruvchidan qaytgan summa:** «Yetkazib beruvchidan qaytgan summa» bo‘limi (faqat tannarxni ko‘ra oladiganlarga). Mijoz qaytarimi bilan aralashtirmang.
- **Foyda:** dastlabki foyda = sotuv − tannarx. Qaytarimdan keyingi foyda = (sotuv − mijozga qaytarilgan) − (tannarx − yetkazib beruvchidan qaytgan). Bu buxgalteriya «sof foydasi» emas.
- **Turoperator:** buyurtma yaratilganda lidnikidan nusxalanadi va buyurtma bilan qoladi. Buyurtma bor lidda operatorni lid kartasida o‘zgartirib bo‘lmaydi; buyurtma kartasida o‘zgartiring (tasdiqlangan buyurtmada sabab shart, auditga yoziladi). Eski sotuvlar statistikasi lid o‘zgarishidan ta’sirlanmaydi.
- **Tannarx va foydani ko‘rish ruxsati:** rahbar va administratorda bor. Administrator menejerga «Foydalanuvchilar» sahifasida «Tannarx va foyda → Ko‘ra oladi» orqali yoqadi. Ruxsatsiz foydalanuvchi buyurtma, dashboard va eksportda faqat sotuv va mijoz qaytarimini ko‘radi.
- **Demo:** sun’iy ma’lumotlar faqat alohida demo muhitda (`npm run demo:finance:setup`, `:start`, `:data`; web http://localhost:3101).
