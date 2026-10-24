import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { isAbsolute, join, resolve, sep } from 'node:path';

/**
 * Private file storage, content sniffing, malware scanning and signed download URLs (TZ §21).
 */

// ---------------- Storage ----------------

export interface StorageDriver {
  readonly descriptor: { name: string; kind: 'local' | 'object' };
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Local private directory (never served statically). Keys are random and validated. */
export class LocalPrivateStorage implements StorageDriver {
  readonly descriptor = { name: 'local-private', kind: 'local' as const };
  private readonly root: string;
  constructor(root: string) {
    // Relative paths resolve against the directory npm was started from (repo root for workspace
    // scripts), so API and worker share one directory. Production should use an absolute path.
    this.root = resolve(isAbsolute(root) ? root : join(process.env.INIT_CWD ?? process.cwd(), root));
  }
  private path(key: string) {
    if (!/^[a-f0-9]{2}\/[a-f0-9]{62}$/.test(key)) throw new Error('Invalid storage key');
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error('Path traversal rejected');
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(resolve(p, '..'), { recursive: true });
    await writeFile(p, data, { flag: 'wx', mode: 0o600 });
  }
  async get(key: string) {
    return readFile(this.path(key));
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
}

export function newObjectKey(): string {
  const hex = randomBytes(32).toString('hex');
  return `${hex.slice(0, 2)}/${hex.slice(2)}`;
}

// ---------------- Content sniffing ----------------

export const ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] as const;
export type AllowedMime = (typeof ALLOWED_MIME)[number];

/** Detects the real type from magic bytes; the client-declared type is never trusted alone. */
export function sniffMime(buf: Buffer): AllowedMime | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    const head = buf.subarray(0, Math.min(buf.length, 64 * 1024)).toString('latin1');
    if (!head.includes('[Content_Types].xml')) return null;
    if (head.includes('word/')) return ALLOWED_MIME[4];
    if (head.includes('xl/')) return ALLOWED_MIME[5];
  }
  return null;
}

export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the intent
  const base = name.replace(/[/\\]/g, '_').replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').trim();
  return (base || 'fayl').slice(0, 150);
}

// ---------------- Malware scanning ----------------

export type ScanResult = { verdict: 'clean' | 'infected' | 'error'; detail: string };

export interface MalwareScanner {
  readonly descriptor: { name: string; kind: 'builtin' | 'clamav' };
  scan(data: Buffer): Promise<ScanResult>;
}

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * Signature check for the EICAR test file only. It exists so the quarantine flow works in demo and
 * tests; it is NOT antivirus protection and is refused outside demo mode.
 */
export class BuiltinTestScanner implements MalwareScanner {
  readonly descriptor = { name: 'builtin-eicar-only', kind: 'builtin' as const };
  async scan(data: Buffer): Promise<ScanResult> {
    return data.includes(Buffer.from(EICAR, 'latin1')) ? { verdict: 'infected', detail: 'Eicar-Test-Signature' } : { verdict: 'clean', detail: 'builtin: no test signature' };
  }
}

/** clamd INSTREAM protocol over TCP (`zINSTREAM\0`, 4-byte big-endian chunk lengths, zero terminator). */
export class ClamdScanner implements MalwareScanner {
  readonly descriptor = { name: 'clamd', kind: 'clamav' as const };
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 30_000,
  ) {}
  scan(data: Buffer): Promise<ScanResult> {
    return new Promise((resolvePromise) => {
      const socket = connect({ host: this.host, port: this.port });
      const chunks: Buffer[] = [];
      const done = (r: ScanResult) => {
        socket.destroy();
        resolvePromise(r);
      };
      socket.setTimeout(this.timeoutMs, () => done({ verdict: 'error', detail: 'clamd timeout' }));
      socket.on('error', (e) => done({ verdict: 'error', detail: `clamd: ${e.message}` }));
      socket.on('data', (d) => chunks.push(d));
      socket.on('end', () => {
        const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
        if (/: OK$/.test(reply)) return done({ verdict: 'clean', detail: reply });
        if (/FOUND$/.test(reply)) return done({ verdict: 'infected', detail: reply.replace(/^stream: /, '') });
        done({ verdict: 'error', detail: reply || 'empty clamd reply' });
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let i = 0; i < data.length; i += 64 * 1024) {
          const chunk = data.subarray(i, i + 64 * 1024);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.length);
          socket.write(len);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }
}

// ---------------- Signed download URLs ----------------

export function signDownload(secret: string, attachmentId: string, userId: string, expiresAtSec: number): string {
  return createHmac('sha256', secret).update(`${attachmentId}|${userId}|${expiresAtSec}`).digest('base64url');
}

export function verifyDownload(secret: string, attachmentId: string, userId: string, expiresAtSec: number, sig: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!Number.isFinite(expiresAtSec) || expiresAtSec < nowSec) return false;
  const expected = Buffer.from(signDownload(secret, attachmentId, userId, expiresAtSec));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
