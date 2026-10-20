/**
 * Stable identifiers, kept in one place so the bundle patch, the routes and the
 * loader row id cannot drift apart.
 *
 * @module dsh-model-proxy/constants
 */

/** The plugin name, which is also the Loader row id this plugin owns. */
export const name = 'model-proxy'

/** The stored config fields. See `config.js` for their meaning. */
export const CONFIG_FIELDS = ['proxy', 'models', 'log']

/**
 * Where the old standalone panel used to be served.
 *
 * It is only a redirect now: the page lives in Settings, but a bookmark or a
 * link from a log line should still land somewhere useful.
 */
export const PANEL_PATH = '/model-proxy'

/** Where the settings page writes a new configuration. */
export const APPLY_PATH = '/model-proxy/apply'

/** The current configuration, transport state and recent decisions, as JSON. */
export const STATUS_PATH = '/model-proxy/status'

/**
 * The models this deployment offers, so the page can render a list to tick
 * instead of asking the user to type model ids from memory.
 */
export const MODELS_PATH = '/model-proxy/models'
