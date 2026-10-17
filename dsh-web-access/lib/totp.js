/**
 * dsh-web-access — TOTP primitives.
 *
 * RFC 4648 base32 plus RFC 6238 HOTP/TOTP over HMAC-SHA1, with only
 * `node:crypto` as a dependency. Kept in its own module with no Cordis, no
 * service and no filesystem touch, so the arithmetic can be exercised
 * directly against the RFC's published test vectors (see test/totp.test.mjs).
 *
 * Defaults follow RFC 4226/6238: a 160-bit key, 6 digits, a 30-second step.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const TOTP_PERIOD = 30
export const TOTP_DIGITS = 6

/** Encode bytes as unpadded RFC 4648 base32, the form authenticators display. */
export function base32Encode(bytes) {
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32_ALPHABET[(value >>> bits) & 31]
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/**
 * Decode a shared key. Tolerant of spacing, case and padding, because every
 * authenticator presents the key differently.
 * @throws {TypeError} when the text contains a character base32 does not allow.
 */
export function base32Decode(text) {
  const cleaned = String(text).toUpperCase().replace(/=+$/u, '').replace(/[\s-]/gu, '')
  let bits = 0
  let value = 0
  const out = []
  for (const ch of cleaned) {
    const index = BASE32_ALPHABET.indexOf(ch)
    if (index < 0) throw new TypeError('not valid base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  if (out.length === 0) throw new TypeError('empty shared key')
  return Buffer.from(out)
}

/**
 * The HOTP value for one counter, truncated per RFC 4226 §5.3.
 * @param secret - the shared key.
 * @param counter - the moving-factor, written as a 64-bit big-endian integer.
 * @param digits - output length; RFC 6238 publishes both 6 and 8.
 */
export function hotp(secret, counter, digits = TOTP_DIGITS) {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', secret).update(message).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3]
  return String(binary % 10 ** digits).padStart(digits, '0')
}

/** The TOTP value at one instant. */
export function totpAt(secret, counter, digits = TOTP_DIGITS) {
  return hotp(secret, counter, digits)
}

/** The counter for one instant. */
export function counterAt(epochSeconds, period = TOTP_PERIOD) {
  return Math.floor(epochSeconds / period)
}

/**
 * Compare a submitted code against the current and adjacent steps.
 *
 * The one-step tolerance covers a slightly skewed clock — the common case for
 * a phone that has not synced in a while. The comparison is constant-time on
 * equal-length buffers, and the digit filter drops anything a code cannot be.
 */
export function verifyTotp(secret, submitted, now = Date.now(), digits = TOTP_DIGITS) {
  const code = String(submitted).replace(/\D/gu, '')
  if (code.length !== digits) return false
  const step = counterAt(now / 1000)
  const expected = Buffer.from(code)
  for (let offset = -1; offset <= 1; offset += 1) {
    const candidate = Buffer.from(hotp(secret, step + offset, digits))
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return true
  }
  return false
}

/** The `otpauth://` URI every authenticator app understands. */
export function otpauthUri(secret, account, issuer = 'DeepSeek Harness', digits = TOTP_DIGITS) {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(digits),
    period: String(TOTP_PERIOD),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}
