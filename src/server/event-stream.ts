/** One event read from a `text/event-stream` body. */
export interface StreamEvent {
  event: string;
  /** The data lines, joined with a newline. The server sends JSON on one line. */
  data: string;
}

/**
 * Reads the events of a server-sent event stream until it ends.
 * Comment lines (the server's keep-alive lines) are skipped. Only `\n` line ends are handled,
 * which is what the local server sends.
 */
export async function* readEventStream(body: AsyncIterable<Uint8Array>): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end = buffer.indexOf('\n\n');
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const parsed = parseBlock(block);
      if (parsed) yield parsed;
      end = buffer.indexOf('\n\n');
    }
  }
}

function parseBlock(block: string): StreamEvent | undefined {
  let event = 'message';
  const data: string[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length > 0 ? { event, data: data.join('\n') } : undefined;
}
