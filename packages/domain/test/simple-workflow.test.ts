import { describe, expect, it } from 'vitest';
import { can, channelsOfSourceGroup, LEAD_STATUSES, sourceGroupOf, STAGES, stageOfStatus, statusOfStage, userWriteAllowed } from '../src';

describe('упрощённый статус лида', () => {
  it('каждый прежний этап отображается в один из 5 статусов; промежуточные — «В работе»', () => {
    expect(STAGES.map((s) => [s, statusOfStage(s)])).toEqual([
      ['NEW', 'NEW'],
      ['CONTACTED', 'IN_PROGRESS'],
      ['QUALIFIED', 'IN_PROGRESS'],
      ['PREPARING_OFFER', 'IN_PROGRESS'],
      ['OFFER_SENT', 'IN_PROGRESS'],
      ['AWAITING_PAYMENT', 'IN_PROGRESS'],
      ['WON', 'SOLD'],
      ['LOST', 'CANCELLED'],
      ['FOLLOW_UP', 'IN_PROGRESS'],
      ['NO_ANSWER', 'NO_ANSWER'],
    ]);
  });
  it('статус → этап → статус без потерь', () => {
    for (const s of LEAD_STATUSES) expect(statusOfStage(stageOfStatus(s))).toBe(s);
  });
  it('источник: Instagram Direct / Реклама / Вручную', () => {
    expect(sourceGroupOf('instagram_direct')).toBe('DIRECT');
    expect(sourceGroupOf('meta_lead_ads')).toBe('ADS');
    expect(sourceGroupOf('instagram_lead_ads')).toBe('ADS');
    expect(sourceGroupOf('manual')).toBe('MANUAL');
    expect(channelsOfSourceGroup('ADS')).toEqual(['instagram_lead_ads', 'meta_lead_ads']);
  });
});

describe('Пользователь: разрешённые изменения', () => {
  const id = '0b0c7e7e-1111-4222-8333-444455556666';
  it('создание лида, контакт и основные данные своего лида, выход', () => {
    expect(userWriteAllowed('POST', '/leads')).toBe(true);
    expect(userWriteAllowed('PATCH', `/leads/${id}/contact`)).toBe(true);
    expect(userWriteAllowed('PATCH', `/leads/${id}/basics`)).toBe(true);
    expect(userWriteAllowed('POST', '/auth/logout')).toBe(true);
  });
  it('статус, продажа, ответ, переназначение и настройки — нет', () => {
    for (const [m, p] of [
      ['PATCH', `/leads/${id}/status`],
      ['PUT', `/leads/${id}/sale`],
      ['POST', `/leads/${id}/messages`],
      ['PATCH', `/leads/${id}/assignee`],
      ['PATCH', `/leads/${id}`],
      ['POST', '/suppliers'],
      ['POST', `/users/${id}/block`],
      ['POST', '/leads/x/../../users'],
    ] as const) {
      expect(userWriteAllowed(m, p), `${m} ${p}`).toBe(false);
    }
    expect(can('USER', 'leads.work')).toBe(false);
    expect(can('MANAGER', 'leads.work')).toBe(true);
  });
});
