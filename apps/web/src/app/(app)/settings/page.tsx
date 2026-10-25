'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Icon, type IconName } from '../../../components/icons';
import { api, useApi, type ApiError } from '../../../lib/api';
import { Async, FormError, Section } from '../../../components/ui';

interface Rule {
  id: string;
  milestone: string;
  offsetSeconds: number;
  enabled: boolean;
  version: number;
  escalateAfterMinutes: number;
}

export default function SettingsPage() {
  const state = useApi<{ items: Rule[] }>('/api/v1/reminder-rules');
  const [error, setError] = useState<ApiError | null>(null);
  const save = async (r: Rule, patch: Partial<Rule>) => {
    setError(null);
    try {
      await api(`/api/v1/reminder-rules/${encodeURIComponent(r.milestone)}`, { method: 'PATCH', body: patch });
      await state.reload();
    } catch (e) {
      setError(e as ApiError);
    }
  };
  return (
    <>
      <h1>Настройки</h1>
      <div className="settings-hub">
        {(
          [
            ['/suppliers', 'suppliers', 'Туроператоры', 'Список туроператоров для блока «Продажа»'],
            ['/users', 'users', 'Пользователи', 'Сотрудники, роли, доступ к себестоимости'],
            ['/integrations', 'integrations', 'Интеграции', 'Instagram Direct и рекламные формы'],
          ] as Array<[string, IconName, string, string]>
        ).map(([href, icon, title, text]) => (
          <Link key={href} href={href} className="settings-card">
            <Icon name={icon} size={22} />
            <span>
              <strong>{title}</strong>
              <span className="muted">{text}</span>
            </span>
          </Link>
        ))}
      </div>
      <FormError error={error} />
      <Section title="Дополнительно: правила напоминаний для заказов с сегментами рейсов (напоминание из блока «Продажа» — за 3 дня до вылета или в своё время)">
        <Async state={state}>
          {(d) => (
            <table>
              <thead>
                <tr>
                  <th>Этап</th>
                  <th>За сколько часов до вылета</th>
                  <th>Эскалация (мин.)</th>
                  <th>Включено</th>
                  <th>Версия</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((r) => (
                  <tr key={r.id}>
                    <td>{r.milestone}</td>
                    <td>
                      <input type="number" min={1} defaultValue={r.offsetSeconds / 3600} onBlur={(e) => Number(e.target.value) * 3600 !== r.offsetSeconds && save(r, { offsetSeconds: Number(e.target.value) * 3600 })} aria-label={`${r.milestone}: часы`} />
                    </td>
                    <td>
                      <input type="number" min={1} defaultValue={r.escalateAfterMinutes} onBlur={(e) => Number(e.target.value) !== r.escalateAfterMinutes && save(r, { escalateAfterMinutes: Number(e.target.value) })} aria-label={`${r.milestone}: эскалация`} />
                    </td>
                    <td>
                      <input type="checkbox" style={{ width: 'auto' }} checked={r.enabled} onChange={(e) => save(r, { enabled: e.target.checked })} aria-label={`${r.milestone}: включено`} />
                    </td>
                    <td>v{r.version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Async>
      </Section>
      <Section title="Настройки компании">
        <p className="muted">
          График работы, срок ответа (SLA), дежурный ответственный, правило телефонов и политика хранения пока меняются администратором через базу данных.
        </p>
      </Section>
    </>
  );
}
