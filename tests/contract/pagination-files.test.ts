import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BuiltinTestScanner,
  ClamdScanner,
  GraphMetaLeadsClient,
  LiveAmoRestClient,
  LocalPrivateStorage,
  newObjectKey,
  safeFileName,
  signDownload,
  sniffMime,
  verifyDownload,
  type RedisRateLimiter,
} from '@crm/integrations';

const fx = (p: string) => readFileSync(join(__dirname, '..', 'fixtures', p), 'utf8');
const noLimiter = { acquire: async () => undefined } as unknown as RedisRateLimiter;
const tokens = { getAccessToken: async () => 'tok', refresh: async () => 'tok2' };

function fakeFetch(routes: Array<{ match: RegExp; status?: number; body?: string }>, seen: string[]) {
  return (async (url: string) => {
    seen.push(url);
    const r = routes.find((x) => x.match.test(url));
    if (!r) return new Response('not found', { status: 404 });
    return new Response(r.status === 204 ? null : (r.body ?? ''), { status: r.status ?? 200 });
  }) as never;
}

describe('amoCRM REST pagination contract (synthetic fixtures)', () => {
  it('lists leads page by page with updated_at filter, parses createdAt and stops without _links.next', async () => {
    const seen: string[] = [];
    const client = new LiveAmoRestClient('example.amocrm.ru', tokens, noLimiter, 'k', 5, fakeFetch([{ match: /page=1&/, body: fx('amocrm/leads-page-1.json') }, { match: /page=2&/, body: fx('amocrm/leads-page-2.json') }], seen));
    const since = new Date('2026-10-01T00:00:00Z');
    const p1 = await client.listLeadsUpdatedSince(since, 1, 2);
    const p2 = await client.listLeadsUpdatedSince(since, 2, 2);
    expect(p1.hasMore).toBe(true);
    expect(p2.hasMore).toBe(false);
    expect(p1.items.map((l) => l.id)).toEqual(['50000101', '50000102']);
    expect(p1.items[0]).toMatchObject({ contactIds: ['60000101'], createdAt: new Date(1761200000 * 1000), responsibleUserId: '9000003' });
    expect(p1.items[1]?.customFields['900001']).toBe('op-123');
    expect(seen[0]).toContain(`filter[updated_at][from]=${Math.floor(since.getTime() / 1000)}`);
    expect(seen[0]).toContain('order[updated_at]=asc');
  });

  it('treats 204 No Content as an empty last page', async () => {
    const client = new LiveAmoRestClient('example.amocrm.ru', tokens, noLimiter, 'k', 5, fakeFetch([{ match: /contacts/, status: 204 }], []));
    expect(await client.listContactsUpdatedSince(new Date(0), 9, 250)).toEqual({ items: [], hasMore: false });
  });

  it('normalizes contacts with phones and emails', async () => {
    const client = new LiveAmoRestClient('example.amocrm.ru', tokens, noLimiter, 'k', 5, fakeFetch([{ match: /contacts/, body: fx('amocrm/contacts-page-1.json') }], []));
    const r = await client.listContactsUpdatedSince(new Date(0), 1, 250);
    expect(r.items[0]).toMatchObject({ id: '60000101', phones: ['+998900000101'], emails: ['Test@Example.com'], responsibleUserId: '9000003' });
  });

  it('retries once with a refreshed token after 401', async () => {
    let n = 0;
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      n++;
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth === 'Bearer tok' ? new Response('{}', { status: 401 }) : new Response('{"id":1,"subdomain":"x"}', { status: 200 });
    }) as never;
    const client = new LiveAmoRestClient('example.amocrm.ru', tokens, noLimiter, 'k', 5, fetchImpl);
    expect(await client.getAccount()).toEqual({ id: '1', subdomain: 'x' });
    expect(n).toBe(2);
  });
});

describe('Meta Lead Ads form history contract (synthetic fixtures)', () => {
  it('pages with the after cursor and a time_created filter; last page has no next', async () => {
    const seen: string[] = [];
    const client = new GraphMetaLeadsClient('vX', fakeFetch([{ match: /after=QVFIUmJi/, body: fx('meta/form-leads-page-2.json') }, { match: /\/leads\?/, body: fx('meta/form-leads-page-1.json') }], seen));
    const since = new Date('2026-10-01T00:00:00Z');
    const p1 = await client.listFormLeads('130000000000021', since, null, 'tok', 2);
    expect(p1.after).toBe('QVFIUmJi');
    expect(p1.items.map((l) => l.leadgenId)).toEqual(['140000000000201', '140000000000202']);
    const p2 = await client.listFormLeads('130000000000021', since, p1.after, 'tok', 2);
    expect(p2.after).toBeNull();
    expect(p2.items[0]?.fields.phone_number).toBe('+998900000203');
    const filtering = decodeURIComponent(new URL(seen[0]!).searchParams.get('filtering') ?? '');
    expect(JSON.parse(filtering)).toEqual([{ field: 'time_created', operator: 'GREATER_THAN', value: Math.floor(since.getTime() / 1000) }]);
  });
});

describe('file safety primitives', () => {
  it('sniffs real types from magic bytes, not names', () => {
    expect(sniffMime(Buffer.from('%PDF-1.7\n...'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffMime(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....[Content_Types].xml....word/document.xml')]))).toContain('wordprocessingml');
    expect(sniffMime(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]))).toBeNull(); // plain zip
    expect(sniffMime(Buffer.from('MZ\x90\x00 executable'))).toBeNull();
    expect(sniffMime(Buffer.from('<html><script>'))).toBeNull();
  });

  it('sanitizes file names', () => {
    expect(safeFileName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeFileName('a<b>"c".pdf')).toBe('abc.pdf');
    expect(safeFileName('')).toBe('fayl');
  });

  it('local storage rejects traversal keys and stores with random keys', async () => {
    const s = new LocalPrivateStorage(mkdtempSync(join(tmpdir(), 'crm-st-')));
    const key = newObjectKey();
    await s.put(key, Buffer.from('x'));
    expect((await s.get(key)).toString()).toBe('x');
    await expect(s.get('../secret')).rejects.toThrow();
    await expect(s.put(key, Buffer.from('y'))).rejects.toThrow(); // never overwrites
    await s.delete(key);
  });

  it('signed download URLs are bound to attachment, user and expiry', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const sig = signDownload('s', 'att', 'u1', exp);
    expect(verifyDownload('s', 'att', 'u1', exp, sig)).toBe(true);
    expect(verifyDownload('s', 'att', 'u2', exp, sig)).toBe(false);
    expect(verifyDownload('s', 'att2', 'u1', exp, sig)).toBe(false);
    expect(verifyDownload('s', 'att', 'u1', exp, sig, exp + 1)).toBe(false);
  });

  it('builtin scanner flags only the EICAR test signature', async () => {
    const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    expect((await new BuiltinTestScanner().scan(Buffer.from(`%PDF-1.4 ${eicar}`))).verdict).toBe('infected');
    expect((await new BuiltinTestScanner().scan(Buffer.from('%PDF-1.4 hello'))).verdict).toBe('clean');
  });

  it('clamd INSTREAM protocol: framing and verdict parsing against a fake clamd', async () => {
    const received: Buffer[] = [];
    const server = createServer((sock) => {
      sock.on('data', (d) => {
        received.push(d);
        const all = Buffer.concat(received);
        if (all.length >= 10 + 4 && all.subarray(all.length - 4).equals(Buffer.alloc(4))) {
          sock.end(all.includes(Buffer.from('EVIL')) ? 'stream: Test.Sig FOUND\0' : 'stream: OK\0');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const scanner = new ClamdScanner('127.0.0.1', port, 2000);
    expect(await scanner.scan(Buffer.from('hello world'))).toEqual({ verdict: 'clean', detail: 'stream: OK' });
    const all = Buffer.concat(received);
    expect(all.subarray(0, 10).toString('latin1')).toBe('zINSTREAM\0');
    expect(all.readUInt32BE(10)).toBe(11);
    received.length = 0;
    expect((await scanner.scan(Buffer.from('EVIL payload'))).verdict).toBe('infected');
    server.close();
    expect((await new ClamdScanner('127.0.0.1', 1, 500).scan(Buffer.from('x'))).verdict).toBe('error');
  });
});
