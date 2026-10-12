/**
 * Build the decision-model request from a page observation.
 *
 * Ported 1:1 from openjev/browser/format.py.
 */

import {
  Observation,
  ElementInfo,
  elementLabel,
  describeElement,
} from './observe.js'

export const NONE_LABEL = 'E0'
export const NONE_DESCRIPTION = 'None of the listed elements accomplishes the goal.'

export const INSTRUCTIONS =
  'You are a browser agent. Choose the single element to click in order to accomplish this goal: {goal}'

/** State string shown to the model: title, url, headings. */
export function buildState(observation: Observation): string {
  const parts = [`Web page: ${observation.title}\nURL: ${observation.url}`]
  const headings = observation.headings.filter(Boolean).slice(0, 3)
  if (headings.length > 0) parts.push(`Headings: ${headings.join(' | ')}`)
  if (observation.truncatedFrom) {
    parts.push(
      `(Showing ${observation.elements.length} of ${observation.truncatedFrom} interactive elements; scroll for more.)`,
    )
  }
  return parts.join('\n')
}

/** The /v1/systemone request body for one picking decision. */
export function buildRequest(goal: string, observation: Observation) {
  const criteria: Record<string, string> = {}
  for (const el of observation.elements) {
    criteria[elementLabel(el)] = `${el.name} - ${describeElement(el)}`
  }
  criteria[NONE_LABEL] = NONE_DESCRIPTION
  return {
    state: buildState(observation),
    questions: {
      target: {
        type: 'choice',
        instructions: INSTRUCTIONS.replace('{goal}', goal),
        criteria,
      },
    },
  }
}

/**
 * Rough request-size estimate (chars/4) so callers can report what a pick
 * would have cost. No tokenizer round-trip.
 */
export function estimateTokens(request: ReturnType<typeof buildRequest>): number {
  let total = request.state.length + request.questions.target.instructions.length
  for (const [key, value] of Object.entries(request.questions.target.criteria)) {
    total += key.length + value.length + 24
  }
  return Math.max(1, Math.floor(total / 4))
}

/** Map a decision choice label back to an element ('E0' -> null = abstain). */
export function elementForChoice(
  elements: ElementInfo[],
  choice: string | null | undefined,
): ElementInfo | null {
  if (!choice || choice === NONE_LABEL) return null
  if (!choice.startsWith('E')) return null
  const index = Number.parseInt(choice.slice(1), 10)
  if (!Number.isFinite(index) || index < 1 || index > elements.length) return null
  return elements[index - 1]
}
