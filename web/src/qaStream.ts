import { QaStreamEvent } from "@paper-reader/shared";

function parseEvent(line: string): QaStreamEvent {
  try {
    return QaStreamEvent.parse(JSON.parse(line));
  } catch {
    throw new Error("Received an unreadable response from the server");
  }
}

/**
 * Reads a newline-delimited JSON body and yields each line as a validated event. The stream must
 * end with a `done` or `error` event; if it stops earlier the connection was cut, which is an error.
 */
export async function* readQaEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<QaStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  function* parse(lines: string[]) {
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = parseEvent(line);
      if (event.type !== "delta") finished = true;
      yield event;
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // `stream: true` keeps a multi-byte character that is split across chunks intact.
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      yield* parse(lines);
    }
    yield* parse([buffer + decoder.decode()]);
    if (!finished) throw new Error("The answer was cut off before it finished");
  } finally {
    // Also runs when the consumer stops early, which closes the connection to the server.
    await reader.cancel().catch(() => {});
  }
}
