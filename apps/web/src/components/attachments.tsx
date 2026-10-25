'use client';

import { useRef, useState } from 'react';
import { api, ApiError, fmtDateTime, useApi } from '../lib/api';
import { DOC_CATEGORY_LABELS } from '../lib/format';
import { Badge, FormError, Section } from './ui';
import { canWrite, useMe } from './shell';

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
 * Документы: группируются по категориям и привязываются к клиенту / заказу / пассажиру.
 * Закрытое хранилище, проверка на вирусы (до проверки файл не открывается), короткоживущая ссылка на скачивание — на сервере.
 * `owners` — объекты привязки при загрузке; первый — основной (список берётся по нему).
 */
export function Attachments({ ownerType, ownerId, owners, title = 'Файлы' }: { ownerType: DocOwner['type']; ownerId: string; owners?: DocOwner[]; title?: string }) {
  const me = useMe();
  const writable = canWrite(me);
  const targets: DocOwner[] = owners?.length ? owners : [{ type: ownerType, id: ownerId, label: 'Этот объект' }];
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
      if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? 'ERROR', body?.error?.message ?? `Ошибка ${res.status}`, body?.error?.field_errors ?? {});
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
      <p className="muted">PDF, изображения, DOCX, XLSX; до 10 МБ. Файл не открывается, пока не пройдёт проверку. Копия паспорта не открывается публично.</p>
      {writable && (
      <div className="row">
        <label className="field">
          <span className="field-label">Тип документа</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Тип документа">
            {Object.entries(DOC_CATEGORY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {targets.length > 1 && (
          <label className="field">
            <span className="field-label">К чему относится</span>
            <select value={target} onChange={(e) => setTarget(Number(e.target.value))} aria-label="К чему относится">
              {targets.map((t, i) => (
                <option key={`${t.type}:${t.id}`} value={i}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="btn secondary" style={{ display: 'inline-block' }}>
          {busy ? 'Загрузка…' : 'Загрузить файл'}
          <input ref={input} type="file" aria-label="Загрузить файл" style={{ display: 'none' }} accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx" onChange={(e) => e.target.files?.[0] && void uploadFile(e.target.files[0])} />
        </label>
      </div>
      )}
      <FormError error={error} />
      {groups.length === 0 && <div className="state empty">Документы не загружены</div>}
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
                    {cat === 'passport' ? 'Копия паспорта' : a.fileName}
                    {a.ownerLabel && related && <div className="muted">{a.ownerLabel}</div>}
                  </td>
                  <td className="muted">{Math.ceil(a.size / 1024)} KB</td>
                  <td>{fmtDateTime(a.createdAt)}</td>
                  <td>
                    {a.scanState === 'clean' && <Badge tone="ok">Проверен</Badge>}
                    {a.scanState === 'pending' && <Badge tone="info">Ожидает проверки на вирусы</Badge>}
                    {a.scanState === 'infected' && <Badge tone="bad">Опасный — заблокирован</Badge>}
                    {a.scanState === 'error' && <Badge tone="warn">Ошибка проверки</Badge>}
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
                        Скачать
                      </button>
                    )}
                    {writable && (
                    <select
                      aria-label={`Изменить тип документа: ${cat === 'passport' ? 'паспорт' : a.fileName}`}
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
                    )}
                    {writable && (
                    <button
                      type="button"
                      className="btn small secondary"
                      onClick={async () => {
                        if (!window.confirm(`Удалить «${cat === 'passport' ? 'Копия паспорта' : a.fileName}»?`)) return;
                        try {
                          await api(`/api/v1/attachments/${a.id}`, { method: 'DELETE' });
                          await state.reload();
                        } catch (e) {
                          setError(e as ApiError);
                        }
                      }}
                    >
                      Удалить
                    </button>
                    )}
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
