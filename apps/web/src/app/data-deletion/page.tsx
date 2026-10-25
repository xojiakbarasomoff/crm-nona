/** Meta "Data deletion request URL" holat sahifasi (ommaviy, kirish talab qilmaydi). Jarayon: /privacy 6-bo'lim. */
export default async function DataDeletionPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code } = await searchParams;
  return (
    <main style={{ maxWidth: 640, margin: '48px auto', padding: '0 16px', lineHeight: 1.6 }}>
      <h1>Ma’lumotni o‘chirish so‘rovi</h1>
      {code && (
        <p>
          So‘rovingiz qabul qilindi. Tasdiqlash kodi: <b>{code.slice(0, 64)}</b>
        </p>
      )}
      <p>Jarayon quyidagicha:</p>
      <ol>
        <li>So‘rov Tizimda qayd etiladi; kompaniyaning Instagram akkauntiga ulanish to‘xtatiladi (kirish tokeni o‘chiriladi).</li>
        <li>Tizim administratorlariga ilova ichida bildirishnoma yuboriladi.</li>
        <li>Administrator mijoz kartasini topib «Shaxsiy ma’lumotlarni o‘chirish» amalini bajaradi: ism, telefon, email, Instagram identifikatori, xabar matnlari va fayllar anonimlashtiriladi yoki o‘chiriladi. To‘lov va buyurtma summalari hisob yuritish uchun saqlanishi mumkin.</li>
        <li>amoCRM va Instagram’dagi nusxalar administrator tomonidan qo‘lda o‘chiriladi.</li>
      </ol>
      <p>
        Bu jarayon avtomatik emas: o‘chirish administrator tomonidan bajariladi. Batafsil ma’lumot va aloqa manzili: <a href="/privacy">Maxfiylik siyosati</a>.
      </p>
    </main>
  );
}
