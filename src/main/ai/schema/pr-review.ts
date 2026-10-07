/**
 * MR Review Schemas
 * =================
 *
 * Zod schemas for validating and coercing LLM-generated GitLab MR review data.
 *
 * LLMs produce field name variations (snake_case vs camelCase, etc.).
 * All schemas use `z.preprocess()` to coerce known aliases and `.passthrough()`
 * to preserve unknown fields added by different models.
 */

import { z } from 'zod';

// =============================================================================
// ReviewFindingSchema — Individual finding from any pass
// =============================================================================

function coerceReviewFinding(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const raw = input as Record<string, unknown>;

  return {
    ...raw,
    // Coerce suggestedFix: accept suggested_fix as alias
    suggestedFix: raw.suggestedFix ?? raw.suggested_fix,
    // Coerce endLine: accept end_line as alias
    endLine: raw.endLine ?? raw.end_line,
    // Coerce verificationNote: accept verification_note as alias
    verificationNote: raw.verificationNote ?? raw.verification_note,
  };
}

export const ReviewFindingSchema = z.preprocess(
  coerceReviewFinding,
  z.object({
    id: z.string().default(''),
    severity: z.string().default('low'),
    category: z.string().default('quality'),
    title: z.string().default(''),
    description: z.string().default(''),
    file: z.string().default(''),
    line: z.number().default(0),
    endLine: z.number().optional(),
    suggestedFix: z.string().optional(),
    fixable: z.boolean().default(false),
    evidence: z.string().optional(),
    verificationNote: z.string().optional(),
  }).passthrough(),
);

export type ValidatedReviewFinding = z.infer<typeof ReviewFindingSchema>;

// =============================================================================
// MRReviewResultSchema — Full MR review response
// =============================================================================

function coerceMRReviewResult(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const raw = input as Record<string, unknown>;

  // Coerce findings: accept array or single object
  let findings = raw.findings;
  if (!Array.isArray(findings)) {
    findings = findings ? [findings] : [];
  }

  return {
    ...raw,
    // Coerce verdictReasoning: accept verdict_reasoning as alias
    verdictReasoning: raw.verdictReasoning ?? raw.verdict_reasoning ?? '',
    findings,
  };
}

export const MRReviewResultSchema = z.preprocess(
  coerceMRReviewResult,
  z.object({
    summary: z.string().default(''),
    verdict: z.string().default('ready_to_merge'),
    verdictReasoning: z.string().default(''),
    findings: z.array(ReviewFindingSchema).default([]),
  }).passthrough(),
);

export type ValidatedMRReviewResult = z.infer<typeof MRReviewResultSchema>;
