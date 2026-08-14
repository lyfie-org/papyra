import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

// The AI provider: what it is, whether it works, and how to fix it when it doesn't.
//
// Papyra runs on a local Ollama model by default, but an admin can point the
// instance at OpenAI or Anthropic instead. Either way the assistant needs to be
// able to say *why* it can't answer — "no model installed" and "your key was
// rejected" call for different things from the user.
//
// API keys are write-only over this API: the server reports whether one is stored,
// never its value, so a blank field on save means "keep what you have".

export interface AiStatus {
  chatProvider: string;
  embedProvider: string;
  chatModel: string;
  embedModel: string;
  /** The chat backend is configured and reachable. */
  ready: boolean;
  /** Plain-English explanation when `ready` is false. */
  reason: string | null;
  /** Ollama is running, so a model download can be offered. */
  canPull: boolean;
  installedModels: string[];
  semanticSearchReady: boolean;
}

export interface AiModelChoice {
  model: string;
  tier: string;
  size: string;
  blurb: string;
}

export interface AiConfig {
  chatProvider: string;
  embedProvider: string;
  ollamaBaseUrl: string;
  ollamaChatModel: string;
  ollamaEmbedModel: string;
  openAiBaseUrl: string;
  openAiChatModel: string;
  openAiEmbedModel: string;
  anthropicChatModel: string;
  hasOpenAiKey: boolean;
  hasAnthropicKey: boolean;
}

export interface AiConfigWrite extends Omit<AiConfig, 'hasOpenAiKey' | 'hasAnthropicKey'> {
  /** Omit to keep the stored key. */
  openAiKey?: string;
  /** Omit to keep the stored key. */
  anthropicKey?: string;
}

/** One frame of a model download. */
export interface PullProgress {
  status: string;
  completed: number;
  total: number;
  error: string | null;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return res.json();
}

export const AI_STATUS_KEY = ['ai-status'] as const;
export const AI_CONFIG_KEY = ['ai-config'] as const;
export const AI_MODELS_KEY = ['ai-models'] as const;

/**
 * Whether the assistant can answer. Enabled lazily so opening a note doesn't
 * probe a possibly-unreachable backend — the panel asks when it opens.
 */
export function useAiStatus(enabled = true) {
  return useQuery({
    queryKey: AI_STATUS_KEY,
    queryFn: () => getJson<AiStatus>('/api/ai/status'),
    enabled,
    // The probe hits the network; don't re-run it on every window focus.
    staleTime: 30_000,
  });
}

export function useAiModels(enabled = true) {
  return useQuery({
    queryKey: AI_MODELS_KEY,
    queryFn: () => getJson<AiModelChoice[]>('/api/ai/models'),
    enabled,
    staleTime: Infinity, // static metadata
  });
}

export function useAiConfig(enabled = true) {
  return useQuery({
    queryKey: AI_CONFIG_KEY,
    queryFn: () => getJson<AiConfig>('/api/ai/config'),
    enabled,
  });
}

export function useSaveAiConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (next: AiConfigWrite) => {
      const res = await fetch('/api/ai/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Save failed: ${res.status}`);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: AI_CONFIG_KEY });
      // The provider may have changed — the assistant's answer to "can you work?"
      // is now stale everywhere it's shown.
      qc.invalidateQueries({ queryKey: AI_STATUS_KEY });
    },
  });
}

/**
 * Download a model, reporting byte progress as it goes.
 *
 * A model is several gigabytes, so this reports real progress rather than an
 * indeterminate spinner — an unexplained ten-minute wait reads as a hang.
 */
export function usePullModel(onProgress: (p: PullProgress) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (model: string) => {
      const res = await fetch('/api/ai/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Download failed: ${res.status}`);
      }

      // NDJSON, one progress frame per line.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // keep the partial line for the next chunk
        for (const line of lines) {
          if (!line.trim()) continue;
          const frame = JSON.parse(line) as PullProgress;
          if (frame.error) throw new Error(frame.error);
          onProgress(frame);
        }
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: AI_STATUS_KEY }),
  });
}
