import { describe, it, expect } from 'vitest';
import type { AiModelChoice } from '../hooks/useAi';
import { choiceFor, endpointLabel, friendlyModelName, providerLabel, sameModel } from './aiModels';

// Mirrors AiClient.ChatModelChoices — the three models Papyra offers.
const CHOICES: AiModelChoice[] = [
  { model: 'llama3.2:1b', tier: 'Small', size: '1.3 GB', memory: '2 GB', blurb: '' },
  { model: 'llama3.1:8b', tier: 'Balanced', size: '4.7 GB', memory: '8 GB', blurb: '' },
  { model: 'mistral-nemo:12b', tier: 'Best', size: '7.1 GB', memory: '12 GB', blurb: '' },
];

describe('sameModel', () => {
  it('treats a bare name as the latest tag, the way the engine does', () => {
    // The server's AiClient.HasModel makes the same call; if these two disagree,
    // the UI shows "Download" for a model that is already installed.
    expect(sameModel('llama3.1', 'llama3.1:latest')).toBe(true);
    expect(sameModel('llama3.1:latest', 'llama3.1')).toBe(true);
  });

  it('does not confuse two sizes of the same family', () => {
    expect(sameModel('llama3.1:8b', 'llama3.1:70b')).toBe(false);
    expect(sameModel('llama3.1:8b', 'llama3.2:1b')).toBe(false);
  });

  it('ignores case', () => {
    expect(sameModel('Llama3.1:8B', 'llama3.1:8b')).toBe(true);
  });

  it('is false when either side is missing', () => {
    expect(sameModel(null, 'llama3.1:8b')).toBe(false);
    expect(sameModel('llama3.1:8b', undefined)).toBe(false);
    expect(sameModel('', '')).toBe(false);
  });
});

describe('friendlyModelName', () => {
  it('names the curated models by their tier, never their identifier', () => {
    expect(friendlyModelName('llama3.2:1b', CHOICES)).toBe('Small');
    expect(friendlyModelName('llama3.1:8b', CHOICES)).toBe('Balanced');
    expect(friendlyModelName('mistral-nemo:12b', CHOICES)).toBe('Best');
  });

  it('says something neutral about a model Papyra did not install', () => {
    // A self-hoster who pulled their own model should not meet a raw tag in the
    // sentence describing what is answering their questions.
    expect(friendlyModelName('qwen2.5:14b', CHOICES)).toBe('Another model you installed');
  });

  it('says nothing is chosen when nothing is', () => {
    expect(friendlyModelName(null, CHOICES)).toBe('None chosen yet');
    expect(friendlyModelName('', CHOICES)).toBe('None chosen yet');
  });

  it('survives the choices not having loaded yet', () => {
    expect(friendlyModelName('llama3.1:8b', undefined)).toBe('Another model you installed');
  });
});

describe('choiceFor', () => {
  it('finds the card an installed model belongs to', () => {
    expect(choiceFor('llama3.1:8b', CHOICES)?.tier).toBe('Balanced');
    expect(choiceFor('llama3.1', CHOICES)).toBeNull();  // a different tag entirely
    expect(choiceFor('qwen2.5:14b', CHOICES)).toBeNull();
  });
});

describe('providerLabel', () => {
  it('says who is answering in words', () => {
    expect(providerLabel('ollama')).toBe('This machine');
    expect(providerLabel('openai')).toBe('OpenAI');
    expect(providerLabel('anthropic')).toBe('Anthropic');
    expect(providerLabel(undefined)).toBe('Not set up yet');
  });
});

describe('endpointLabel', () => {
  const local = 'http://localhost:11434';
  const openAi = 'https://api.openai.com/v1';

  it('shows the local address, which a self-hoster may have moved', () => {
    expect(endpointLabel('ollama', local, openAi)).toBe(local);
  });

  it('names the paid services rather than printing a URL nobody needs', () => {
    expect(endpointLabel('anthropic', local, openAi)).toBe('Anthropic’s servers');
    expect(endpointLabel('openai', local, openAi)).toBe(openAi);
    expect(endpointLabel('openai', local, '')).toBe('OpenAI’s servers');
  });

  it('does not claim an address it does not have', () => {
    expect(endpointLabel('ollama', '', openAi)).toBe('Not set');
    expect(endpointLabel(undefined, local, openAi)).toBe('Not set');
  });
});
