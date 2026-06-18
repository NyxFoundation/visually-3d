// Minimal Server-Sent-Events helpers for the fetch streaming the CLI bridge
// uses (EventSource only supports GET, so we read the body manually).

export function parseSseChunk(buffer: string, onEvent: (event: string, data: string) => void): string {
  const events = buffer.split('\n\n');
  const remainder = events.pop() ?? '';
  for (const rawEvent of events) {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0) onEvent(eventName, dataLines.join('\n'));
  }
  return remainder;
}

// POST `body` as JSON and stream the SSE response, dispatching each event.
// Resolves when the stream ends.
export async function streamPostSse(
  url: string,
  body: unknown,
  onEvent: (event: string, data: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = parseSseChunk(buffer, onEvent);
  }
}
