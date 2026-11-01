/**
 * dsh-web-access — mDNS alias publishing.
 *
 * The LAN entry is a concrete address at a fixed port, so a client only needs
 * the address to reach it. This module publishes a **`.local` alias** for that
 * address, so the same URL keeps working when DHCP hands out a different
 * address, and optionally an `_http._tcp` service record so discovery tools
 * (`dns-sd -B _http._tcp`) can find the login entry.
 *
 * It is a deliberately small responder, not an RFC 6762 implementation:
 *
 *   - One A record for the configured alias, plus PTR/SRV/TXT for the HTTP
 *     service. No probing, no tie-breaking, no cache maintenance.
 *   - Answers are sent from **every** non-internal IPv4 interface, because a
 *     `dgram` socket cannot say which interface a multicast query arrived on,
 *     and a resolver drops an answer sourced from another subnet. (Measured on
 *     Windows: a response sourced from the VPN adapter for a query that arrived
 *     on Wi-Fi is ignored, and resolution fails with NXDOMAIN.)
 *   - A conflicting A claim for the same name is reported, not defended.
 *
 * Everything the resolver needs is in the wire format, so the packet builders
 * and the parser are pure functions and are tested without sockets.
 */

import dgram from 'node:dgram'
import os from 'node:os'

export const MDNS_GROUP = '224.0.0.251'
export const MDNS_PORT = 5353
/** The alias published unless the panel names another one. */
export const DEFAULT_ALIAS = 'dsh.local'
/** Service type discovery tools browse for. */
export const SERVICE_TYPE = '_http._tcp.local'

/** DNS record types this module speaks. */
export const RECORD = Object.freeze({ A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 })

/** Address records are short-lived; service records may be cached longer. */
const ALIAS_TTL = 120
const SERVICE_TTL = 4500
/** QR=1, AA=1: this is an authoritative response. */
const RESPONSE_FLAGS = 0x8400

const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u

/**
 * Normalize one alias into the form the wire carries.
 *
 * A bare `dsh` becomes `dsh.local`; an explicit `dsh.local.` loses its root
 * dot; case folds to lowercase. Anything that is not a legal DNS label is
 * refused here rather than on the wire, where the failure would be a silently
 * ignored packet.
 *
 * @param {unknown} value - operator input.
 * @returns {string} the canonical alias.
 * @throws {Error} when a label cannot be a DNS name.
 */
export function normalizeAlias(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase().replace(/\.+$/u, '') : ''
  if (raw === '') return DEFAULT_ALIAS
  const name = raw.endsWith('.local') ? raw : `${raw}.local`
  if (name.length > 253) throw new Error('the alias is longer than 253 characters')
  for (const label of name.split('.')) {
    if (label.length < 1 || label.length > 63 || !LABEL.test(label)) {
      throw new Error(`the label ${JSON.stringify(label)} must be 1-63 lowercase letters, digits, or hyphens, and must not start or end with a hyphen`)
    }
  }
  return name
}

/** Whether a normalized alias is safe to publish. */
export function isAlias(name) {
  try {
    return normalizeAlias(name) === name
  } catch {
    return false
  }
}

// --- wire format -------------------------------------------------------------

/**
 * Encode a dotted name as length-prefixed labels plus the root label.
 * @param {string} name - dotted name.
 * @returns {Buffer} the encoded name.
 */
export function encodeName(name) {
  const labels = name.replace(/\.$/u, '').split('.')
  const parts = labels.map((label) => {
    const bytes = Buffer.from(label, 'utf8')
    if (bytes.length > 63) throw new Error(`label ${JSON.stringify(label)} is longer than 63 bytes`)
    return Buffer.concat([Buffer.from([bytes.length]), bytes])
  })
  return Buffer.concat([...parts, Buffer.from([0])])
}

/**
 * Read a possibly-compressed name.
 *
 * Questions are normally written out, but answers from other responders use the
 * pointer form, and a conflict scan has to read them.
 *
 * @param {Buffer} buf - the message.
 * @param {number} offset - where the name starts.
 * @returns {{ name: string, end: number }} the name and the offset past it in
 *   the original (non-pointer) stream.
 */
export function decodeName(buf, offset) {
  const labels = []
  let at = offset
  let end = offset
  let jumped = false
  for (let guard = 0; guard < 128; guard += 1) {
    if (at >= buf.length) throw new Error('truncated name')
    const length = buf[at]
    if (length === 0) {
      at += 1
      if (!jumped) end = at
      return { name: labels.join('.'), end }
    }
    if ((length & 0xc0) === 0xc0) {
      if (at + 1 >= buf.length) throw new Error('truncated name pointer')
      if (!jumped) end = at + 2
      at = ((length & 0x3f) << 8) | buf[at + 1]
      jumped = true
      continue
    }
    if ((length & 0xc0) !== 0) throw new Error('unsupported label type')
    if (at + 1 + length > buf.length) throw new Error('truncated label')
    labels.push(buf.toString('utf8', at + 1, at + 1 + length))
    at += 1 + length
    if (!jumped) end = at
  }
  throw new Error('name pointer loop')
}

/**
 * One resource record. The class field's top bit is the mDNS cache-flush bit.
 * @param {string} name - owner name.
 * @param {number} type - record type.
 * @param {{ ttl: number, flush?: boolean, rdata: Buffer }} fields - record body.
 * @returns {Buffer} the encoded record.
 */
function encodeRecord(name, type, { ttl, flush = false, rdata }) {
  const head = Buffer.alloc(10)
  head.writeUInt16BE(type, 0)
  head.writeUInt16BE(flush ? 0x8001 : 0x0001, 2)
  head.writeUInt32BE(Math.max(0, ttl), 4)
  head.writeUInt16BE(rdata.length, 8)
  return Buffer.concat([encodeName(name), head, rdata])
}

/** An A record carrying one IPv4 address. */
export function addressRecord(name, address, ttl = ALIAS_TTL) {
  const octets = String(address).split('.').map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    throw new Error(`not an IPv4 address: ${JSON.stringify(address)}`)
  }
  return encodeRecord(name, RECORD.A, { ttl, flush: true, rdata: Buffer.from(octets) })
}

/** A PTR record from the service type to one instance. */
export function pointerRecord(service, instance, ttl = SERVICE_TTL) {
  return encodeRecord(service, RECORD.PTR, { ttl, rdata: encodeName(instance) })
}

/** SRV: priority 0, weight 0, the LAN port, and the alias as the target. */
export function serviceRecord(instance, target, port, ttl = ALIAS_TTL) {
  const head = Buffer.alloc(6)
  head.writeUInt16BE(0, 0)
  head.writeUInt16BE(0, 2)
  head.writeUInt16BE(port, 4)
  return encodeRecord(instance, RECORD.SRV, { ttl, flush: true, rdata: Buffer.concat([head, encodeName(target)]) })
}

/** TXT: length-prefixed `key=value` strings, one per entry. */
export function textRecord(instance, entries, ttl = ALIAS_TTL) {
  const parts = entries.map((entry) => {
    const bytes = Buffer.from(entry, 'utf8').subarray(0, 255)
    return Buffer.concat([Buffer.from([bytes.length]), bytes])
  })
  return encodeRecord(instance, RECORD.TXT, { ttl, flush: true, rdata: Buffer.concat(parts) })
}

/**
 * Build one DNS message.
 * @param {{ id?: number, flags: number, questions?: object[], answers?: Buffer[], additionals?: Buffer[] }} message - sections.
 * @returns {Buffer} the wire message.
 */
export function buildMessage({ id = 0, flags, questions = [], answers = [], additionals = [] }) {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(id, 0)
  header.writeUInt16BE(flags, 2)
  header.writeUInt16BE(questions.length, 4)
  header.writeUInt16BE(answers.length, 6)
  header.writeUInt16BE(0, 8)
  header.writeUInt16BE(additionals.length, 10)
  const parts = [header]
  for (const question of questions) {
    const tail = Buffer.alloc(4)
    tail.writeUInt16BE(question.type, 0)
    tail.writeUInt16BE(question.unicast === true ? 0x8001 : 0x0001, 2)
    parts.push(encodeName(question.name), tail)
  }
  parts.push(...answers, ...additionals)
  return Buffer.concat(parts)
}

/**
 * Parse a message far enough to answer a question and to notice a conflicting
 * address claim. Unknown record bodies are kept as raw bytes.
 * @param {Buffer} buf - the wire message.
 * @returns {{ id: number, flags: number, questions: object[], answers: object[], additionals: object[] }} parsed sections.
 */
export function parseMessage(buf) {
  if (buf.length < 12) throw new Error('message shorter than a header')
  const id = buf.readUInt16BE(0)
  const flags = buf.readUInt16BE(2)
  const count = (offset) => buf.readUInt16BE(offset)
  let at = 12
  const questions = []
  for (let index = 0; index < count(4); index += 1) {
    const { name, end } = decodeName(buf, at)
    at = end
    if (at + 4 > buf.length) throw new Error('truncated question')
    const type = buf.readUInt16BE(at)
    const klass = buf.readUInt16BE(at + 2)
    at += 4
    questions.push({ name, type, unicast: (klass & 0x8000) !== 0 })
  }
  function* readRecords(records) {
    for (let index = 0; index < records; index += 1) {
      const { name, end } = decodeName(buf, at)
      at = end
      if (at + 10 > buf.length) throw new Error('truncated record')
      const type = buf.readUInt16BE(at)
      const klass = buf.readUInt16BE(at + 2)
      const ttl = buf.readUInt32BE(at + 4)
      const length = buf.readUInt16BE(at + 8)
      at += 10
      if (at + length > buf.length) throw new Error('truncated record body')
      const rdata = buf.subarray(at, at + length)
      at += length
      yield { name, type, flush: (klass & 0x8000) !== 0, ttl, rdata }
    }
  }
  const answers = [...readRecords(count(6))]
  for (const _ of readRecords(count(8))) { /* authorities are not used */ }
  const additionals = [...readRecords(count(10))]
  return { id, flags, questions, answers, additionals }
}

/**
 * The records that answer one question, or `null` when this publisher does not
 * own the name.
 * @param {{ name: string, type: number }} question - the parsed question.
 * @param {{ name: string, address: string, port: number, instance: string, service: string }} options - what to publish.
 * @returns {{ answers: Buffer[], additionals: Buffer[] } | null} the reply sections.
 */
export function answerFor(question, options) {
  const { name, address, port, instance, service } = options
  const nameMatches = question.name.toLowerCase() === name
  if (nameMatches && (question.type === RECORD.A || question.type === RECORD.ANY)) {
    return { answers: [addressRecord(name, address)], additionals: [] }
  }
  const serviceMatches = question.name.toLowerCase() === service
  if (serviceMatches && (question.type === RECORD.PTR || question.type === RECORD.ANY)) {
    return {
      answers: [pointerRecord(service, instance)],
      additionals: [
        serviceRecord(instance, name, port),
        textRecord(instance, [`path=/dsh-access`]),
        addressRecord(name, address),
      ],
    }
  }
  const instanceMatches = question.name.toLowerCase() === instance.toLowerCase()
  if (instanceMatches && (question.type === RECORD.SRV || question.type === RECORD.TXT || question.type === RECORD.ANY)) {
    return {
      answers: [serviceRecord(instance, name, port), textRecord(instance, [`path=/dsh-access`])],
      additionals: [addressRecord(name, address)],
    }
  }
  return null
}

// --- publisher ---------------------------------------------------------------

/** This machine's non-internal IPv4 addresses, in interface order. */
function localAddresses() {
  return [...new Set(Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address))]
}

/**
 * Publish one alias (and one HTTP service) over mDNS.
 *
 * `start()` resolves once the socket is bound; a bind failure is reported in
 * `status.error` by the caller and never throws into plugin startup. `stop()`
 * sends a goodbye (TTL 0) so resolvers drop the name promptly instead of
 * waiting for the cache entry to expire.
 */
export class MdnsPublisher {
  /**
   * @param {object} options - what to publish, and how to reach the network.
   * @param {string} options.name - canonical alias (`dsh.local`).
   * @param {string} options.address - IPv4 the alias resolves to.
   * @param {number} options.port - LAN port of the login entry.
   * @param {string} [options.instance] - service instance label (defaults to
   *   `DeepSeek Harness (<alias>)`, so no host name is broadcast).
   * @param {string} [options.service] - service type.
   * @param {object} [options.logger] - `warn` sink.
   * @param {() => string[]} [options.interfaceAddresses] - local IPv4 list.
   * @param {() => import('node:dgram').Socket} [options.createSocket] - socket factory (tests).
   * @param {string|null} [options.group] - multicast group, `null` disables multicast (tests).
   * @param {number} [options.mdnsPort] - multicast port, 0 lets the OS pick one (tests).
   * @param {string} [options.bindAddress] - local bind address (tests).
   * @param {number} [options.announceDelay] - delay of the second announcement.
   */
  constructor(options) {
    this.name = options.name
    this.address = options.address
    this.port = options.port
    this.instance = options.instance ?? `DeepSeek Harness (${options.name})`
    this.service = options.service ?? SERVICE_TYPE
    this.logger = options.logger ?? {}
    this.interfaceAddresses = options.interfaceAddresses ?? localAddresses
    this.createSocket = options.createSocket ?? (() => dgram.createSocket({ type: 'udp4', reuseAddr: true }))
    this.group = options.group === undefined ? MDNS_GROUP : options.group
    this.mdnsPort = options.mdnsPort ?? MDNS_PORT
    this.bindAddress = options.bindAddress ?? '0.0.0.0'
    this.announceDelay = options.announceDelay ?? 1000
    this.socket = null
    this.boundPort = null
    this.timers = []
    this.state = { published: false, error: null, conflict: false }
  }

  /** The fully qualified service instance, e.g. `DeepSeek Harness (pc)._http._tcp.local`. */
  get instanceName() {
    return `${this.instance}.${this.service}`
  }

  /** What the panel renders. */
  get status() {
    return {
      name: this.name,
      address: this.address,
      port: this.port,
      published: this.state.published,
      error: this.state.error,
      conflict: this.state.conflict,
    }
  }

  /**
   * Bind, join the group on every interface, and announce.
   * @returns {Promise<void>} resolves once the alias is being served.
   */
  async start() {
    if (this.socket !== null) return
    const socket = this.createSocket()
    this.socket = socket
    socket.on('message', (buf, rinfo) => { this.onMessage(buf, rinfo) })
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { reject(error) }
        socket.once('error', onError)
        socket.bind(this.mdnsPort, this.bindAddress, () => {
          socket.off('error', onError)
          resolve()
        })
      })
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : String(error)
      this.state.published = false
      try { socket.close() } catch { /* already closed */ }
      this.socket = null
      throw error
    }
    // A later socket error (an ICMP rejection, say) must not take the app down.
    socket.on('error', (error) => {
      this.state.error = error instanceof Error ? error.message : String(error)
    })
    this.boundPort = socket.address().port
    if (this.group !== null) this.joinGroup(socket)
    this.state.published = true
    this.state.error = null
    this.announce()
    this.timers.push(setTimeout(() => { this.announce() }, this.announceDelay).unref())
  }

  /** Send the goodbye and close the socket. */
  stop() {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
    if (this.socket === null) return
    const packet = this.packetFor(0)
    if (packet !== null) this.sendPacket(packet, null, false)
    try { this.socket.close() } catch { /* already closed */ }
    this.socket = null
    this.boundPort = null
    this.state.published = false
  }

  /** Join the multicast group on each interface, reporting a partial failure. */
  joinGroup(socket) {
    const addresses = this.interfaceAddresses()
    let joined = 0
    for (const address of addresses) {
      try {
        socket.addMembership(this.group, address)
        joined += 1
      } catch (error) {
        this.logger.warn?.('web-access: mDNS could not join %s on %s: %s', this.group, address, error instanceof Error ? error.message : String(error))
      }
    }
    if (joined === 0) {
      try {
        socket.addMembership(this.group)
      } catch (error) {
        this.logger.warn?.('web-access: mDNS could not join %s: %s', this.group, error instanceof Error ? error.message : String(error))
      }
    }
  }

  /** The announcement/goodbye body: the A record plus the service trio. */
  packetFor(ttl) {
    return buildMessage({
      flags: RESPONSE_FLAGS,
      answers: [addressRecord(this.name, this.address, ttl)],
      additionals: [
        pointerRecord(this.service, this.instanceName, ttl === 0 ? 0 : SERVICE_TTL),
        serviceRecord(this.instanceName, this.name, this.port, ttl),
        textRecord(this.instanceName, ['path=/dsh-access'], ttl),
      ],
    })
  }

  /** Announce once; a no-op before the socket exists. */
  announce() {
    if (this.socket === null) return
    this.sendPacket(this.packetFor(ALIAS_TTL), null, false)
  }

  /**
   * Handle one inbound packet: answer a question this publisher owns, or note a
   * conflicting address claim for its own name.
   * @param {Buffer} buf - the packet.
   * @param {{ address: string, port: number }} rinfo - the sender.
   */
  onMessage(buf, rinfo) {
    let message
    try {
      message = parseMessage(buf)
    } catch {
      return
    }
    if ((message.flags & 0x8000) !== 0) {
      this.checkConflict(message)
      return
    }
    const question = message.questions[0]
    if (question === undefined) return
    const answer = answerFor(question, {
      name: this.name,
      address: this.address,
      port: this.port,
      instance: this.instanceName,
      service: this.service,
    })
    if (answer === null) return
    const packet = buildMessage({ flags: RESPONSE_FLAGS, answers: answer.answers, additionals: answer.additionals })
    this.sendPacket(packet, rinfo, question.unicast)
  }

  /** Report (without defending) an A record for our name that is not our address. */
  checkConflict(message) {
    for (const record of message.answers) {
      if (record.type !== RECORD.A || record.ttl === 0 || record.rdata.length !== 4) continue
      if (record.name.toLowerCase() !== this.name) continue
      const claimed = [...record.rdata].join('.')
      if (claimed === this.address) continue
      if (this.state.conflict) return
      this.state.conflict = true
      this.logger.warn?.('web-access: mDNS alias %s is also claimed by %s', this.name, claimed)
    }
  }

  /**
   * Send a packet: unicast when the asker requested it or uses a legacy port,
   * otherwise multicast from every local interface.
   * @param {Buffer} packet - the wire message.
   * @param {{ address: string, port: number } | null} rinfo - the asker, if any.
   * @param {boolean} unicast - whether the question carried the QU bit.
   */
  sendPacket(packet, rinfo, unicast) {
    if (this.socket === null) return
    if (this.group === null || unicast) {
      if (rinfo !== null) this.socket.send(packet, rinfo.port, rinfo.address)
      return
    }
    // One copy per interface: a `dgram` socket cannot see which interface the
    // query arrived on, and a resolver ignores an answer whose source address
    // is not on its own subnet.
    for (const address of this.interfaceAddresses()) {
      try {
        this.socket.setMulticastInterface(address)
      } catch {
        // an address that disappeared between calls is not fatal
      }
      this.socket.send(packet, this.mdnsPort, this.group)
    }
    // A legacy resolver asks from an ephemeral port and expects unicast back.
    if (rinfo !== null && rinfo.port !== this.mdnsPort) this.socket.send(packet, rinfo.port, rinfo.address)
  }
}
