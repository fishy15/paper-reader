import { describe, expect, it, vi } from "vitest";
import type { QaStreamEvent } from "@paper-reader/shared";
import { readQaEvents } from "./qaStream.js";

const encoder = new TextEncoder();
const line = (event: QaStreamEvent) => `${JSON.stringify(event)}\n`;

function bodyOf(chunks: (string | Uint8Array<ArrayBuffer>)[], cancel: () => void = () => {}) {
  let next = 0;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      const chunk = chunks[next++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    },
    cancel,
  });
}

async function collect(body: ReadableStream<Uint8Array>) {
  const events: QaStreamEvent[] = [];
  for await (const event of readQaEvents(body)) events.push(event);
  return events;
}

const delta = (text: string): QaStreamEvent => ({ type: "delta", text });

describe("readQaEvents", () => {
  it("yields events that share a chunk or are split across chunks", async () => {
    const text = line(delta("Hello ")) + line(delta("world")) + line({ type: "done" });
    const chunks = [text.slice(0, 10), text.slice(10, 11), text.slice(11)];
    expect(await collect(bodyOf(chunks))).toEqual([delta("Hello "), delta("world"), { type: "done" }]);
    expect(await collect(bodyOf([text]))).toHaveLength(3);
  });

  it("keeps a multi-byte character that is split between chunks", async () => {
    const bytes = encoder.encode(line(delta("café")) + line({ type: "done" }));
    const split = bytes.indexOf(0xc3) + 1; // between the two bytes of "é"
    const events = await collect(bodyOf([bytes.slice(0, split), bytes.slice(split)]));
    expect(events[0]).toEqual(delta("café"));
  });

  it("accepts a final event without a trailing newline", async () => {
    expect(await collect(bodyOf([line(delta("a")), JSON.stringify({ type: "done" })]))).toEqual([
      delta("a"),
      { type: "done" },
    ]);
  });

  it("yields an error event and then ends normally", async () => {
    const events = await collect(bodyOf([line(delta("Partial")), line({ type: "error", message: "boom" })]));
    expect(events).toEqual([delta("Partial"), { type: "error", message: "boom" }]);
  });

  it("rejects unreadable lines and unknown event types", async () => {
    for (const bad of ["not json\n", `${JSON.stringify({ type: "mystery" })}\n`, `${JSON.stringify({ type: "delta" })}\n`]) {
      await expect(collect(bodyOf([bad]))).rejects.toThrow(/unreadable response/);
    }
  });

  it("fails if the stream ends without a done or error event", async () => {
    await expect(collect(bodyOf([line(delta("a"))]))).rejects.toThrow(/cut off/);
    await expect(collect(bodyOf([]))).rejects.toThrow(/cut off/);
  });

  it("cancels the underlying stream when the consumer stops early", async () => {
    const cancel = vi.fn();
    const events = readQaEvents(bodyOf([line(delta("a")), line(delta("b")), line({ type: "done" })], cancel));
    await events.next();
    await events.return(undefined);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
