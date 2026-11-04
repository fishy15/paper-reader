import { describe, expect, it, vi } from "vitest";
import type { QaStreamEvent } from "@paper-reader/shared";
import { ApiError } from "./api.js";
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

/** A stream that yields one chunk, then fails with `reason`. */
function failingBody(first: string, reason: unknown) {
  let sent = false;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (sent) controller.error(reason);
      else {
        sent = true;
        controller.enqueue(encoder.encode(first));
      }
    },
  });
}

describe("readQaEvents", () => {
  it("yields events that share one chunk", async () => {
    const text = line(delta("Hello ")) + line(delta("world")) + line({ type: "done" });
    expect(await collect(bodyOf([text]))).toEqual([delta("Hello "), delta("world"), { type: "done" }]);
  });

  it("yields events that are split across chunks", async () => {
    const text = line(delta("Hello ")) + line(delta("world")) + line({ type: "done" });
    const chunks = [text.slice(0, 10), text.slice(10, 11), text.slice(11)];
    expect(await collect(bodyOf(chunks))).toEqual([delta("Hello "), delta("world"), { type: "done" }]);
  });

  it("keeps a multi-byte character that is split between chunks", async () => {
    const bytes = encoder.encode(line(delta("café")) + line({ type: "done" }));
    const split = bytes.indexOf(0xc3) + 1; // between the two bytes of "é"
    const events = await collect(bodyOf([bytes.slice(0, split), bytes.slice(split)]));
    expect(events).toEqual([delta("café"), { type: "done" }]);
  });

  it("yields the same events however the bytes are chunked", async () => {
    const expected: QaStreamEvent[] = [delta("é 😀"), delta("x"), { type: "done" }];
    const bytes = encoder.encode(line(expected[0]!) + line(expected[1]!) + line({ type: "done" }));
    for (let at = 1; at < bytes.length; at++) {
      expect(await collect(bodyOf([bytes.slice(0, at), bytes.slice(at)])), `split at byte ${at}`).toEqual(expected);
    }
    const singles = Array.from(bytes, (byte) => new Uint8Array([byte]));
    expect(await collect(bodyOf(singles))).toEqual(expected);
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

  it.each([
    ["a line that is not JSON", "not json\n"],
    ["an unknown event type", `${JSON.stringify({ type: "mystery" })}\n`],
    ["a delta without text", `${JSON.stringify({ type: "delta" })}\n`],
  ])("rejects %s as unreadable", async (_name, bad) => {
    await expect(collect(bodyOf([bad]))).rejects.toThrow(/unreadable response/);
  });

  it("rejects a bad trailing line as unreadable, not as cut off", async () => {
    await expect(collect(bodyOf([line(delta("a")) + '{"type":"do']))).rejects.toThrow(/unreadable response/);
  });

  it.each([
    ["one delta", [line(delta("a"))]],
    ["no data", []],
  ])("fails if the stream ends without a done or error event (%s)", async (_name, chunks) => {
    await expect(collect(bodyOf(chunks))).rejects.toThrow(/cut off/);
  });

  it.each([
    ["leading blank lines", `\n\n${line(delta("a"))}${line({ type: "done" })}`],
    ["trailing whitespace", `${line(delta("a"))}${line({ type: "done" })}  `],
    ["CRLF line endings", `${JSON.stringify(delta("a"))}\r\n${JSON.stringify({ type: "done" })}\r\n`],
  ])("skips blank lines and whitespace (%s)", async (_name, text) => {
    expect(await collect(bodyOf([text]))).toEqual([delta("a"), { type: "done" }]);
  });

  it.each<[string, QaStreamEvent]>([
    ["done", { type: "done" }],
    ["error", { type: "error", message: "boom" }],
  ])("accepts a stream with only a %s event", async (_name, event) => {
    expect(await collect(bodyOf([line(event)]))).toEqual([event]);
  });

  it("wraps a connection lost mid-answer in an ApiError", async () => {
    const err = await collect(failingBody(line(delta("a")), new TypeError("terminated"))).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe("The connection was lost before the answer finished");
  });

  it("lets an abort through as an AbortError", async () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    await expect(collect(failingBody(line(delta("a")), abort))).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels the underlying stream after an unreadable line", async () => {
    const cancel = vi.fn();
    // Left open (never closed), so the reader still has a live connection to cancel.
    const open = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("not json\n"));
      },
      cancel,
    });
    await expect(collect(open)).rejects.toThrow(/unreadable response/);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels the underlying stream when the consumer stops early", async () => {
    const cancel = vi.fn();
    const events = readQaEvents(bodyOf([line(delta("a")), line(delta("b")), line({ type: "done" })], cancel));
    await events.next();
    await events.return(undefined);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("ignores a cancel that throws", async () => {
    const events = readQaEvents(
      bodyOf([line(delta("a")), line(delta("b"))], () => {
        throw new Error("cancel failed");
      }),
    );
    await events.next();
    await expect(events.return(undefined)).resolves.toEqual({ done: true, value: undefined });
  });
});
