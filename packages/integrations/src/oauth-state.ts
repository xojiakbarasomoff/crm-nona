import { createHash, randomBytes } from 'node:crypto';

/** OAuth `state` (CSRF): brauzerga ochiq qiymat beriladi, bazada faqat uning SHA-256 xeshi saqlanadi. */
export function newOAuthState(): { state: string; stateHash: string } {
  const state = randomBytes(32).toString('base64url');
  return { state, stateHash: hashState(state) };
}

export function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}
