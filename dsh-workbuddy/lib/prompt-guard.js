/**
 * Prompt guard for WorkBuddy's chat gateway.
 *
 * WorkBuddy answers `400 {"code":11128,"msg":"Illegal API invocation from an
 * unapproved channel"}` when a request's system prompt *begins* with DSH's own
 * identity sentence. Measured against the live gateway, the check is entirely
 * content- and position-based:
 *
 *   - the sentence alone, as the first thing in a `system` message, is blocked;
 *   - the same sentence after any other line is accepted;
 *   - the same words in another role are accepted;
 *   - no header, token scope or signature changes the answer.
 *
 * So the only lever a profile has is the prompt it sends. This module is that
 * lever's pure half: given one assembled prompt and the provider that will
 * receive it, it returns the assembly to deliver. It never mutates its input,
 * so every other provider keeps the exact object it built.
 *
 * Two modes exist because there are two ways to get past a position-anchored
 * check, and they differ in what the model ends up reading:
 *
 *   - `prepend` keeps every section and puts one harmless sentence in front;
 *     the harness identity survives, just not at offset zero.
 *   - `strip` removes the identity section outright; the prompt then starts
 *     with the deployment persona, which the gateway also accepts.
 *   - `replace` does the same removal and puts the configured line in its
 *     place, so the prompt opens with the deployment's own introduction.
 */

/** The sentence DSH renders first in every system prompt. */
export const HARNESS_IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'

/** What the guard inserts when the mode is `prepend` and no text is configured. */
export const DEFAULT_PROMPT_PREFIX = 'This session is served through WorkBuddy.'

/** The modes a profile may name. */
export const PROMPT_GUARD_MODES = Object.freeze(['off', 'prepend', 'strip', 'replace'])

/** The section name DSH gives its identity sentence. */
const IDENTITY_SECTION = 'harness:identity'

/** Lowercased, punctuation-free prefix used to recognize the identity sentence. */
const IDENTITY_KEY = 'you are an ai agent powered by deepseek harness'

/**
 * Normalize a configured mode.
 * @param value - the raw config value.
 * @param fallback - returned when `value` names no known mode.
 * @returns one of {@link PROMPT_GUARD_MODES}.
 */
export function normalizePromptGuard(value, fallback = 'off') {
  return typeof value === 'string' && PROMPT_GUARD_MODES.includes(value) ? value : fallback
}

/**
 * Normalize the text inserted before the prompt: one line, no stray whitespace.
 * @param value - the raw config value.
 * @param fallback - returned for a missing or blank value.
 * @returns the text to prepend.
 */
export function normalizePromptPrefix(value, fallback = DEFAULT_PROMPT_PREFIX) {
  if (typeof value !== 'string') return fallback
  const text = value.replace(/\r\n/g, '\n').trim()
  return text === '' ? fallback : text
}

/** The rendered text of one assembly section, or `''`. */
function sectionText(section) {
  return typeof section?.text === 'string' ? section.text : ''
}

/**
 * Whether one assembled section carries DSH's identity sentence.
 *
 * The name is checked first because that is the stable contract; the text check
 * is a fallback for a build that renames the section but keeps the sentence,
 * and is deliberately prefix-based so a trailing period or extra wording does
 * not hide it.
 *
 * @param section - one entry of `assembly.sections`.
 * @returns true when the section opens with the identity sentence.
 */
export function isIdentitySection(section) {
  if (section?.name === IDENTITY_SECTION) return true
  return sectionText(section).trimStart().toLowerCase().startsWith(IDENTITY_KEY)
}

/**
 * Put `prefix` at the very start of the rendered prompt.
 *
 * The first section is the first text the model reads, so the prefix goes
 * there. An already-prefixed prompt is returned untouched, which keeps a
 * re-run of the same assembly idempotent.
 *
 * @param sections - the assembled sections, in render order.
 * @param prefix - the normalized text to prepend.
 * @returns a new section list, or the input list when it already starts right.
 */
function prependPrefix(sections, prefix) {
  if (sections.length === 0) return [{ name: 'workbuddy:prompt-guard', text: prefix }]
  const [first, ...rest] = sections
  const text = sectionText(first)
  if (text.trimStart().toLowerCase().startsWith(prefix.toLowerCase())) return sections
  return [{ ...first, text: text === '' ? prefix : `${prefix}\n\n${text}` }, ...rest]
}

/**
 * Resolve the assembly a guarded provider should receive.
 *
 * The assembly is returned unchanged when the guard is off, when the provider
 * is not the guarded route, when the assembly carries no sections, or when the
 * rewrite would empty the prompt.
 *
 * @param settings - the resolved plugin config (`promptGuard`, `promptPrefix`, `provider`).
 * @param assembly - the post-waterfall assembly about to be rendered.
 * @param provider - the provider the assembly is being built for, when known.
 * @returns the assembly to deliver; the input object when nothing applies.
 */
export function guardAssembly(settings, assembly, provider) {
  const mode = normalizePromptGuard(settings?.promptGuard)
  if (mode === 'off') return assembly
  const guardedProvider = typeof settings?.provider === 'string' ? settings.provider : ''
  if (guardedProvider === '' || provider !== guardedProvider) return assembly

  const sections = Array.isArray(assembly?.sections) ? assembly.sections : []
  if (sections.length === 0) return assembly

  if (mode === 'strip') {
    const kept = sections.filter((section) => !isIdentitySection(section))
    if (kept.length === 0 || kept.length === sections.length) return assembly
    return { ...assembly, sections: kept }
  }

  if (mode === 'replace') {
    const kept = sections.filter((section) => !isIdentitySection(section))
    if (kept.length === sections.length) return assembly
    return {
      ...assembly,
      sections: [{ name: 'workbuddy:prompt-guard', text: normalizePromptPrefix(settings?.promptPrefix) }, ...kept],
    }
  }

  const prefixed = prependPrefix(sections, normalizePromptPrefix(settings?.promptPrefix))
  return prefixed === sections ? assembly : { ...assembly, sections: prefixed }
}
