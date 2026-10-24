import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * Shared, cross-process rate limiter (TZ §19.3): fixed one-second windows per key in Redis.
 * All API and worker processes share the same budget for a provider connection.
 */
export class RedisRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'rl',
  ) {}

  /** Tries to take one slot. Returns 0 if granted, otherwise milliseconds to wait. */
  async tryAcquire(key: string, perSecond: number): Promise<number> {
    const now = Date.now();
    const windowStart = Math.floor(now / 1000);
    const k = `${this.prefix}:${key}:${windowStart}`;
    const count = await this.redis.incr(k);
    if (count === 1) await this.redis.pexpire(k, 2000);
    if (count <= perSecond) return 0;
    return 1000 - (now % 1000) + 1;
  }

  async acquire(key: string, perSecond: number, maxWaitMs = 30_000): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const wait = await this.tryAcquire(key, perSecond);
      if (wait === 0) return;
      if (Date.now() + wait > deadline) throw new Error(`Rate limiter wait exceeded for ${key}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const RELEASE_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** Short-lived mutual exclusion; the token guards against releasing someone else's lock. */
export class RedisLock {
  constructor(private readonly redis: Redis) {}

  async withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>, waitMs = 10_000): Promise<T> {
    const token = randomUUID();
    const deadline = Date.now() + waitMs;
    while ((await this.redis.set(`lock:${key}`, token, 'PX', ttlMs, 'NX')) !== 'OK') {
      if (Date.now() > deadline) throw new Error(`Could not acquire lock ${key}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    try {
      return await fn();
    } finally {
      await this.redis.eval(RELEASE_LUA, 1, `lock:${key}`, token);
    }
  }
}

/** Sliding counter for login attempts (shared across API instances). */
export async function hitCounter(redis: Redis, key: string, windowSec: number): Promise<number> {
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, windowSec);
  return n;
}
