'use client';

import { useRef, useState } from 'react';
import { api, ApiError, fmtDateTime, useApi } from '../lib/api';
import { Badge, FormError, Section } from './ui';

interface Att {
  id: string;
  fileName: string;
  mime: string;
  size: number;
  scanState: 'pending' | 'clean' | 'infected' | 'error';
  createdAt: string;
}

function csrf() {
  return decodeURIComponent(document.cookie.match(/(?:^|;\s*)crm_csrf=([^;]+)/)?.[1] ?? '');
}

/** Files of an order/lead: upload (raw body), virus-scan state, signed short-lived download. */
export function Attachments({ ownerType, ownerId }: { ownerType: 'order' | 'lead' | 'offer'; ownerId: string }) {
  const q = `ownerType=${ownerType}&ownerId=${ownerId}`;
  const state = useApi<{ items: Att[] }>(`/api/v1/attachments?${q}`, { pollMs: 10_000 });
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const uploadFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/attachments?${q}`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-CSRF-Token': csrf() },
        body: file,
        credentials: 'same-origin',
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? 'ERROR', body?.error?.message ?? `Xato ${res.status}`, body?.error?.field_errors ?? {});
      await state.reload();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <Section title="Fayllar">
      <p className="muted">PDF, PNG, JPEG, WEBP, DOCX, XLSX; 10 MB gacha. Fayl virus tekshiruvidan o‘tmaguncha ochilmaydi.</p>
      <label className="btn secondary" style={{ display: 'inline-block' }}>
        {busy ? 'Yuklanmoqda…' : 'Fayl yuklash'}
        <input ref={input} type="file" aria-label="Fayl yuklash" style={{ display: 'none' }} accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx" onChange={(e) => e.target.files?.[0] && void uploadFile(e.target.files[0])} />
      </label>
      <FormError error={error} />
      <table>
        <tbody>
          {(state.data?.items ?? []).map((a) => (
            <tr key={a.id}>
              <td>{a.fileName}</td>
              <td className="muted">{Math.ceil(a.size / 1024)} KB</td>
              <td>{fmtDateTime(a.createdAt)}</td>
              <td>
                {a.scanState === 'clean' && <Badge tone="ok">Tekshirildi</Badge>}
                {a.scanState === 'pending' && <Badge tone="info">Virus tekshiruvi kutilmoqda</Badge>}
                {a.scanState === 'infected' && <Badge tone="bad">Zararli — bloklangan</Badge>}
                {a.scanState === 'error' && <Badge tone="warn">Tekshiruv xatosi</Badge>}
              </td>
              <td>
                {a.scanState === 'clean' && (
                  <button
                    type="button"
                    className="btn small"
                    onClick={async () => {
                      try {
                        const r = await api<{ url: string }>(`/api/v1/attachments/${a.id}/link`, { method: 'POST' });
                        window.location.href = r.url;
                      } catch (e) {
                        setError(e as ApiError);
                      }
                    }}
                  >
                    Yuklab olish
                  </button>
                )}
                <button
                  type="button"
                  className="btn small secondary"
                  onClick={async () => {
                    if (!window.confirm(`«${a.fileName}» o‘chirilsinmi?`)) return;
                    try {
                      await api(`/api/v1/attachments/${a.id}`, { method: 'DELETE' });
                      await state.reload();
                    } catch (e) {
                      setError(e as ApiError);
                    }
                  }}
                >
                  O‘chirish
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
