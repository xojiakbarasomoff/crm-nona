'use client';

import { useRef, useState } from 'react';
import { api, ApiError, fmtDateTime, useApi } from '../lib/api';
import { DOC_CATEGORY_LABELS } from '../lib/format';
import { Badge, FormError, Section } from './ui';

interface Att {
  id: string;
  ownerType: string;
  ownerId: string;
  ownerLabel: string | null;
  category: string;
  fileName: string;
  mime: string;
  size: number;
  scanState: 'pending' | 'clean' | 'infected' | 'error';
  createdAt: string;
}

export interface DocOwner {
  type: 'order' | 'lead' | 'offer' | 'contact' | 'passenger';
  id: string;
  label: string;
}

function csrf() {
  return decodeURIComponent(document.cookie.match(/(?:^|;\s*)crm_csrf=([^;]+)/)?.[1] ?? '');
}

/**
 * Hujjatlar: kategoriya bo'yicha guruhlanadi va mijoz / buyurtma / yo'lovchiga bog'lanadi.
 * Private storage, virus tekshiruvi (skandan o'tmaguncha ochilmaydi), qisqa muddatli yuklab olish havolasi — backend'da.
 * `owners` — yuklashda tanlanadigan bog'lanish ob'ektlari; birinchisi — asosiy (ro'yxat shu ob'ekt bo'yicha olinadi).
 */
export function Attachments({ ownerType, ownerId, owners, title = 'Fayllar' }: { ownerType: DocOwner['type']; ownerId: string; owners?: DocOwner[]; title?: string }) {
  const targets: DocOwner[] = owners?.length ? owners : [{ type: ownerType, id: ownerId, label: 'Shu obyekt' }];
  const related = ownerType === 'order' && targets.length > 1;
  const q = `ownerType=${ownerType}&ownerId=${ownerId}${related ? '&related=1' : ''}`;
  const state = useApi<{ items: Att[] }>(`/api/v1/attachments?${q}`, { pollMs: 10_000 });
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState('other');
  const [target, setTarget] = useState(0);

  const uploadFile = async (file: File) => {
    setBusy(true);
    setError(null);
    const t = targets[target] ?? targets[0]!;
    try {
      const res = await fetch(`/api/v1/attachments?ownerType=${t.type}&ownerId=${t.id}&category=${category}`, {
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

  const items = state.data?.items ?? [];
  const groups = Object.keys(DOC_CATEGORY_LABELS).map((c) => [c, items.filter((a) => a.category === c)] as const).filter(([, list]) => list.length > 0);

  return (
    <Section title={title}>
      <p className="muted">PDF, rasm, DOCX, XLSX; 10 MB gacha. Fayl tekshiruvdan o‘tmaguncha ochilmaydi. Pasport nusxasi ommaviy ochilmaydi.</p>
      <div className="row">
        <label className="field">
          <span className="field-label">Hujjat turi</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Hujjat turi">
            {Object.entries(DOC_CATEGORY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {targets.length > 1 && (
          <label className="field">
            <span className="field-label">Kimga tegishli</span>
            <select value={target} onChange={(e) => setTarget(Number(e.target.value))} aria-label="Kimga tegishli">
              {targets.map((t, i) => (
                <option key={`${t.type}:${t.id}`} value={i}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="btn secondary" style={{ display: 'inline-block' }}>
          {busy ? 'Yuklanmoqda…' : 'Fayl yuklash'}
          <input ref={input} type="file" aria-label="Fayl yuklash" style={{ display: 'none' }} accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx" onChange={(e) => e.target.files?.[0] && void uploadFile(e.target.files[0])} />
        </label>
      </div>
      <FormError error={error} />
      {groups.length === 0 && <div className="state empty">Hujjat yuklanmagan</div>}
      {groups.map(([cat, list]) => (
        <div key={cat} className="doc-group">
          <h3 className="doc-title">
            <span className={`doc-cat ${cat}`}>{DOC_CATEGORY_LABELS[cat]}</span>
          </h3>
          <table>
            <tbody>
              {list.map((a) => (
                <tr key={a.id}>
                  <td>
                    {cat === 'passport' ? 'Pasport nusxasi' : a.fileName}
                    {a.ownerLabel && related && <div className="muted">{a.ownerLabel}</div>}
                  </td>
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
                    <select
                      aria-label={`Hujjat turini o‘zgartirish: ${cat === 'passport' ? 'pasport' : a.fileName}`}
                      value={a.category}
                      onChange={async (e) => {
                        try {
                          await api(`/api/v1/attachments/${a.id}`, { method: 'PATCH', body: { category: e.target.value } });
                          await state.reload();
                        } catch (er) {
                          setError(er as ApiError);
                        }
                      }}
                      style={{ width: 'auto', marginLeft: 8 }}
                    >
                      {Object.entries(DOC_CATEGORY_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn small secondary"
                      onClick={async () => {
                        if (!window.confirm(`«${cat === 'passport' ? 'Pasport nusxasi' : a.fileName}» o‘chirilsinmi?`)) return;
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
        </div>
      ))}
    </Section>
  );
}
