/**
 * Stable identifiers, kept in one place so the bundle patch, the routes and the
 * loader row id cannot drift apart.
 *
 * @module dsh-model-proxy/constants
 */

/** The plugin name, which is also the Loader row id this plugin owns. */
export const name = 'model-proxy'

/** Where the panel is served. */
export const PANEL_PATH = '/model-proxy'

/** Where the panel posts a new configuration. */
export const APPLY_PATH = '/model-proxy/apply'

/** Machine-readable view of the current state, for scripting the switch. */
export const STATUS_PATH = '/model-proxy/status'
