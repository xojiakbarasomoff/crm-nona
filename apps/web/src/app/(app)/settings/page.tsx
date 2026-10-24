'use client';

import { useState } from 'react';
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
      <h1>Sozlamalar</h1>
      <FormError error={error} />
      <Section title="Reys eslatmalari qoidalari (versiyalanadi; faqat kelajakdagi eslatmalar qayta rejalanadi)">
        <Async state={state}>
          {(d) => (
            <table>
              <thead>
                <tr>
                  <th>Milestone</th>
                  <th>Jo‘nashdan oldin (soat)</th>
                  <th>Eskalatsiya (daq)</th>
                  <th>Yoqilgan</th>
                  <th>Versiya</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((r) => (
                  <tr key={r.id}>
                    <td>{r.milestone}</td>
                    <td>
                      <input type="number" min={1} defaultValue={r.offsetSeconds / 3600} onBlur={(e) => Number(e.target.value) * 3600 !== r.offsetSeconds && save(r, { offsetSeconds: Number(e.target.value) * 3600 })} aria-label={`${r.milestone} soat`} />
                    </td>
                    <td>
                      <input type="number" min={1} defaultValue={r.escalateAfterMinutes} onBlur={(e) => Number(e.target.value) !== r.escalateAfterMinutes && save(r, { escalateAfterMinutes: Number(e.target.value) })} aria-label={`${r.milestone} eskalatsiya`} />
                    </td>
                    <td>
                      <input type="checkbox" style={{ width: 'auto' }} checked={r.enabled} onChange={(e) => save(r, { enabled: e.target.checked })} aria-label={`${r.milestone} yoqilgan`} />
                    </td>
                    <td>v{r.version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Async>
      </Section>
      <Section title="Kompaniya sozlamalari">
        <p className="muted">
          Ish jadvali, SLA, sticky owner, navbatchi mas’ul, telefon qoidasi va retention siyosati hozircha seed/DB orqali boshqariladi. Tasdiqlanmagan qiymatlar KNOWN_LIMITATIONS.md da qayd etilgan.
        </p>
      </Section>
    </>
  );
}
