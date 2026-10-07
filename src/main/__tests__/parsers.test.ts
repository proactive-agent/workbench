/**
 * Phase Parsers Tests
 * ====================
 * Unit tests for the specialized phase parsers.
 */

import { describe, it, expect } from 'vitest';
import {
  ExecutionPhaseParser,
  type ExecutionParserContext
} from '../agent/parsers';

describe('ExecutionPhaseParser', () => {
  const parser = new ExecutionPhaseParser();

  const makeContext = (
    currentPhase: ExecutionParserContext['currentPhase'],
    isSpecRunner = false
  ): ExecutionParserContext => ({
    currentPhase,
    isTerminal: currentPhase === 'complete' || currentPhase === 'failed',
    isSpecRunner
  });

  describe('structured event parsing', () => {
    it('should parse structured phase events', () => {
      const log = '__EXEC_PHASE__:{"phase":"coding","message":"Starting implementation"}';
      const result = parser.parse(log, makeContext('planning'));

      expect(result).toEqual({
        phase: 'coding',
        message: 'Starting implementation',
        currentSubtask: undefined
      });
    });

    it('should parse structured events with subtask', () => {
      const log = '__EXEC_PHASE__:{"phase":"coding","message":"Working","subtask":"auth-1"}';
      const result = parser.parse(log, makeContext('coding'));

      expect(result).toEqual({
        phase: 'coding',
        message: 'Working',
        currentSubtask: 'auth-1'
      });
    });
  });

  describe('terminal state handling', () => {
    it('should not change phase when current phase is complete', () => {
      const log = 'Starting coder agent...';
      const result = parser.parse(log, makeContext('complete'));

      expect(result).toBeNull();
    });

    it('should not change phase when current phase is failed', () => {
      const log = 'QA Reviewer starting...';
      const result = parser.parse(log, makeContext('failed'));

      expect(result).toBeNull();
    });

    it('should still parse structured events in terminal state', () => {
      // Structured events are authoritative and can transition away from terminal states
      const log = '__EXEC_PHASE__:{"phase":"coding","message":"Retry"}';
      const result = parser.parse(log, makeContext('complete'));

      // The parser returns the structured event; it's up to the caller to decide
      expect(result).toEqual({
        phase: 'coding',
        message: 'Retry',
        currentSubtask: undefined
      });
    });
  });

  describe('spec runner mode', () => {
    it('should detect discovery phase', () => {
      const log = 'Discovering project structure...';
      const result = parser.parse(log, makeContext('idle', true));

      expect(result).toEqual({
        phase: 'planning',
        message: 'Discovering project context...'
      });
    });

    it('should detect requirements phase', () => {
      const log = 'Gathering requirements from user...';
      const result = parser.parse(log, makeContext('planning', true));

      expect(result).toEqual({
        phase: 'planning',
        message: 'Gathering requirements...'
      });
    });

    it('should detect spec writing phase', () => {
      const log = 'Writing spec document...';
      const result = parser.parse(log, makeContext('planning', true));

      expect(result).toEqual({
        phase: 'planning',
        message: 'Writing specification...'
      });
    });
  });

  describe('agent log parsing', () => {
    it('should detect planner agent', () => {
      const log = 'Starting planner agent...';
      const result = parser.parse(log, makeContext('idle'));

      expect(result).toEqual({
        phase: 'planning',
        message: 'Creating implementation plan...'
      });
    });

    it('should detect coder agent', () => {
      const log = 'Starting coder agent for subtask 1';
      const result = parser.parse(log, makeContext('planning'));

      expect(result).toEqual({
        phase: 'coding',
        message: 'Implementing code changes...'
      });
    });

    it('should detect QA reviewer', () => {
      const log = 'Starting QA Reviewer...';
      const result = parser.parse(log, makeContext('coding'));

      expect(result).toEqual({
        phase: 'qa_review',
        message: 'Running QA review...'
      });
    });

    it('should detect QA fixer', () => {
      const log = 'Starting QA Fixer to address issues...';
      const result = parser.parse(log, makeContext('qa_review'));

      expect(result).toEqual({
        phase: 'qa_fixing',
        message: 'Fixing QA issues...'
      });
    });

    it('should detect build failure', () => {
      const log = 'Build failed: compilation error';
      const result = parser.parse(log, makeContext('coding'));

      expect(result?.phase).toBe('failed');
      expect(result?.message).toContain('Build failed');
    });
  });

  describe('regression prevention', () => {
    it('should not regress from qa_review to coding', () => {
      const log = 'Starting coder agent...';
      const result = parser.parse(log, makeContext('qa_review'));

      expect(result).toBeNull();
    });

    it('should allow qa_fixing to qa_review transition (re-review after fix)', () => {
      const log = 'Starting QA Reviewer...';
      const result = parser.parse(log, makeContext('qa_fixing'));

      // QA reviewer in qa_fixing is normal - it's checking the fix
      expect(result?.phase).toBe('qa_review');
    });
  });

  describe('subtask detection', () => {
    it('should detect subtask progress in coding phase', () => {
      const log = 'Working on subtask: 2/5';
      const result = parser.parse(log, makeContext('coding'));

      expect(result).toEqual({
        phase: 'coding',
        currentSubtask: '2/5',
        message: 'Working on subtask 2/5...'
      });
    });

    it('should not detect subtask in non-coding phase', () => {
      const log = 'Subtask: 1/3';
      const result = parser.parse(log, makeContext('planning'));

      expect(result).toBeNull();
    });
  });

  describe('internal event filtering', () => {
    it('should ignore task logger events', () => {
      const log = '__TASK_LOG__:{"event":"progress","data":{}}';
      const result = parser.parse(log, makeContext('coding'));

      expect(result).toBeNull();
    });
  });
});
