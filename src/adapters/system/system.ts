import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Clock, IdGenerator, PasswordHasher } from '../../domain';

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class UuidGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}

/**
 * scrypt from Node's standard library: no native add-on to build in Docker.
 * Stored format: scrypt$N$r$p$saltB64$hashB64
 */
export class ScryptPasswordHasher implements PasswordHasher {
  private static readonly N = 16384;
  private static readonly r = 8;
  private static readonly p = 1;
  private static readonly keyLength = 64;

  async hash(plain: string): Promise<string> {
    const { N, r, p, keyLength } = ScryptPasswordHasher;
    const salt = randomBytes(16);
    const hash = await scrypt(plain, salt, keyLength, { N, r, p });
    return ['scrypt', N, r, p, salt.toString('base64'), hash.toString('base64')].join('$');
  }

  async verify(plain: string, stored: string): Promise<boolean> {
    const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(plain, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}
