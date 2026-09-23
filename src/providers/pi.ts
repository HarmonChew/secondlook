import { createModels, type Context, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { groqProvider } from '@earendil-works/pi-ai/providers/groq';
import { mistralProvider } from '@earendil-works/pi-ai/providers/mistral';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import type { ModelProviderInfo, ModelSelection } from '../contracts.ts';

// Provider URLs and credential references are host-owned. Tickets select only
// catalog IDs; they cannot supply URLs, headers, secrets, or executable config.
const providers = [
  { factory: openaiProvider, apiKeyEnv: 'OPENAI_API_KEY' },
  { factory: anthropicProvider, apiKeyEnv: 'ANTHROPIC_API_KEY' },
  { factory: googleProvider, apiKeyEnv: 'GEMINI_API_KEY' },
  { factory: openrouterProvider, apiKeyEnv: 'OPENROUTER_API_KEY' },
  { factory: groqProvider, apiKeyEnv: 'GROQ_API_KEY' },
  { factory: mistralProvider, apiKeyEnv: 'MISTRAL_API_KEY' },
  { factory: xaiProvider, apiKeyEnv: 'XAI_API_KEY' },
].map(({ factory, apiKeyEnv }) => ({ provider: factory(), apiKeyEnv }));

// No ambient credentials, OAuth files, login flows, or catalog network refresh.
// The supervised worker supplies exactly one selected API key per request.
const models = createModels({
  authContext: { env: async () => undefined, fileExists: async () => false },
});
for (const { provider } of providers) models.setProvider(provider);

export function listModelProviders(env: NodeJS.ProcessEnv = process.env): ModelProviderInfo[] {
  return providers.map(({ provider, apiKeyEnv }) => ({
    id: provider.id,
    name: provider.name,
    apiKeyEnv,
    configured: (env[apiKeyEnv]?.trim().length ?? 0) >= 4,
    models: models.getModels(provider.id).map(model => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
    })).sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

export function resolvePiModel(selection: ModelSelection) {
  const entry = providers.find(({ provider }) => provider.id === selection.provider);
  const model = entry && models.getModel(selection.provider, selection.id);
  if (!entry || !model) throw new Error('Unknown Pi provider or model. Select a model from the current catalog.');
  return { model, apiKeyEnv: entry.apiKeyEnv };
}

/** The only Engine-to-Pi request boundary; tools are executed by Engine. */
export function streamPiModel(selection: ModelSelection, context: Context, options: Pick<SimpleStreamOptions, 'signal' | 'apiKey' | 'fetch'>) {
  const { model } = resolvePiModel(selection);
  if (!options.apiKey || options.apiKey.trim().length < 4) throw new Error('The selected provider API key is unavailable.');
  return models.streamSimple(model, context, {
    ...options,
    maxTokens: Math.min(model.maxTokens, 16_384),
    timeoutMs: 120_000,
    maxRetries: 0,
    maxRetryDelayMs: 1_000,
    transport: 'sse',
  });
}
