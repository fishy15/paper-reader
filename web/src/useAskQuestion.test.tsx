import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { QaStreamEvent } from "@paper-reader/shared";
import { messagesKey } from "./queries.js";
import { ndjsonStream } from "./test/fixtures.js";
import { server } from "./test/server.js";
import { useAskQuestion } from "./useAskQuestion.js";

function setup(paperId = 1) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, ...renderHook(() => useAskQuestion(paperId), { wrapper }) };
}

const respondWith = (events: QaStreamEvent[]) =>
  server.use(http.post("*/api/papers/1/ask", () => new HttpResponse(ndjsonStream(events))));

const hang = () =>
  server.use(
    http.post("*/api/papers/1/ask", async () => {
      await delay("infinite");
      return new HttpResponse(null);
    }),
  );

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
    act(() => void result.current.ask("Q?"));
    await waitFor(() => expect(result.current.streaming).toBe(true));
    expect(result.current.turn).toEqual({ question: "Q?", answer: "" });
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
    act(() => void result.current.ask("Q?"));
    await waitFor(() => expect(result.current.streaming).toBe(true));
    unmount();
    await waitFor(() => expect(aborted).toBe(true));
  });

  it("stop() with nothing in flight does nothing", () => {
    const { result } = setup();
    expect(() => act(() => result.current.stop())).not.toThrow();
    expect(result.current.stopped).toBe(false);
  });
});
