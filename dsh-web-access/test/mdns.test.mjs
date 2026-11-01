/**
 * mDNS alias publishing: wire format, answer selection, and the responder.
 *
 * The responder is exercised over unicast (group `null`), so the test never
 * binds the real 5353 port and never announces to the network it runs on.
 *
 *   node test/mdns.test.mjs
 */

import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import {
  MdnsPublisher,
  RECORD,
  addressRecord,
  answerFor,
  buildMessage,
  decodeName,
  encodeName,
  isAlias,
  normalizeAlias,
  parseMessage,
} from '../lib/mdns.js'

// 1. Alias input is canonicalized, and unusable labels are refused loudly.
assert.equal(normalizeAlias(''), 'dsh.local', 'an empty name falls back to the default')
assert.equal(normalizeAlias('dsh'), 'dsh.local', 'a bare label gains the .local suffix')
assert.equal(normalizeAlias('Dsh.Local.'), 'dsh.local', 'case and the root dot are normalized away')
assert.equal(normalizeAlias(' lab-2.local '), 'lab-2.local', 'surrounding space is trimmed')
assert.equal(isAlias('dsh.local'), true, 'a canonical alias is accepted')
assert.equal(isAlias('dsh'), false, 'a bare label is not canonical')
for (const bad of ['bad_name', '-lead.local', 'trail-.local', 'a..local', `${'x'.repeat(64)}.local`]) {
  assert.throws(() => normalizeAlias(bad), /label|longer/u, `${bad} must be refused`)
}

// 2. Names round-trip through the wire format, including a pointer.
const encoded = encodeName('dsh.local')
assert.deepEqual([...encoded], [3, 100, 115, 104, 5, 108, 111, 99, 97, 108, 0], 'labels are length-prefixed')
const decoded = decodeName(encoded, 0)
assert.equal(decoded.name, 'dsh.local')
assert.equal(decoded.end, encoded.length)
const pointer = Buffer.concat([Buffer.alloc(12), encoded, Buffer.from([0xc0, 0x0c])])
assert.equal(decodeName(pointer, 12 + encoded.length).name, 'dsh.local', 'a compression pointer resolves')

// 3. A question parses, and the answers carry the advertised facts.
const query = buildMessage({ flags: 0, questions: [{ name: 'dsh.local', type: RECORD.A }] })
const parsedQuery = parseMessage(query)
assert.equal(parsedQuery.questions[0].name, 'dsh.local')
assert.equal(parsedQuery.questions[0].type, RECORD.A)
assert.equal(parsedQuery.questions[0].unicast, false)

const options = {
  name: 'dsh.local',
  address: '192.168.1.5',
  port: 3080,
  instance: 'DeepSeek Harness (pc)._http._tcp.local',
  service: '_http._tcp.local',
}
const addressAnswer = answerFor({ name: 'dsh.local', type: RECORD.A }, options)
assert.ok(addressAnswer !== null, 'an A question is answered')
const addressMessage = parseMessage(buildMessage({ flags: 0x8400, answers: addressAnswer.answers, additionals: addressAnswer.additionals }))
assert.equal(addressMessage.answers.length, 1)
assert.equal(addressMessage.answers[0].name, 'dsh.local')
assert.equal(addressMessage.answers[0].type, RECORD.A)
assert.equal(addressMessage.answers[0].flush, true, 'the A record asks caches to flush stale entries')
assert.deepEqual([...addressMessage.answers[0].rdata], [192, 168, 1, 5])

const pointerAnswer = answerFor({ name: '_http._tcp.local', type: RECORD.PTR }, options)
assert.ok(pointerAnswer !== null, 'a PTR question is answered')
const pointerMessage = parseMessage(buildMessage({ flags: 0x8400, answers: pointerAnswer.answers, additionals: pointerAnswer.additionals }))
assert.equal(pointerMessage.answers[0].type, RECORD.PTR)
assert.equal(decodeName(pointerMessage.answers[0].rdata, 0).name, options.instance, 'the PTR target is the instance')
assert.deepEqual(pointerMessage.additionals.map((record) => record.type), [RECORD.SRV, RECORD.TXT, RECORD.A], 'SRV, TXT, and A ride along')
assert.equal(pointerMessage.additionals[0].rdata.readUInt16BE(4), 3080, 'the SRV record names the LAN port')
assert.equal(pointerMessage.additionals[1].rdata.toString('utf8').slice(1), 'path=/dsh-access', 'the TXT record names the login path')

assert.equal(answerFor({ name: 'other.local', type: RECORD.A }, options), null, 'a foreign name is left alone')
assert.equal(answerFor({ name: 'dsh.local', type: RECORD.TXT }, options), null, 'an unrelated type is left alone')

// 4. The responder answers over a real socket, in unicast mode.
const publisher = new MdnsPublisher({
  name: 'dsh.local',
  address: '127.0.0.1',
  port: 3080,
  instance: 'DeepSeek Harness (test)',
  group: null,
  mdnsPort: 0,
  bindAddress: '127.0.0.1',
  announceDelay: 10,
})
await publisher.start()
assert.equal(publisher.status.published, true, 'the publisher reports itself as published')
assert.ok(publisher.boundPort > 0, 'the OS-assigned port is known')

const client = dgram.createSocket({ type: 'udp4' })
await new Promise((resolve) => { client.bind(0, '127.0.0.1', resolve) })

const ask = (name, type) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { reject(new Error(`no answer for ${name}`)) }, 2000)
  client.once('message', (buf) => {
    clearTimeout(timer)
    resolve(parseMessage(buf))
  })
  client.send(buildMessage({ flags: 0, questions: [{ name, type }] }), publisher.boundPort, '127.0.0.1')
})

const reply = await ask('dsh.local', RECORD.A)
assert.equal(reply.answers[0].name, 'dsh.local')
assert.deepEqual([...reply.answers[0].rdata], [127, 0, 0, 1], 'the A record carries the configured address')
assert.equal(reply.answers[0].ttl, 120, 'the A record has a short TTL')

const serviceReply = await ask('_http._tcp.local', RECORD.PTR)
assert.equal(serviceReply.answers[0].type, RECORD.PTR, 'the service browse is answered')
assert.equal(decodeName(serviceReply.answers[0].rdata, 0).name, 'DeepSeek Harness (test)._http._tcp.local')

// A response claiming our name for another address is surfaced, not defended.
const conflict = buildMessage({ flags: 0x8400, answers: [addressRecord('dsh.local', '192.168.1.99')] })
publisher.onMessage(conflict, { address: '192.168.1.99', port: 5353 })
assert.equal(publisher.status.conflict, true, 'a conflicting A claim is reported')

publisher.stop()
assert.equal(publisher.status.published, false, 'stop unpublishes')
client.close()

console.log('dsh-web-access mDNS checks')
console.log('  alias normalization, wire format, answer selection, responder: ok')
console.log('  all checks passed')
