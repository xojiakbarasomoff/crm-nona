import { describe, expect, it } from 'vitest';
import { fmtDate, fmtDateTime, parseDmy } from '../src/lib/api';

describe('sana-vaqt formati (Asia/Tashkent)', () => {
  it('«HH:mm · DD.MM.YYYY» va «DD.MM.YYYY»; sana-only qiymat siljimaydi; noto‘g‘ri/bo‘sh qiymat «—»', () => {
    expect(fmtDateTime('2026-10-25T13:36:00.000Z')).toBe('18:36 · 25.10.2026');
    expect(fmtDate('2026-10-25T13:36:00.000Z')).toBe('25.10.2026');
    // Toshkent yarim kechasi: 24.10 19:00Z = 25.10 00:00
    expect(fmtDateTime('2026-10-24T19:00:00.000Z')).toBe('00:00 · 25.10.2026');
    expect(fmtDateTime('2026-10-24T18:59:59.000Z')).toBe('23:59 · 24.10.2026');
    expect(fmtDate('2026-03-05')).toBe('05.03.2026');
    expect(fmtDateTime(null)).toBe('—');
    expect(fmtDateTime('xato')).toBe('—');
    expect(fmtDate(undefined)).toBe('—');
  });
  it('DD.MM.YYYY kiritish: haqiqiy kalendar sanasi ISO ga, aks holda null', () => {
    expect(parseDmy('25.10.2026')).toBe('2026-10-25');
    expect(parseDmy('29.02.2028')).toBe('2028-02-29');
    expect(parseDmy('29.02.2026')).toBeNull();
    expect(parseDmy('31.04.2026')).toBeNull();
    expect(parseDmy('2026-10-25')).toBeNull();
    expect(parseDmy('1.1.2026')).toBeNull();
    expect(parseDmy('')).toBeNull();
  });
});
