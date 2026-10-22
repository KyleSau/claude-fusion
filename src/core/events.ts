import type { ApiMessage, StreamEvent, TurnSink } from './types';

/**
 * Synthesizes the stream events for a complete message, for transports that need events but the
 * message was produced without them (e.g. by a non-streaming backend).
 */
export function messageEvents(message: ApiMessage): StreamEvent[] {
  const events: StreamEvent[] = [];
  events.push({
    type: 'message_start',
    message: { ...message, content: [], stop_reason: null, stop_sequence: null },
  } as StreamEvent);
  message.content.forEach((block, index) => {
    switch (block.type) {
      case 'text': {
        events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } } as StreamEvent);
        for (const citation of block.citations ?? []) {
          events.push({ type: 'content_block_delta', index, delta: { type: 'citations_delta', citation } } as StreamEvent);
        }
        if (block.text) events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } } as StreamEvent);
        break;
      }
      case 'thinking': {
        events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } } as StreamEvent);
        if (block.thinking) {
          events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } } as StreamEvent);
        }
        events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } } as StreamEvent);
        break;
      }
      case 'tool_use': {
        events.push({ type: 'content_block_start', index, content_block: { ...block, input: {} } } as StreamEvent);
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
        } as StreamEvent);
        break;
      }
      default:
        events.push({ type: 'content_block_start', index, content_block: block } as StreamEvent);
    }
    events.push({ type: 'content_block_stop', index } as StreamEvent);
  });
  const u = message.usage;
  events.push({
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence ?? null, container: message.container ?? null },
    usage: {
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? null,
      cache_read_input_tokens: u.cache_read_input_tokens ?? null,
      server_tool_use: u.server_tool_use ?? null,
    },
  } as StreamEvent);
  events.push({ type: 'message_stop' } as StreamEvent);
  return events;
}

export function replay(events: readonly StreamEvent[], sink: TurnSink): void {
  for (const e of events) sink.event(e);
}

/** True once a step has started a client tool call, i.e. it is not a final answer. */
export function startsToolUse(e: StreamEvent): boolean {
  return e.type === 'content_block_start' && e.content_block.type === 'tool_use';
}
