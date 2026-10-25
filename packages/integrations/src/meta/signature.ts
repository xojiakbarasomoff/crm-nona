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

/**
 * `signed_request` of Meta's Deauthorize / Data Deletion callbacks: `<base64url(HMAC-SHA256)>.<base64url(JSON)>`,
 * signed with the app secret. Returns the payload only when the signature matches one of the given secrets.
 */
export function parseSignedRequest(signedRequest: string, secrets: string[]): Record<string, unknown> | null {
  const [sigPart, payloadPart] = signedRequest.split('.');
  if (!sigPart || !payloadPart) return null;
  const given = Buffer.from(sigPart, 'base64url');
  for (const secret of secrets.filter(Boolean)) {
    const expected = createHmac('sha256', secret).update(payloadPart).digest();
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      try {
        const json = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
        return json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    }
  }
  return null;
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
