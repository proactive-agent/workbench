import { describe, it, expect } from 'vitest';
import { INSIGHTS_GITHUB_COMMANDS, INSIGHTS_GITLAB_COMMANDS, buildConversationPrompt, buildSystemPrompt, extractToolInput } from '../prompts';

describe('buildConversationPrompt', () => {
  it('uses the message directly without history', () => {
    expect(buildConversationPrompt('hi')).toBe('hi');
  });

  it('folds history into the prompt', () => {
    const prompt = buildConversationPrompt('next?', [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ]);
    expect(prompt).toBe('Previous conversation:\nUser: q1\n\nAssistant: a1\n\nCurrent question: next?');
  });
});

describe('extractToolInput', () => {
  it('describes common tool arguments', () => {
    expect(extractToolInput({ command: 'graphify query auth' })).toBe('graphify query auth');
    expect(extractToolInput({ pattern: '*.ts' })).toBe('pattern: *.ts');
    expect(extractToolInput({ file_path: 'src/a.ts' })).toBe('src/a.ts');
    expect(extractToolInput({})).toBe('');
  });

  it('keeps whole commands and paths, cutting only very long or multi-line ones', () => {
    const command = 'gh issue view 14 --repo proactive-agent/workbench --json title,body,labels,comments';
    expect(extractToolInput({ command })).toBe(command);
    expect(extractToolInput({ file_path: '/home/me/projects/app/src/renderer/components/Insights.tsx' }))
      .toBe('/home/me/projects/app/src/renderer/components/Insights.tsx');
    expect(extractToolInput({ command: 'gh pr create --body-file - <<EOF\nbody\nEOF' })).toBe('gh pr create --body-file - <<EOF…');
    expect(extractToolInput({ command: 'x'.repeat(600) })).toBe(`${'x'.repeat(500)}…`);
  });
});

describe('buildSystemPrompt', () => {
  it('describes the task tools only when the Kanban button is on', () => {
    const withTools = buildSystemPrompt({ taskTools: true });
    expect(withTools).toContain('mcp__workbench__');
    expect(withTools).toContain("don't create it. Suggest it instead");

    const withoutTools = buildSystemPrompt();
    expect(withoutTools).not.toContain('mcp__workbench__');
    expect(withoutTools).toContain('Kanban button');
    expect(withoutTools).toContain('When the user asks you to create a task');
    // Where the existing tasks are, instead of a list of folder names
    expect(withoutTools).toContain('.workbench/tasks/<id>/');
  });

  it('asks for suggestion lines at the end, escaped, and says they become cards', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('__TASK_SUGGESTION__:{"title"');
    expect(prompt).toContain('at the very end of your reply');
    expect(prompt).toContain('write line breaks in the description as \\n');
    expect(prompt).toMatch(/hides the line itself/);
  });

  it('lists exactly the tools the turn has', () => {
    const plain = buildSystemPrompt();
    expect(plain).toContain('- No shell commands.');
    expect(plain).toContain('- WebSearch and WebFetch for the web');
    expect(plain).not.toContain('MCP servers the user turned on');
    expect(plain).toContain("You can't change them: code changes are made by tasks.");

    const full = buildSystemPrompt({ graphify: true, cliTools: { github: true }, mcpServers: ['context7', 'Ant_Design'], memory: true });
    expect(full).toContain('- Bash, only for the graphify searches described below and the `gh` commands listed below.');
    expect(full).toContain('MCP servers the user turned on for this chat: context7, Ant_Design');
    expect(full).toContain('(except your project memory, below)');
    expect(full).toContain('## Project memory');
  });

  it('lists exactly the read-only gh and glab commands allowed, and says the rest is denied', () => {
    const prompt = buildSystemPrompt({ cliTools: { github: true, gitlab: true } });
    for (const command of [...INSIGHTS_GITHUB_COMMANDS, ...INSIGHTS_GITLAB_COMMANDS]) expect(prompt).toContain(`\`${command}\``);
    expect(prompt).toContain('## GitHub and GitLab');
    expect(prompt).toContain('Everything else is denied');
    expect(prompt).toContain('do it themselves or do it through a task');
    expect(prompt).not.toContain('`gh pr checkout`');

    const githubOnly = buildSystemPrompt({ cliTools: { github: true } });
    expect(githubOnly).toContain('`gh pr view`');
    expect(githubOnly).not.toContain('glab');
    expect(buildSystemPrompt()).not.toContain('## GitHub');
  });

    it('has no project memory section while self-improve is off', () => {
    expect(buildSystemPrompt()).not.toContain('## Project memory');
  });
});

describe('buildSystemPrompt with the Clawd button', () => {
  it('says Claude can change files in the project folder, without the read-only rules', () => {
    const prompt = buildSystemPrompt({ agentMode: true, cliTools: { github: true } });
    expect(prompt).toContain("Claude Code's full tool set");
    expect(prompt).toContain("not in a task's worktree");
    expect(prompt).not.toContain("You can't change them");
    expect(prompt).not.toContain('Only these commands are allowed');
  });
});
