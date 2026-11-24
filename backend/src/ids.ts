import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * A new id, e.g. "emp_k3x9f2ab71qz". Made on the server from the system's random source, so
 * an id cannot be guessed from another one.
 */
export function newId(prefix: string, length = 12): string {
  let out = '';
  // 252 is the largest multiple of 36 that fits in a byte: bytes above it would favour some letters.
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte < 252 && out.length < length) out += ALPHABET[byte % 36];
    }
  }
  return `${prefix}_${out}`;
}
