/**
 * Flush jsDelivr's cache for the market index, then show what the CDN now serves.
 *
 * The index URL in DSH points at `cdn.jsdelivr.net/gh/<owner>/<repo>@master/...`,
 * and jsDelivr caches a mutable branch for hours. A publish that is pushed but
 * not purged therefore keeps advertising the previous versions, so DSH's
 * "Refresh" in Discover still sees the old document and never offers an update.
 *
 * Run this **after** `git push`: purging before the push makes the CDN re-cache
 * the old document instead.
 *
 * Usage:
 *   node tools/purge-market-cdn.mjs
 *   node tools/purge-market-cdn.mjs --ref main --file plugin-market.json
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 || args[at + 1] === undefined ? fallback : args[at + 1]
}

const ref = option('ref', 'master')
const file = option('file', 'plugin-market.json')
const timeoutMs = Number(option('timeout', '30000'))

/** `owner/repo` from the origin remote, the same shape jsDelivr's gh endpoint takes. */
function repositoryPath() {
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim()
  const match = /^(?:git\+)?(?:https?|git|ssh):\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/.exec(remote)
  if (match === null) throw new Error(`unsupported git remote: ${remote}`)
  return match[2]
}

const repo = repositoryPath()
const cdn = `https://cdn.jsdelivr.net/gh/${repo}@${ref}/${file}`
const purge = `https://purge.jsdelivr.net/gh/${repo}@${ref}/${file}`

console.log(`purging ${purge}`)
const purged = await fetch(purge, { signal: AbortSignal.timeout(timeoutMs) })
if (!purged.ok) throw new Error(`purge failed: ${purged.status} ${purged.statusText}`)
const report = await purged.json()
console.log(`purge ${report.status ?? 'ok'}`)

// The purge reports completion before every edge has the new document, and it
// re-reads from GitHub, so a push that never landed still shows here.
const started = Date.now()
let index
for (let attempt = 0; attempt < 5; attempt += 1) {
  const response = await fetch(cdn, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`index fetch failed: ${response.status} ${response.statusText}`)
  index = await response.json()
  const head = execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8' })
  if (JSON.stringify(index) === JSON.stringify(JSON.parse(head))) break
  await new Promise((resolve) => setTimeout(resolve, 2000))
}
if (index === undefined) throw new Error('the CDN returned no document')

const local = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
const same = JSON.stringify(index) === JSON.stringify(local)
console.log(`CDN now serves ${index.plugins.length} plugins (${same ? 'matches' : 'DIFFERS FROM'} the working tree)`)
for (const plugin of index.plugins) {
  const version = plugin.versions[0]
  console.log(`- ${plugin.name}@${version.version} ${version.source.commit.slice(0, 7)}`)
}
if (!same) {
  console.log('')
  console.log('The CDN document is not the committed one. Push first, then purge again.')
  process.exitCode = 1
}
console.log(`done in ${Date.now() - started} ms`)
