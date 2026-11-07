/**
 * The composer's `/` menu: it opens on a `/` that starts the input or a word, filters by what
 * follows, and a picked command replaces the token.
 */
import { describe, it, expect } from 'vitest';
import { filterSlashCommands, insertSlashCommand, slashTokenAt, splitSlashCommands } from '../insights-slash-commands';

describe('slashTokenAt', () => {
  it('finds a slash at the start or after a space, up to the caret', () => {
    expect(slashTokenAt('/', 1)).toEqual({ start: 0, query: '' });
    expect(slashTokenAt('/gra', 4)).toEqual({ start: 0, query: 'gra' });
    expect(slashTokenAt('run /gra now', 8)).toEqual({ start: 4, query: 'gra' });
  });

  it('is no token inside a word, a path or after a space', () => {
    expect(slashTokenAt('and/or', 6)).toBeNull();
    expect(slashTokenAt('src/main', 8)).toBeNull();
    expect(slashTokenAt('/usr/bin', 8)).toBeNull();
    expect(slashTokenAt('/graphify ', 10)).toBeNull();
  });
});

describe('filterSlashCommands', () => {
  const commands = [{ name: 'review', description: '' }, { name: 'graphify', description: '' }, { name: 'pr-review', description: '' }];

  it('lists names starting with the query first, then names containing it', () => {
    expect(filterSlashCommands(commands, 'rev').map((c) => c.name)).toEqual(['review', 'pr-review']);
    expect(filterSlashCommands(commands, '').map((c) => c.name)).toEqual(['graphify', 'pr-review', 'review']);
    expect(filterSlashCommands(commands, 'xyz')).toEqual([]);
  });
});

describe('insertSlashCommand', () => {
  it('replaces the token with the command and a space, the caret after it', () => {
    expect(insertSlashCommand('/gra', { start: 0, query: 'gra' }, 4, 'graphify')).toEqual({ value: '/graphify ', caret: 10 });
  });

  it('keeps a command picked further in where it was typed', () => {
    expect(insertSlashCommand('please use /code-re skill', { start: 11, query: 'code-re' }, 19, 'code-review')).toEqual({ value: 'please use /code-review skill', caret: 24 });
  });
});

describe('splitSlashCommands', () => {
  const names = new Set(['code-review', 'compact']);

  it('marks only listed commands that start the input or a word', () => {
    expect(splitSlashCommands('please use /code-review skill', names)).toEqual([
      { text: 'please use ', command: false },
      { text: '/code-review', command: true },
      { text: ' skill', command: false },
    ]);
    expect(splitSlashCommands('/compact', names)).toEqual([{ text: '/compact', command: true }]);
  });

  it('leaves unlisted names, paths and partial names plain', () => {
    expect(splitSlashCommands('see /usr/bin and /unknown or /code-rev', names)).toEqual([
      { text: 'see /usr/bin and /unknown or /code-rev', command: false },
    ]);
    expect(splitSlashCommands('a/compact', names)).toEqual([{ text: 'a/compact', command: false }]);
  });
});
