import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta webhook payload signature (TZ §19.1, [S10]): `X-Hub-Signature-256: sha256=<hex>` computed
 * with the app secret over the *raw* request body. The body is never re-serialized.
 * Endpoint verification (GET hub.challenge) is a separate check: see verifyChallenge.
 */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined | null, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const [algo, sig] = header.split('=');
  if (algo !== 'sha256' || !sig || !/^[0-9a-f]{64}$/i.test(sig)) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(sig, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signMetaBody(rawBody: Buffer | string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

export function verifyChallenge(
  query: Record<string, unknown>,
  verifyToken: string,
): { ok: true; challenge: string } | { ok: false } {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode !== 'subscribe' || typeof token !== 'string' || typeof challenge !== 'string' || !verifyToken) return { ok: false };
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false };
  return { ok: true, challenge };
}
