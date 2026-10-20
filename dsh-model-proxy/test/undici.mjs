/**
 * Resolve an undici module for the self-tests.
 *
 * The plugin itself imports `undici` by bare specifier, which works when it is
 * installed as a package. These tests also run straight from a source checkout
 * that has no `node_modules`, so the resolution here is deliberately forgiving:
 *
 *   1. the bare specifier, when the plugin is installed
 *   2. `UNDICI_PATH`, an absolute path or file: URL to an undici copy
 *   3. skip, with an explanation, rather than fail
 *
 * Set `UNDICI_PATH` to the copy a running harness ships, e.g.
 * `UNDICI_PATH=C:/apps/dsh/resources/app.asar.unpacked/dsh/node_modules/undici/index.js`
 * — that is the copy whose dispatcher symbol the app's own `fetch` reads.
 *
 * @module dsh-model-proxy/test/undici
 */

/**
 * Load the undici module these tests should exercise.
 *
 * @returns {Promise<{ module: object } | { skip: string }>} the module, or why to skip.
 */
export async function resolveUndici() {
  try {
    return { module: await import('undici') }
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
  }

  const configured = process.env.UNDICI_PATH?.trim()
  if (configured !== undefined && configured !== '') {
    const url = configured.startsWith('file:') ? configured : `file:///${configured.replace(/\\/g, '/')}`
    try {
      return { module: await import(url) }
    } catch (error) {
      return { skip: `UNDICI_PATH is set but not loadable: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  return {
    skip: 'undici is not resolvable here; install this package or set UNDICI_PATH to an undici copy\'s index.js',
  }
}

/**
 * Report a skipped suite the same way a failure would be reported, so a silent
 * pass cannot hide a test that never ran.
 *
 * @param {string} suite the file name being skipped.
 * @param {string} reason why.
 */
export function reportSkip(suite, reason) {
  console.error(`${suite}: skipped — ${reason}`)
  process.exitCode = 2
}
