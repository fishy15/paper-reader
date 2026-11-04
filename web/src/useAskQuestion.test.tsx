import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { QaStreamEvent } from "@paper-reader/shared";
import { askQuestion } from "./api.js";
import { messagesKey } from "./queries.js";
import { ndjson } from "./test/fixtures.js";
import { server } from "./test/server.js";
import { useAskQuestion } from "./useAskQuestion.js";

// Wraps the real client so one test can make it reject with something that isn't an Error.
vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return { ...actual, askQuestion: vi.fn(actual.askQuestion) };
});

function setup(paperId = 1) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, ...renderHook(() => useAskQuestion(paperId), { wrapper }) };
}

const respondWith = (events: QaStreamEvent[]) =>
  server.use(http.post("*/api/papers/1/ask", () => new HttpResponse(ndjson(events))));

const hang = () =>
  server.use(
    http.post("*/api/papers/1/ask", async () => {
      await delay("infinite");
      return new HttpResponse(null);
    }),
  );

/** A response whose events are released one at a time; it stays open until `close()`. */
function gatedResponse() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    respond: () => new HttpResponse(stream),
    push: (event: QaStreamEvent) => controller.enqueue(encoder.encode(ndjson([event]))),
    close: () => controller.close(),
  };
}

describe("useAskQuestion", () => {
  it("starts idle", () => {
    const { result } = setup();
    expect(result.current).toMatchObject({ turn: null, error: null, stopped: false, streaming: false });
  });

  it("resolves true, invalidates the messages and clears the turn when the answer completes", async () => {
    respondWith([{ type: "delta", text: "A" }, { type: "delta", text: "B" }, { type: "done" }]);
    const { result, queryClient } = setup(1);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.ask("Q?");
    });

    expect(ok).toBe(true);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: messagesKey(1) });
    expect(result.current).toMatchObject({ turn: null, error: null, stopped: false, streaming: false });
  });

  it("shows the question with an empty answer while the request is pending", async () => {
    hang();
    const { result } = setup();
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.ask("Q?");
    });
    await waitFor(() => expect(result.current.streaming).toBe(true));
    expect(result.current.turn).toEqual({ question: "Q?", answer: "" });
    act(() => result.current.stop());
    expect(await pending).toBe(false);
  });

  it("resolves false and reports an error event", async () => {
    respondWith([{ type: "error", message: "Overloaded" }]);
    const { result } = setup();
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.ask("Q?");
    });
    expect(ok).toBe(false);
    expect(result.current.error).toBe("Overloaded");
    expect(result.current.turn).toBeNull();
    expect(result.current.streaming).toBe(false);
  });

  it("resolves false and reports a rejected request", async () => {
    server.use(http.post("*/api/papers/1/ask", () => HttpResponse.json({ error: "No PDF" }, { status: 422 })));
    const { result } = setup();
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.ask("Q?");
    });
    expect(ok).toBe(false);
    expect(result.current.error).toBe("No PDF");
    expect(result.current.stopped).toBe(false);
  });

  it("stop() ends the answer as stopped, not as an error", async () => {
    hang();
    const { result } = setup();
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.ask("Q?");
    });
    await waitFor(() => expect(result.current.streaming).toBe(true));
    act(() => result.current.stop());
    expect(await pending).toBe(false);
    await waitFor(() => expect(result.current.stopped).toBe(true));
    expect(result.current.error).toBeNull();
    expect(result.current.turn).toBeNull();
    expect(result.current.streaming).toBe(false);
  });

  it("clears the previous error and stopped flags on the next question", async () => {
    respondWith([{ type: "error", message: "First failed" }]);
    const { result } = setup();
    await act(async () => void (await result.current.ask("Q1")));
    expect(result.current.error).toBe("First failed");

    respondWith([{ type: "done" }]);
    await act(async () => void (await result.current.ask("Q2")));
    expect(result.current.error).toBeNull();

    hang();
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.ask("Q3");
    });
    await waitFor(() => expect(result.current.streaming).toBe(true));
    act(() => result.current.stop());
    expect(await pending).toBe(false);
    await waitFor(() => expect(result.current.stopped).toBe(true));

    respondWith([{ type: "done" }]);
    await act(async () => void (await result.current.ask("Q4")));
    expect(result.current.stopped).toBe(false);
  });

  it("aborts a streaming answer when unmounted", async () => {
    let aborted = false;
    server.use(
      http.post("*/api/papers/1/ask", async ({ request }) => {
        request.signal.addEventListener("abort", () => (aborted = true));
        await delay("infinite");
        return new HttpResponse(null);
      }),
    );
    const { result, unmount } = setup();
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.ask("Q?");
    });
    await waitFor(() => expect(result.current.streaming).toBe(true));
    unmount();
    await waitFor(() => expect(aborted).toBe(true));
    expect(await pending).toBe(false);
  });

  it("stop() with nothing in flight does nothing", () => {
    const { result } = setup();
    expect(() => act(() => result.current.stop())).not.toThrow();
    expect(result.current.stopped).toBe(false);
  });

  it("accumulates deltas into the turn's answer", async () => {
    const gate = gatedResponse();
    server.use(http.post("*/api/papers/1/ask", gate.respond));
    const { result } = setup();
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.ask("Q?");
    });

    gate.push({ type: "delta", text: "A" });
    await waitFor(() => expect(result.current.turn).toEqual({ question: "Q?", answer: "A" }));
    gate.push({ type: "delta", text: "B" });
    await waitFor(() => expect(result.current.turn).toEqual({ question: "Q?", answer: "AB" }));
    expect(result.current.streaming).toBe(true);

    gate.push({ type: "done" });
    gate.close();
    expect(await pending).toBe(true);
  });

  it("keeps the turn until the messages have been invalidated", async () => {
    respondWith([{ type: "delta", text: "A" }, { type: "done" }]);
    const { result, queryClient } = setup();
    let finishInvalidating!: () => void;
    const invalidate = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockReturnValue(new Promise<void>((resolve) => (finishInvalidating = resolve)));

    let resolved = false;
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.ask("Q?").then((ok) => ((resolved = true), ok));
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    expect(result.current.turn).toEqual({ question: "Q?", answer: "A" });
    expect(result.current.streaming).toBe(true);
    expect(resolved).toBe(false);

    await act(async () => finishInvalidating());
    expect(await pending).toBe(true);
    expect(result.current.turn).toBeNull();
    expect(result.current.streaming).toBe(false);
  });

  it.each([
    ["an error event after a delta", ndjson([{ type: "delta", text: "A" }, { type: "error", message: "Overloaded" }]), "Overloaded"],
    ["a stream cut off after a delta", ndjson([{ type: "delta", text: "A" }]), /cut off/],
    ["an unreadable line", "not json\n", /unreadable response/],
  ])("does not invalidate the messages after %s", async (_name, body, message) => {
    server.use(http.post("*/api/papers/1/ask", () => new HttpResponse(body)));
    const { result, queryClient } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.ask("Q?");
    });
    expect(ok).toBe(false);
    expect(result.current.error).toMatch(message);
    expect(result.current.turn).toBeNull();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("stop() after the first chunk ends the answer as stopped without saving", async () => {
    const gate = gatedResponse();
    server.use(http.post("*/api/papers/1/ask", gate.respond));
    const { result, queryClient } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.ask("Q?");
    });
    gate.push({ type: "delta", text: "A" });
    await waitFor(() => expect(result.current.turn?.answer).toBe("A"));

    act(() => result.current.stop());
    expect(await pending).toBe(false);
    await waitFor(() => expect(result.current.stopped).toBe(true));
    expect(result.current.error).toBeNull();
    expect(result.current.turn).toBeNull();
    expect(result.current.streaming).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("reports a rejection that is not an Error as its string", async () => {
    // eslint-disable-next-line require-yield
    vi.mocked(askQuestion).mockImplementationOnce(async function* () {
      throw "plain string";
    });
    const { result } = setup();
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.ask("Q?");
    });
    expect(ok).toBe(false);
    expect(result.current.error).toBe("plain string");
    expect(result.current.stopped).toBe(false);
  });

  it("sends the paper id and the question", async () => {
    let url: string | undefined;
    let body: unknown;
    server.use(
      http.post("*/api/papers/:id/ask", async ({ request }) => {
        url = new URL(request.url).pathname;
        body = await request.json();
        return new HttpResponse(ndjson([{ type: "done" }]));
      }),
    );
    const { result } = setup(7);
    await act(async () => void (await result.current.ask("Why?")));
    expect(url).toBe("/api/papers/7/ask");
    expect(body).toEqual({ question: "Why?" });
  });

  it("stop() after the answer completed does nothing", async () => {
    respondWith([{ type: "done" }]);
    const { result } = setup();
    await act(async () => void (await result.current.ask("Q?")));
    act(() => result.current.stop());
    expect(result.current).toMatchObject({ turn: null, error: null, stopped: false, streaming: false });
  });

  it("unmounting with nothing in flight does not throw", () => {
    const { unmount } = setup();
    expect(() => unmount()).not.toThrow();
  });

  it("ignores a second ask while one is in flight", async () => {
    let requests = 0;
    server.use(
      http.post("*/api/papers/1/ask", async () => {
        // Only the first request hangs, so a second ask (if it were sent) settles instead of timing out.
        if (++requests > 1) return new HttpResponse(ndjson([{ type: "done" }]));
        await delay("infinite");
        return new HttpResponse(null);
      }),
    );
    const { result } = setup();
    let first!: Promise<boolean>;
    act(() => {
      first = result.current.ask("First?");
    });
    await waitFor(() => expect(result.current.streaming).toBe(true));

    let second: boolean | undefined;
    await act(async () => {
      second = await result.current.ask("Second?");
    });
    expect(second).toBe(false);
    expect(requests).toBe(1);
    expect(result.current.streaming).toBe(true);
    expect(result.current.turn).toEqual({ question: "First?", answer: "" });

    act(() => result.current.stop());
    expect(await first).toBe(false);
  });

  it("lets stop() reach a newer question after an older one finished", async () => {
    const first = gatedResponse();
    const second = gatedResponse();
    const responses = [first, second];
    server.use(http.post("*/api/papers/1/ask", () => responses.shift()!.respond()));
    const { result } = setup();
    let one!: Promise<boolean>;
    let two!: Promise<boolean>;
    act(() => {
      one = result.current.ask("One");
    });
    await waitFor(() => expect(result.current.streaming).toBe(true));
    act(() => {
      two = result.current.ask("Two");
    });

    // The older request finishing must not clear the controller of the newer one.
    first.push({ type: "done" });
    first.close();
    await one;
    act(() => result.current.stop());
    expect(await two).toBe(false);
    await waitFor(() => expect(result.current.stopped).toBe(true));
  });
});
