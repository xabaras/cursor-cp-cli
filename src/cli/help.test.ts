/**
 * Tests for CLI help routing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isHelpFlag,
  parseHelpTopic,
  printHelpForTopic,
  printMainHelp,
  printSetupHelp,
  printDaemonHelp,
} from './help.js';

describe('isHelpFlag', () => {
  it('recognizes help flags', () => {
    expect(isHelpFlag('--help')).toBe(true);
    expect(isHelpFlag('-h')).toBe(true);
    expect(isHelpFlag('help')).toBe(false);
  });
});

describe('parseHelpTopic', () => {
  it('returns null when not a help request', () => {
    expect(parseHelpTopic([])).toBeNull();
    expect(parseHelpTopic(['setup'])).toBeNull();
    expect(parseHelpTopic(['daemon', 'enable'])).toBeNull();
  });

  it('parses main help requests', () => {
    expect(parseHelpTopic(['help'])).toBeUndefined();
    expect(parseHelpTopic(['--help'])).toBeUndefined();
    expect(parseHelpTopic(['-h'])).toBeUndefined();
  });

  it('parses command-specific help', () => {
    expect(parseHelpTopic(['help', 'setup'])).toBe('setup');
    expect(parseHelpTopic(['setup', '--help'])).toBe('setup');
    expect(parseHelpTopic(['daemon', '-h'])).toBe('daemon');
  });
});

describe('printHelpForTopic', () => {
  let logs: string[];
  let errors: string[];
  let exitCode: number | undefined;

  beforeEach(() => {
    logs = [];
    errors = [];
    exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(msg);
    });
    vi.spyOn(console, 'error').mockImplementation((msg: string) => {
      errors.push(msg);
    });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      exitCode = code as number;
      throw new Error('process.exit');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints main help', () => {
    printMainHelp();
    expect(logs.join('\n')).toContain('Cursor Control Plane + CLI');
    expect(logs.join('\n')).toContain('daemon');
  });

  it('prints setup help with all flags', () => {
    printSetupHelp();
    const text = logs.join('\n');
    expect(text).toContain('--enable-daemon');
    expect(text).toContain('--no-daemon');
    expect(text).toContain('--non-interactive');
  });

  it('prints daemon subcommands', () => {
    printDaemonHelp();
    const text = logs.join('\n');
    expect(text).toContain('enable');
    expect(text).toContain('restart');
    expect(text).toContain('status');
  });

  it('exits on unknown topic', () => {
    expect(() => printHelpForTopic('unknown-cmd')).toThrow('process.exit');
    expect(exitCode).toBe(1);
    expect(errors.join('\n')).toContain('Unknown help topic');
  });
});
