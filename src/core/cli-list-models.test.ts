/**
 * Tests for CLI model list parsing
 */

import { describe, it, expect } from 'vitest';
import { mapSdkModelIdForCli, parseCliModelsOutput } from './cli-list-models.js';

describe('parseCliModelsOutput', () => {
  it('parses agent --list-models lines including auto', () => {
    const text = `Available models

auto - Auto (current, default)
composer-2.5 - Composer 2.5
gpt-5.2 - GPT-5.2
`;
    expect(parseCliModelsOutput(text)).toEqual([
      { id: 'auto', name: 'Auto' },
      { id: 'composer-2.5', name: 'Composer 2.5' },
      { id: 'gpt-5.2', name: 'GPT-5.2' },
    ]);
  });

  it('dedupes by id', () => {
    const text = `auto - Auto
auto - Auto again
`;
    expect(parseCliModelsOutput(text)).toEqual([{ id: 'auto', name: 'Auto' }]);
  });
});

describe('mapSdkModelIdForCli', () => {
  it('maps SDK default to CLI auto', () => {
    expect(mapSdkModelIdForCli('default')).toBe('auto');
    expect(mapSdkModelIdForCli('composer-2.5')).toBe('composer-2.5');
  });
});
