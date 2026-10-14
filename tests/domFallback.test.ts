import { describe, it, expect } from 'vitest';
import { resolveAnswerTopicWithFallback } from '../src/lib/domFallback.js';

const pick = (matchedKey: string | null) => async () => JSON.stringify({ matchedKey });

describe('resolveAnswerTopicWithFallback value handling', () => {
  it('returns null (not undefined) when the matched topic has an undefined value', async () => {
    const topics = [{ key: 'k', description: 'd', value: undefined as unknown as string }];
    const r = await resolveAnswerTopicWithFallback('q', topics, { runClaude: pick('k') });
    expect(r).toBeNull();
  });

  it('preserves empty string, 0 and false', async () => {
    const topics = [
      { key: 's', description: 'd', value: '' },
      { key: 'n', description: 'd', value: 0 },
      { key: 'b', description: 'd', value: false },
    ];
    expect(await resolveAnswerTopicWithFallback('q', topics, { runClaude: pick('s') })).toBe('');
    expect(await resolveAnswerTopicWithFallback('q', topics, { runClaude: pick('n') })).toBe(0);
    expect(await resolveAnswerTopicWithFallback('q', topics, { runClaude: pick('b') })).toBe(false);
  });

  it('returns null when no topic matches', async () => {
    const topics = [{ key: 'k', description: 'd', value: 'v' }];
    expect(await resolveAnswerTopicWithFallback('q', topics, { runClaude: pick('zzz') })).toBeNull();
  });
});
