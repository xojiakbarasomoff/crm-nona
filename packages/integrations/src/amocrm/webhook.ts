import { canonicalEventKey } from '@crm/domain';

/**
 * amoCRM CRM webhooks ([S11]) arrive as application/x-www-form-urlencoded with PHP-style nested
 * keys, e.g. `leads[status][0][id]=123&account[id]=456`. There is no universal HMAC: the route
 * contains an unguessable connection token, the account id is checked against the connection, and
 * the referenced object is always re-read from amoCRM before any state change (TZ §19.1).
 * Webhook content never escalates permissions; it is only a signal.
 */

export interface AmoCrmSignal {
  entity: 'leads' | 'contacts' | 'tasks' | string;
  action: string;
  id: string;
  accountId: string | null;
  /** Optional hint fields; the authoritative state is fetched from the API. */
  hint: Record<string, string>;
  key: string;
}

type Tree = { [k: string]: Tree | string };

export function parseNestedForm(body: string): Tree {
  const root: Tree = {};
  for (const pair of body.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = decodeURIComponent((eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '));
    const value = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    const path = rawKey.replace(/\]/g, '').split('[');
    let node: Tree = root;
    path.forEach((seg, i) => {
      if (i === path.length - 1) {
        node[seg] = value;
      } else {
        const next = node[seg];
        if (typeof next !== 'object') node[seg] = {};
        node = node[seg] as Tree;
      }
    });
  }
  return root;
}

const ENTITIES = ['leads', 'contacts', 'tasks', 'companies'];

export function parseAmoCrmWebhook(body: string): AmoCrmSignal[] {
  const tree = parseNestedForm(body);
  const account = tree.account;
  const accountId = typeof account === 'object' && typeof account.id === 'string' ? account.id : null;
  const signals: AmoCrmSignal[] = [];
  for (const entity of ENTITIES) {
    const actions = tree[entity];
    if (typeof actions !== 'object') continue;
    for (const [action, items] of Object.entries(actions)) {
      if (typeof items !== 'object') continue;
      for (const item of Object.values(items)) {
        if (typeof item !== 'object' || typeof item.id !== 'string') continue;
        const hint: Record<string, string> = {};
        for (const [k, v] of Object.entries(item)) if (typeof v === 'string') hint[k] = v;
        const version = hint.updated_at ?? hint.last_modified ?? hint.date_modify ?? null;
        signals.push({
          entity,
          action,
          id: item.id,
          accountId,
          hint,
          key: version ? `${entity}:${action}:${item.id}:${version}` : canonicalEventKey('amo', { entity, action, ...hint }),
        });
      }
    }
  }
  return signals;
}
