import { fmtDateTime, SOURCE_LABELS } from '../lib/api';
import { Section } from './ui';

export interface FormInquiry {
  id: string;
  channel: string;
  receivedAt: string;
  formData: Record<string, unknown> | null;
  attribution: Record<string, unknown> | null;
}

const LABELS: Record<string, string> = { full_name: 'Имя и фамилия', first_name: 'Имя', last_name: 'Фамилия', phone_number: 'Телефон', email: 'Email', destination: 'Направление' };

/** Plain React text rendering also keeps arbitrary custom-form answers safe. */
export function LeadFormAnswers({ inquiries }: { inquiries: FormInquiry[] }) {
  const forms = inquiries.filter(i => i.channel === 'instagram_lead_ads' || i.channel === 'meta_lead_ads');
  if (!forms.length) return null;
  return <Section title="Заявки из рекламных форм">
    {forms.map(i => <div className="state" key={i.id}>
      <p><b>{SOURCE_LABELS[i.channel] ?? i.channel}</b> · {fmtDateTime(i.receivedAt)}</p>
      <dl>{Object.entries(i.formData ?? {}).map(([key, value]) => <div key={key}><dt>{LABELS[key] ?? key}</dt><dd style={{ overflowWrap: 'anywhere' }}>{typeof value === 'string' ? value : JSON.stringify(value)}</dd></div>)}</dl>
      <p className="muted">{['campaignName', 'adsetName', 'adName'].map(key => typeof i.attribution?.[key] === 'string' ? i.attribution[key] : null).filter(Boolean).join(' · ')}</p>
      {typeof i.attribution?.formId === 'string' && <p className="muted">Форма: {i.attribution.formId}</p>}
    </div>)}
  </Section>;
}
