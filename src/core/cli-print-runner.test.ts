/**
 * Tests for CLI print runner stream-json parsing
 */

import { describe, it, expect } from 'vitest';
import { parseStreamJsonLine, preferLongerCliText } from './cli-print-runner.js';

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

describe('preferLongerCliText', () => {
  it('prefers longer assistant over short result', () => {
    expect(preferLongerCliText('short', 'much longer assistant analysis')).toBe(
      'much longer assistant analysis'
    );
  });

  it('prefers longer result over short assistant', () => {
    expect(preferLongerCliText('full final answer here', 'hi')).toBe('full final answer here');
  });

  it('falls back when one side is empty', () => {
    expect(preferLongerCliText('', 'only assistant')).toBe('only assistant');
    expect(preferLongerCliText('only result', '')).toBe('only result');
  });
});
