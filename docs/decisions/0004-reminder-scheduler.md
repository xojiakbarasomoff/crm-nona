# ADR 0004 — Eslatma scheduler’i

Sana: 2026-10-24 · Holat: qabul qilingan · TZ: §14, §19.1

## Qaror

- `reminder_occurrences` — yagona haqiqat manbai. Redis/BullMQ faqat transport.
- Avtomatik occurrence unique kaliti: `(company_id, segment_id, schedule_revision, rule_version, milestone)`.
- Scheduler sikli (worker ichida, default 15s, maks 30s):
  1. `UPDATE ... SET state='dispatching', lease_until=now()+interval, lease_owner=$worker WHERE id IN (SELECT id FROM reminder_occurrences WHERE state IN ('scheduled','dispatching') AND due_at <= now() AND (lease_until IS NULL OR lease_until < now()) ORDER BY due_at LIMIT N FOR UPDATE SKIP LOCKED) RETURNING ...`
  2. Har bir claim qilingan occurrence uchun **qayta tekshiruv**: segment `schedule_revision` = occurrence `schedule_revision`, segment faol, order bekor emas, occurrence bekor emas. Mos kelmasa → `superseded`/`cancelled`, yon ta’sir yo‘q (AC21).
  3. Mos bo‘lsa bitta tranzaksiyada: `state='due'`, ilova bildirishnomasi (`notifications`), har kanal uchun `notification_deliveries` (unique `occurrence_id + channel`), CRM task uchun outbox operatsiyasi (unique `operation_key`).
- Process uzilsa `lease_until` o‘tgach yozuv qayta claim qilinadi; yon ta’sirlar unique kalitlar bilan idempotent (AC25).
- Jo‘nash vaqti o‘tgan va bajarilmagan occurrence → `missed`, qayta yuborilmaydi.
- Kech kiritilgan order: o‘tib ketgan milestone’lar o‘rniga bitta `URGENT` occurrence (AC19).
- Eskalatsiya: `due` holatida T-3h uchun 15 daqiqa, boshqalar 60 daqiqa → rahbar/navbatchiga `escalated_at` bilan bildirishnoma; ish vaqtiga qaramaydi.
- Qo‘lda eslatmalar ham shu jadvalda (`kind='manual'`), takrorlanish `daily|weekly` + `until` yoki `max_count` majburiy.

## Rad etilgan

- BullMQ delayed job’lari yagona jadval sifatida: Redis yo‘qolishi yoki revision o‘zgarishida eski ishlar ishonchsiz (TZ §14.4).
