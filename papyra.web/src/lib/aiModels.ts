import type { AiModelChoice } from '../hooks/useAi';

/**
 * Turning model identifiers into something a person can read.
 *
 * Papyra never shows a model tag in its ordinary interface — "mistral-nemo:12b"
 * tells a self-hoster nothing about whether the assistant is set up well. The
 * three curated models have plain names (Small, Balanced, Best), so an installed
 * model is described by whichever of those it is, and anything else is simply
 * "another model" until someone opens the technical details.
 */

/**
 * Whether two model identifiers mean the same model. Mirrors
 * `AiClient.HasModel`: Ollama reports "llama3.1:8b", and a bare name means the
 * `:latest` tag, so "llama3.1" and "llama3.1:latest" are one model.
 */
export function sameModel(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (m: string) => (m.includes(':') ? m : `${m}:latest`).toLowerCase();
  return norm(a) === norm(b);
}

/** The curated choice this identifier refers to, if it is one of them. */
export function choiceFor(model: string | null | undefined, choices: AiModelChoice[] | undefined): AiModelChoice | null {
  if (!model) return null;
  return choices?.find(c => sameModel(c.model, model)) ?? null;
}

/**
 * What to call a model on screen: its tier name when Papyra offers it, else a
 * neutral phrase. Never the raw identifier — that lives behind "technical
 * details", where somebody debugging will go looking for it.
 */
export function friendlyModelName(
  model: string | null | undefined,
  choices: AiModelChoice[] | undefined,
): string {
  if (!model) return 'None chosen yet';
  return choiceFor(model, choices)?.tier ?? 'Another model you installed';
}

/** Where answers are actually produced, in words rather than a URL. */
export function providerLabel(provider: string | null | undefined): string {
  switch (provider) {
    case 'openai': return 'OpenAI';
    case 'anthropic': return 'Anthropic';
    case 'ollama': return 'This machine';
    default: return 'Not set up yet';
  }
}

/**
 * The address answers come from. A local model has a real URL worth showing —
 * a self-hoster who has moved the model engine to another box needs to see
 * which one Papyra is talking to. The paid services have no address worth
 * printing, so they say who rather than where.
 */
export function endpointLabel(
  provider: string | null | undefined,
  ollamaBaseUrl: string,
  openAiBaseUrl: string,
): string {
  switch (provider) {
    case 'openai': return openAiBaseUrl || 'OpenAI’s servers';
    case 'anthropic': return 'Anthropic’s servers';
    case 'ollama': return ollamaBaseUrl || 'Not set';
    default: return 'Not set';
  }
}
