/**
 * Regenerate `plugin-market.json` for DSH's custom plugin marketplace.
 *
 * The document is format 1 of `@deepseek-ai/dsh-plugin-market-index`: a JSON
 * index of installable bundles with display metadata. This repository hosts one
 * bundle per directory, so the generator derives the mechanical fields from
 * each `package.json` and from git, and keeps the editorial fields (titles,
 * descriptions, categories, labels, keywords, icons) from the previous index.
 *
 * Usage:
 *   node tools/gen-market-index.mjs
 *
 * Re-run it after changing a plugin's version, and commit the result. Versions
 * are pinned to the current `HEAD` commit, so the index and the code it names
 * stay consistent even if `master` moves later.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const indexFile = path.join(root, 'plugin-market.json')

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

/** The public repository URL without a `.git` suffix, as format 1 requires. */
function repositoryUrl() {
  const remote = git('remote', 'get-url', 'origin')
  const match = /^(?:git\+)?(?:https?|git|ssh):\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/.exec(remote)
  if (match === null) throw new Error(`unsupported git remote: ${remote}`)
  const [, host, repo] = match
  return `https://${host}/${repo}`
}

const previous = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : undefined
const head = git('rev-parse', 'HEAD')
const url = repositoryUrl()

/** One directory per bundle: a package manifest that declares a DSH bundle patch. */
const plugins = []
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.')) continue
  const manifestPath = path.join(root, entry.name, 'package.json')
  if (!fs.existsSync(manifestPath)) continue
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.dsh === undefined) continue
  plugins.push({ directory: entry.name, manifest })
}

plugins.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name))

const versions = (plugin) => [
  {
    version: plugin.manifest.version,
    // Unix seconds of the last commit that touched this plugin directory.
    publishTimestamp: Number(git('log', '-1', '--format=%ct', '--', plugin.directory)),
    source: {
      type: 'git',
      url,
      commit: head,
      path: plugin.directory,
    },
  },
]

const retained = new Map((previous?.plugins ?? []).map((plugin) => [plugin.name, plugin]))
const merged = plugins.map((plugin) => {
  const before = retained.get(plugin.manifest.name)
  const entry = {
    name: plugin.manifest.name,
    title: before?.title ?? { en: plugin.manifest.name },
    ...(before?.description === undefined ? { description: { en: plugin.manifest.description ?? plugin.manifest.name } } : { description: before.description }),
    ...(before?.icon === undefined ? {} : { icon: before.icon }),
    ...(before?.author === undefined ? {} : { author: before.author }),
    ...(before?.homepage === undefined ? {} : { homepage: before.homepage }),
    ...(before?.repository === undefined ? {} : { repository: before.repository }),
    metadata: before?.metadata ?? {},
    versions: versions(plugin),
  }
  return entry
})

const index = {
  format: 1,
  title: previous?.title ?? { en: 'DSH plugins' },
  ...(previous?.description === undefined ? {} : { description: previous.description }),
  metadata: previous?.metadata ?? {},
  plugins: merged,
}

fs.writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`)
console.log(`wrote ${path.relative(root, indexFile)} with ${merged.length} plugins at ${head.slice(0, 7)}`)
