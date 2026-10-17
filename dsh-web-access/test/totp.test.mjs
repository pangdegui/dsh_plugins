/**
 * Exercises dsh-web-access's TOTP primitives against the published test
 * vectors, so the arithmetic is verified rather than assumed.
 *
 *   node test/totp.test.mjs
 *
 * RFC 4226 Appendix D fixes the HOTP truncation; RFC 6238 Appendix B fixes the
 * TOTP counters and adds the 8-digit SHA-1 column this test compares against.
 */

import assert from 'node:assert/strict'
import {
  base32Decode,
  base32Encode,
  counterAt,
  hotp,
  otpauthUri,
  verifyTotp,
} from '../lib/totp.js'

/** RFC 6238 seed: the ASCII string "12345678901234567890". */
const SEED = Buffer.from('12345678901234567890', 'ascii')

/** RFC 6238 Appendix B, SHA-1 column: time → 8-digit code. */
const RFC_VECTORS = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
]

/** RFC 4648 §10 base32 vectors, compared without padding. */
const BASE32_VECTORS = [
  ['', ''],
  ['f', 'MY'],
  ['fo', 'MZXQ'],
  ['foo', 'MZXW6'],
  ['foob', 'MZXW6YQ'],
  ['fooba', 'MZXW6YTB'],
  ['foobar', 'MZXW6YTBOI'],
]

const checks = []
const check = (name, fn) => {
  try {
    fn()
    checks.push(`  ok   ${name}`)
  } catch (error) {
    checks.push(`  FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

// --- RFC 6238: the truncation and counter are right -------------------------

for (const [epoch, expected] of RFC_VECTORS) {
  check(`RFC 6238 vector at t=${epoch}`, () => {
    assert.equal(hotp(SEED, counterAt(epoch), 8), expected)
  })
}

check('counter follows the 30 second step', () => {
  assert.equal(counterAt(59), 1)
  assert.equal(counterAt(89), 2)
  assert.equal(counterAt(90), 3)
  assert.equal(counterAt(92), 3)
})

// --- RFC 4648: base32 round-trips -------------------------------------------

for (const [plain, encoded] of BASE32_VECTORS) {
  check(`RFC 4648 encode of ${JSON.stringify(plain)}`, () => {
    assert.equal(base32Encode(Buffer.from(plain, 'ascii')), encoded)
  })
  if (encoded !== '') {
    check(`RFC 4648 decode of ${JSON.stringify(encoded)}`, () => {
      assert.deepEqual([...base32Decode(encoded)], [...Buffer.from(plain, 'ascii')])
    })
  }
}

check('decode tolerates padding, case and spacing', () => {
  assert.deepEqual([...base32Decode('MZXW6YTBOI======')], [...Buffer.from('foobar')])
  assert.deepEqual([...base32Decode('mzxw6 ytboi')], [...Buffer.from('foobar')])
})

check('decode rejects a non-base32 character', () => {
  assert.throws(() => base32Decode('MZXW6Y0BOI'), /base32/)
})

check('a 160-bit key is 20 bytes and encodes to 32 characters', () => {
  const secret = SEED
  assert.equal(secret.length, 20)
  assert.equal(base32Encode(secret).length, 32)
})

// --- verification: window and rejection -------------------------------------

const epoch = 1234567890
const now = epoch * 1000
const code6 = hotp(SEED, counterAt(epoch), 6)

check('accepts the current code', () => {
  assert.equal(verifyTotp(SEED, code6, now), true)
})

check('accepts a code padded with noise the way users type it', () => {
  assert.equal(verifyTotp(SEED, ` ${code6.slice(0, 3)} ${code6.slice(3)} `, now), true)
})

check('tolerates a clock skewed by one step', () => {
  assert.equal(verifyTotp(SEED, code6, now + 30_000), true)
  assert.equal(verifyTotp(SEED, code6, now - 30_000), true)
})

check('rejects a code from two steps away', () => {
  assert.equal(verifyTotp(SEED, code6, now + 60_000), false)
  assert.equal(verifyTotp(SEED, code6, now - 60_000), false)
})

check('rejects a wrong code', () => {
  const wrong = code6 === '000000' ? '111111' : '000000'
  assert.equal(verifyTotp(SEED, wrong, now), false)
})

check('rejects a short or non-numeric submission', () => {
  assert.equal(verifyTotp(SEED, code6.slice(0, 5), now), false)
  assert.equal(verifyTotp(SEED, 'abcdef', now), false)
  assert.equal(verifyTotp(SEED, '', now), false)
})

// --- provisioning URI --------------------------------------------------------

check('otpauth URI carries the key and the standard parameters', () => {
  const uri = otpauthUri(SEED, 'HOST-1')
  const url = new URL(uri)
  assert.equal(url.protocol, 'otpauth:')
  assert.equal(url.hostname, 'totp')
  assert.equal(url.searchParams.get('secret'), base32Encode(SEED))
  assert.equal(url.searchParams.get('algorithm'), 'SHA1')
  assert.equal(url.searchParams.get('digits'), '6')
  assert.equal(url.searchParams.get('period'), '30')
  assert.equal(url.searchParams.get('issuer'), 'DeepSeek Harness')
  assert.equal(decodeURIComponent(url.pathname.slice(1)), 'DeepSeek Harness:HOST-1')
})

console.log(`dsh-web-access TOTP checks (${checks.length})`)
console.log(checks.join('\n'))
if (process.exitCode !== 1) console.log('\nall checks passed')
