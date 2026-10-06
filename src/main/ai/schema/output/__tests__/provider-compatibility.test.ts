/**
 * Provider JSON Schema Compatibility Tests
 * ==========================================
 *
 * Validates that all output schemas (used with AI SDK Output.object() for
 * constrained decoding) produce JSON Schemas compatible with major providers.
 *
 * Background: Different providers restrict which JSON Schema features they
 * support in structured output mode. For example, OpenAI does not support
 * `propertyNames`, `patternProperties`, or `$ref`. These tests catch
 * incompatibilities at build time rather than at runtime (where they surface
 * as 400 errors that silently break entire features like PR review).
 *
 * Reference incident: `z.record(z.string(), z.string())` generated
 * `propertyNames` which caused OpenAI to reject the SynthesisResultOutputSchema
 * with a 400, silently breaking PR review synthesis.
 */

import { describe, it, expect } from 'vitest';
import { toJSONSchema } from 'zod';
import type { ZodSchema } from 'zod';

import {
  ComplexityAssessmentOutputSchema,
  ImplementationPlanOutputSchema,
  QASignoffOutputSchema,
  ScanResultOutputSchema,
  ReviewFindingsOutputSchema,
  StructuralIssuesOutputSchema,
  AICommentTriagesOutputSchema,
  SpecialistOutputOutputSchema,
  SynthesisResultOutputSchema,
  FindingValidationsOutputSchema,
  ResolutionVerificationOutputSchema,
  TriageResultOutputSchema,
  ExtractedInsightsOutputSchema,
} from '../index';

// =============================================================================
// Provider restriction definitions
// =============================================================================

/**
 * JSON Schema keywords that are NOT supported by OpenAI's structured output.
 * See: https://platform.openai.com/docs/guides/structured-outputs
 */
const OPENAI_UNSUPPORTED_KEYWORDS = [
  'propertyNames',
  'patternProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'dependentRequired',
  'minProperties',
  'maxProperties',
  'minContains',
  'maxContains',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
  '$anchor',
  '$dynamicAnchor',
  '$dynamicRef',
  '$vocabulary',
  '$comment',
] as const;

/**
 * JSON Schema keywords that are NOT supported by Google/Gemini's structured output.
 * Gemini uses a subset of OpenAPI 3.0 schema, which is more restrictive.
 */
const GOOGLE_UNSUPPORTED_KEYWORDS = [
  ...OPENAI_UNSUPPORTED_KEYWORDS,
  '$ref',
  'definitions',
  '$defs',
  'oneOf',
  'not',
] as const;

/**
 * Common keywords that should not appear in any provider-compatible output schema.
 * This is the intersection of restrictions across all providers we support.
 */
const UNIVERSAL_UNSUPPORTED_KEYWORDS = [
  'propertyNames',
  'patternProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'dependentRequired',
  '$anchor',
  '$dynamicAnchor',
  '$dynamicRef',
] as const;

// =============================================================================
// Test utilities
// =============================================================================

/**
 * Find all occurrences of forbidden keywords in a JSON Schema, returning
 * their paths for actionable error messages.
 */
function findForbiddenKeywords(
  schema: unknown,
  forbidden: readonly string[],
  path: string[] = [],
): Array<{ keyword: string; path: string }> {
  const violations: Array<{ keyword: string; path: string }> = [];

  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return violations;

  const obj = schema as Record<string, unknown>;

  for (const [key, value] of Object.entries(obj)) {
    if (forbidden.includes(key)) {
      violations.push({ keyword: key, path: [...path, key].join('.') });
    }

    // Recurse into nested schemas
    if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          violations.push(
            ...findForbiddenKeywords(value[i], forbidden, [...path, key, `[${i}]`]),
          );
        }
      } else {
        violations.push(
          ...findForbiddenKeywords(value, forbidden, [...path, key]),
        );
      }
    }
  }

  return violations;
}

/**
 * Convert a Zod schema to JSON Schema using Zod v4's built-in toJSONSchema()
 * and check it against a provider's list of unsupported keywords.
 */
function assertProviderCompatible(
  schemaName: string,
  zodSchema: ZodSchema,
  unsupportedKeywords: readonly string[],
  providerName: string,
): void {
  const jsonSchema = toJSONSchema(zodSchema);
  const violations = findForbiddenKeywords(jsonSchema, unsupportedKeywords);

  if (violations.length > 0) {
    const details = violations
      .map((v) => `  - "${v.keyword}" at ${v.path}`)
      .join('\n');
    throw new Error(
      `${schemaName} is incompatible with ${providerName} structured output.\n` +
      `Found unsupported JSON Schema keywords:\n${details}\n\n` +
      `Tip: Check the Zod type that maps to this keyword. Common fixes:\n` +
      `  - propertyNames → use z.object({}).catchall(z.string()) instead of z.record()\n` +
      `  - $ref/definitions → flatten recursive types\n` +
      `  - patternProperties → use z.record() with simpler key types`,
    );
  }
}

// =============================================================================
// All output schemas under test
// =============================================================================

const ALL_OUTPUT_SCHEMAS: Array<{ name: string; schema: ZodSchema }> = [
  { name: 'ComplexityAssessmentOutputSchema', schema: ComplexityAssessmentOutputSchema },
  { name: 'ImplementationPlanOutputSchema', schema: ImplementationPlanOutputSchema },
  { name: 'QASignoffOutputSchema', schema: QASignoffOutputSchema },
  { name: 'ScanResultOutputSchema', schema: ScanResultOutputSchema },
  { name: 'ReviewFindingsOutputSchema', schema: ReviewFindingsOutputSchema },
  { name: 'StructuralIssuesOutputSchema', schema: StructuralIssuesOutputSchema },
  { name: 'AICommentTriagesOutputSchema', schema: AICommentTriagesOutputSchema },
  { name: 'SpecialistOutputOutputSchema', schema: SpecialistOutputOutputSchema },
  { name: 'SynthesisResultOutputSchema', schema: SynthesisResultOutputSchema },
  { name: 'FindingValidationsOutputSchema', schema: FindingValidationsOutputSchema },
  { name: 'ResolutionVerificationOutputSchema', schema: ResolutionVerificationOutputSchema },
  { name: 'TriageResultOutputSchema', schema: TriageResultOutputSchema },
  { name: 'ExtractedInsightsOutputSchema', schema: ExtractedInsightsOutputSchema },
];

// =============================================================================
// Tests
// =============================================================================

describe('Output Schema Provider Compatibility', () => {
  describe('OpenAI compatibility', () => {
    for (const { name, schema } of ALL_OUTPUT_SCHEMAS) {
      it(`${name} should not use OpenAI-unsupported JSON Schema keywords`, () => {
        assertProviderCompatible(name, schema, OPENAI_UNSUPPORTED_KEYWORDS, 'OpenAI');
      });
    }
  });

  describe('Google/Gemini compatibility', () => {
    for (const { name, schema } of ALL_OUTPUT_SCHEMAS) {
      it(`${name} should not use Google-unsupported JSON Schema keywords`, () => {
        assertProviderCompatible(name, schema, GOOGLE_UNSUPPORTED_KEYWORDS, 'Google/Gemini');
      });
    }
  });

  describe('Universal provider compatibility', () => {
    for (const { name, schema } of ALL_OUTPUT_SCHEMAS) {
      it(`${name} should not use universally unsupported keywords`, () => {
        assertProviderCompatible(name, schema, UNIVERSAL_UNSUPPORTED_KEYWORDS, 'any provider');
      });
    }
  });

  describe('JSON Schema generation sanity', () => {
    for (const { name, schema } of ALL_OUTPUT_SCHEMAS) {
      it(`${name} should produce a valid JSON Schema with type object`, () => {
        const jsonSchema = toJSONSchema(schema) as Record<string, unknown>;
        expect(jsonSchema).toBeDefined();
        expect(jsonSchema.type).toBe('object');
        expect(jsonSchema.properties).toBeDefined();
      });
    }
  });

  describe('Regression: z.record() key type must not produce propertyNames', () => {
    it('SynthesisResultOutputSchema.removalReasons should not produce propertyNames', () => {
      const jsonSchema = toJSONSchema(SynthesisResultOutputSchema);
      const violations = findForbiddenKeywords(jsonSchema, ['propertyNames']);
      expect(violations).toEqual([]);
    });
  });
});
