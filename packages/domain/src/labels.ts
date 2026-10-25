/** Русские подписи значений для выгрузок (CSV) и сообщений сервера. Интерфейс использует те же формулировки. */
export const SOURCE_LABELS_RU: Record<string, string> = {
  instagram_lead_ads: 'Instagram Lead Ads',
  meta_lead_ads: 'Meta Lead Ads (место неизвестно)',
  instagram_direct: 'Instagram Direct',
  amocrm: 'Прежняя система',
  manual: 'Добавлен вручную',
  other: 'Другое',
};

export const SERVICE_TYPE_LABELS_RU: Record<string, string> = {
  avia: 'Авиабилеты',
  tour_package: 'Турпакет',
  hotel: 'Отель',
  transfer: 'Трансфер',
  visa: 'Виза',
  other: 'Другое',
};

export const FULFILLMENT_LABELS_RU: Record<string, string> = {
  draft: 'Черновик',
  confirmed: 'Подтверждён',
  in_progress: 'В работе',
  completed: 'Завершён',
  cancelled: 'Отменён',
};

export const PAYMENT_LABELS_RU: Record<string, string> = {
  unpaid: 'Не оплачен',
  partial: 'Оплачен частично',
  paid: 'Оплачен',
  refund_pending: 'Возврат ожидается',
  refunded: 'Возвращён',
};
