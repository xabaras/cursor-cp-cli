/**
 * Tests for CLI print runner stream-json parsing
 */

import { describe, it, expect } from 'vitest';
import { parseStreamJsonLine } from './cli-print-runner.js';

describe('parseStreamJsonLine', () => {
  it('extracts assistant text deltas', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    });
    expect(parseStreamJsonLine(line)).toEqual({ delta: 'hello' });
  });

  it('extracts result text', () => {
    const line = JSON.stringify({ type: 'result', result: 'final answer' });
    expect(parseStreamJsonLine(line)).toEqual({ result: 'final answer' });
  });

  it('ignores non-json and unknown types', () => {
    expect(parseStreamJsonLine('not json')).toBeNull();
    expect(parseStreamJsonLine(JSON.stringify({ type: 'system' }))).toBeNull();
  });
});
