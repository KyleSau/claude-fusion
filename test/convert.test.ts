import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { messageEvents } from '../src/core/events';
import { footerLine } from '../src/core/transcript';
import type { ApiMessage, ContentBlock } from '../src/core/types';
import { fromVsCode, toolsFromVsCode, VsCodeSink } from '../src/extension/convert';
// Image and data parts arrived after the VS Code version Fusion is typed against, so the test
// builds them from the stub directly.
import { LanguageModelDataPart } from './support/vscode';

const msg = (role: number, content: unknown[]) => ({ role, content, name: undefined }) as unknown as vscode.LanguageModelChatRequestMessage;

describe('VS Code messages to the Messages API', () => {
  it('converts system, user, assistant and tool messages', () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const { system, messages } = fromVsCode([
      msg(3, [new vscode.LanguageModelTextPart('You are an agent.')]),
      msg(1, [new vscode.LanguageModelTextPart('Fix this'), LanguageModelDataPart.image(png, 'image/png'), LanguageModelDataPart.json({ type: 'ephemeral' }, 'cache_control')]),
      msg(2, [new vscode.LanguageModelTextPart(`Looking.${footerLine('cascade')}`), new vscode.LanguageModelToolCallPart('call_1', 'mcp.github/search', { q: 'x' })]),
      msg(1, [new vscode.LanguageModelTextPart('<reminder>'), new vscode.LanguageModelToolResultPart('call_1', [new vscode.LanguageModelTextPart('3 results')])]),
      msg(3, [new vscode.LanguageModelTextPart('Be brief.')]),
    ]);
    expect(system).toEqual([{ type: 'text', text: 'You are an agent.' }]);
    expect(messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Fix this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(png).toString('base64') } },
      ],
    });
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 'call_1', name: 'mcp_github_search', input: { q: 'x' } },
      ],
    });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: '3 results' }] },
        { type: 'text', text: '<reminder>' },
      ],
    });
    expect(messages[3]).toEqual({ role: 'system', content: 'Be brief.' });
  });

  it('sanitises tool names and keeps a map back to the originals', () => {
    const { tools, names } = toolsFromVsCode([{ name: 'mcp.github/search', description: 'Search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }]);
    expect(tools).toEqual([{ name: 'mcp_github_search', description: 'Search', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }]);
    expect(names.get('mcp_github_search')).toBe('mcp.github/search');
  });
});

describe('streaming back into VS Code', () => {
  function run(content: ContentBlock[], stop_reason: ApiMessage['stop_reason'] = 'tool_use') {
    const reported: unknown[] = [];
    const sink = new VsCodeSink({ report: (p) => reported.push(p) }, new Map([['mcp_github_search', 'mcp.github/search']]), true);
    const message = { id: 'm', type: 'message', role: 'assistant', model: 'x', content, stop_reason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as ApiMessage;
    return { reported, play: () => messageEvents(message).forEach((e) => sink.event(e)) };
  }

  it('reports tool calls only once the message has completed, with their original names', () => {
    const { reported, play } = run([
      { type: 'text', text: 'Checking.', citations: null },
      { type: 'thinking', thinking: 'Searching for the handler first.', signature: 's' },
      { type: 'tool_use', id: 'call_9', name: 'mcp_github_search', input: { q: 'handler' } },
    ] as ContentBlock[]);
    play();
    expect(reported.map((p) => (p as object).constructor.name)).toEqual(['LanguageModelTextPart', 'LanguageModelTextPart', 'LanguageModelToolCallPart']);
    expect((reported[1] as vscode.LanguageModelTextPart).value).toContain('_Searching for the handler first._');
    expect(reported[2]).toMatchObject({ callId: 'call_9', name: 'mcp.github/search', input: { q: 'handler' } });
  });

  it('never shows progress notes on a final answer', () => {
    const { reported, play } = run(
      [
        { type: 'thinking', thinking: 'Wrapping up.', signature: 's' },
        { type: 'text', text: 'All done.', citations: null },
      ] as ContentBlock[],
      'end_turn',
    );
    play();
    expect(reported.map((p) => (p as vscode.LanguageModelTextPart).value)).toEqual(['All done.']);
  });

  it('refuses to hand VS Code a tool call cut off by the output limit', () => {
    const { reported, play } = run([{ type: 'tool_use', id: 'c', name: 'edit', input: {} }] as ContentBlock[], 'max_tokens');
    expect(play).toThrow(/output token limit/);
    expect(reported).toHaveLength(0);
  });
});
