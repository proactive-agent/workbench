import { describe, it, expect } from 'vitest';
import { zodSchema } from 'ai';

import { SynthesisResultOutputSchema } from '../pr-review.output';
import { SynthesisResultSchema } from '../../pr-review';

describe('synthesis removalReasons', () => {
  it('reaches the provider as an array of reasons, not a closed empty object', () => {
    // zodSchema() is the conversion the AI SDK actually sends to providers
    const schema = zodSchema(SynthesisResultOutputSchema).jsonSchema as {
      properties: Record<string, { type?: string; items?: { properties?: Record<string, unknown> } }>;
    };
    const removalReasons = schema.properties.removalReasons;

    expect(removalReasons.type).toBe('array');
    expect(Object.keys(removalReasons.items?.properties ?? {})).toEqual(['findingId', 'reason']);
  });

  it('parses both the array form and the legacy map form into a map', () => {
    const fromArray = SynthesisResultSchema.parse({
      verdict: 'needs_revision',
      removal_reasons: [{ finding_id: 'PR-1', reason: 'duplicate' }, { findingId: 'PR-2', reason: 'false positive' }],
    });
    const fromMap = SynthesisResultSchema.parse({ removalReasons: { 'PR-3': 'out of scope' } });

    expect(fromArray.removalReasons).toEqual({ 'PR-1': 'duplicate', 'PR-2': 'false positive' });
    expect(fromMap.removalReasons).toEqual({ 'PR-3': 'out of scope' });
  });
});
