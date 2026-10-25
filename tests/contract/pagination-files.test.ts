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
  LocalPrivateStorage,
  newObjectKey,
  safeFileName,
  signDownload,
  sniffMime,
  verifyDownload,
} from '@crm/integrations';

const fx = (p: string) => readFileSync(join(__dirname, '..', 'fixtures', p), 'utf8');

function fakeFetch(routes: Array<{ match: RegExp; status?: number; body?: string }>, seen: string[]) {
  return (async (url: string) => {
    seen.push(url);
    const r = routes.find((x) => x.match.test(url));
    if (!r) return new Response('not found', { status: 404 });
    return new Response(r.status === 204 ? null : (r.body ?? ''), { status: r.status ?? 200 });
  }) as never;
}

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
