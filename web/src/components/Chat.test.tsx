import { fireEvent, screen, waitFor } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { QaMessage, QaStreamEvent } from "@paper-reader/shared";
import { makeMessage, ndjson } from "../test/fixtures.js";
import { deferred } from "../test/deferred.js";
import { renderApp } from "../test/render.js";
import { server } from "../test/server.js";
import { Chat } from "./Chat.js";

const input = () => screen.getByLabelText("Question about this paper");

function useConversation(initial: QaMessage[] = []) {
  const messages = [...initial];
  server.use(http.get("*/api/papers/1/messages", () => HttpResponse.json(messages)));
  return messages;
}

/** An ask response that sends `first` right away and stays open until `finish` sends the rest and closes it. */
function gatedStream(first: QaStreamEvent[]) {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      c.enqueue(encoder.encode(ndjson(first)));
    },
  });
  return {
    response: () => new HttpResponse(body),
    finish(rest: QaStreamEvent[]) {
      controller.enqueue(encoder.encode(ndjson(rest)));
      controller.close();
    },
  };
}

const form = () => {
  const found = input().closest("form");
  if (!found) throw new Error("The question input is not inside a form");
  return found;
};

const ask = () => screen.getByRole("button", { name: "Ask" });

describe("Chat", () => {
  it("shows the saved conversation", async () => {
    useConversation([
      makeMessage({ id: 1, role: "user", content: "What is this?" }),
      makeMessage({ id: 2, role: "assistant", content: "A paper." }),
    ]);
    renderApp(<Chat paperId={1} />);
    expect(await screen.findByText("What is this?")).toHaveClass("message", "user");
    expect(screen.getByText("A paper.")).toHaveClass("message", "assistant");
  });

  it("shows an error when the conversation can't be loaded", async () => {
    server.use(http.get("*/api/papers/1/messages", () => HttpResponse.json({ error: "Paper not found" }, { status: 404 })));
    renderApp(<Chat paperId={1} />);
    expect(await screen.findByText("Paper not found")).toHaveClass("error");
  });

  it("disables Ask until there is a non-blank question", async () => {
    useConversation();
    const { user } = renderApp(<Chat paperId={1} />);
    const ask = screen.getByRole("button", { name: "Ask" });
    expect(ask).toBeDisabled();
    await user.type(input(), "   ");
    expect(ask).toBeDisabled();
    await user.type(input(), "why?");
    expect(ask).toBeEnabled();
  });

  it("streams an answer, then shows the saved messages and clears the input", async () => {
    const messages = useConversation();
    server.use(
      http.post("*/api/papers/1/ask", async () => {
        messages.push(
          makeMessage({ id: 1, role: "user", content: "Why?" }),
          makeMessage({ id: 2, role: "assistant", content: "Because." }),
        );
        return new HttpResponse(
          ndjson([{ type: "delta", text: "Be" }, { type: "delta", text: "cause." }, { type: "done" }]),
        );
      }),
    );
    const { user } = renderApp(<Chat paperId={1} />);
    await user.type(input(), "  Why?  ");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() => expect(screen.getByText("Because.")).toHaveClass("assistant"));
    expect(screen.getAllByText("Why?")).toHaveLength(1);
    expect(input()).toHaveValue("");
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
  });

  it("shows Thinking… and a Stop button while waiting, then the stopped notice", async () => {
    useConversation();
    server.use(
      http.post("*/api/papers/1/ask", async () => {
        await delay("infinite");
        return new HttpResponse(null);
      }),
    );
    const { user } = renderApp(<Chat paperId={1} />);
    await user.type(input(), "Why?");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    expect(await screen.findByText("Thinking…")).toBeInTheDocument();
    expect(input()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Stop" }));

    expect(await screen.findByText(/Answer stopped/)).toBeInTheDocument();
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
    expect(input()).toHaveValue("Why?");
    expect(screen.getByRole("button", { name: "Ask" })).toBeEnabled();
  });

  it("shows an error event and keeps the question for a retry", async () => {
    useConversation();
    server.use(
      http.post("*/api/papers/1/ask", () =>
        new HttpResponse(ndjson([{ type: "delta", text: "Partial" }, { type: "error", message: "Model overloaded" }])),
      ),
    );
    const { user } = renderApp(<Chat paperId={1} />);
    await user.type(input(), "Why?");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    expect(await screen.findByText("Model overloaded")).toHaveClass("error");
    expect(input()).toHaveValue("Why?");
    expect(input()).toBeEnabled();
    expect(ask()).toBeEnabled();
    // The turn is dropped just after the error is set, so the partial answer disappears a moment later.
    await waitFor(() => expect(screen.queryByText("Partial")).not.toBeInTheDocument());
  });

  it("shows the server's message when the request is rejected up front", async () => {
    useConversation();
    server.use(
      http.post("*/api/papers/1/ask", () => HttpResponse.json({ error: "Rate limit reached" }, { status: 429 })),
    );
    const { user } = renderApp(<Chat paperId={1} />);
    await user.type(input(), "Why?");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText("Rate limit reached")).toHaveClass("error");
    expect(input()).toHaveValue("Why?");
  });

  it("reports a stream that ends without done as an error", async () => {
    useConversation();
    server.use(http.post("*/api/papers/1/ask", () => new HttpResponse(ndjson([{ type: "delta", text: "x" }]))));
    const { user } = renderApp(<Chat paperId={1} />);
    await user.type(input(), "Why?");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText("The answer was cut off before it finished")).toHaveClass("error");
  });

  it("shows the partial answer mid-stream, with the question already a user bubble", async () => {
    useConversation();
    const stream = gatedStream([{ type: "delta", text: "Partial" }]);
    server.use(http.post("*/api/papers/1/ask", () => stream.response()));
    const { user } = renderApp(<Chat paperId={1} />);
    await user.type(input(), "Why?");
    await user.click(ask());

    // Messages are plain divs with no role or label, so the class is the only way to tell them apart from other text.
    expect(await screen.findByText("Partial")).toHaveClass("message", "assistant");
    expect(screen.getByText("Why?", { selector: ".message" })).toHaveClass("user");
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".chat .message")).toHaveLength(2);

    stream.finish([{ type: "done" }]);
    await waitFor(() => expect(screen.queryByText("Partial")).not.toBeInTheDocument());
  });

  it("sends the trimmed question", async () => {
    useConversation();
    let sent: unknown;
    server.use(
      http.post("*/api/papers/1/ask", async ({ request }) => {
        sent = await request.json();
        return new HttpResponse(ndjson([{ type: "done" }]));
      }),
    );
    const { user } = renderApp(<Chat paperId={1} />);
    await user.type(input(), "  Why?  ");
    await user.click(ask());
    await waitFor(() => expect(sent).toEqual({ question: "Why?" }));
  });

  it.each([
    {
      name: "an error event",
      stop: false,
      first: () => new HttpResponse(ndjson([{ type: "error", message: "Model overloaded" }])),
      present: () => screen.queryByText("Model overloaded"),
    },
    {
      name: "Stop",
      stop: true,
      first: () => new HttpResponse(new ReadableStream<Uint8Array>()),
      present: () => screen.queryByText(/Answer stopped/),
    },
  ])("clears the previous outcome when asking again after $name", async ({ first, present, stop }) => {
    const messages = useConversation();
    let calls = 0;
    server.use(
      http.post("*/api/papers/1/ask", () => {
        calls += 1;
        if (calls === 1) return first();
        messages.push(
          makeMessage({ id: 1, role: "user", content: "Why?" }),
          makeMessage({ id: 2, role: "assistant", content: "Because." }),
        );
        return new HttpResponse(ndjson([{ type: "delta", text: "Because." }, { type: "done" }]));
      }),
    );
    const { user } = renderApp(<Chat paperId={1} />);
    await user.type(input(), "Why?");
    await user.click(ask());
    if (stop) await user.click(await screen.findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(present()).toBeInTheDocument());
    await waitFor(() => expect(ask()).toBeEnabled());

    await user.click(ask());
    expect(await screen.findByText("Because.")).toHaveClass("assistant");
    expect(present()).not.toBeInTheDocument();
    expect(input()).toHaveValue("");
    expect(calls).toBe(2);
  });

  it("stops a partial answer: notice shown, partial text gone, input enabled", async () => {
    useConversation();
    const stream = gatedStream([{ type: "delta", text: "Partial" }]);
    server.use(http.post("*/api/papers/1/ask", () => stream.response()));
    const { user } = renderApp(<Chat paperId={1} />);
    await user.type(input(), "Why?");
    await user.click(ask());
    expect(await screen.findByText("Partial")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText(/Answer stopped/)).toBeInTheDocument();
    expect(screen.queryByText("Partial")).not.toBeInTheDocument();
    expect(input()).toBeEnabled();
    expect(input()).toHaveValue("Why?");
  });

  it("submits the question when Enter is pressed", async () => {
    useConversation();
    let sent: unknown;
    server.use(
      http.post("*/api/papers/1/ask", async ({ request }) => {
        sent = await request.json();
        return new HttpResponse(ndjson([{ type: "done" }]));
      }),
    );
    const { user } = renderApp(<Chat paperId={1} />);
    await user.type(input(), "Why?{Enter}");
    await waitFor(() => expect(sent).toEqual({ question: "Why?" }));
  });

  it("ignores a submit with a blank question", async () => {
    useConversation();
    let requests = 0;
    server.use(
      http.post("*/api/papers/1/ask", () => {
        requests += 1;
        return new HttpResponse(ndjson([{ type: "done" }]));
      }),
    );
    const { user } = renderApp(<Chat paperId={1} />);
    fireEvent.submit(form());
    await user.type(input(), "   ");
    fireEvent.submit(form());
    expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();

    // A real question afterwards is the first request that arrives, so the blank submits sent nothing.
    await user.type(input(), "Why?");
    await user.click(ask());
    await waitFor(() => expect(input()).toHaveValue(""));
    expect(requests).toBe(1);
  });

  it("ignores a second submit while an answer is streaming", async () => {
    useConversation();
    let requests = 0;
    const stream = gatedStream([{ type: "delta", text: "Partial" }]);
    server.use(
      http.post("*/api/papers/1/ask", () => {
        requests += 1;
        return stream.response();
      }),
    );
    const { user } = renderApp(<Chat paperId={1} />);
    await user.type(input(), "Why?");
    await user.click(ask());
    expect(await screen.findByText("Partial")).toBeInTheDocument();

    fireEvent.submit(form());
    // Give a second request time to arrive while the first answer is still streaming.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests).toBe(1);
    stream.finish([{ type: "done" }]);
    await waitFor(() => expect(input()).toHaveValue(""));
    expect(requests).toBe(1);
  });

  it("shows a loading message until the conversation loads", async () => {
    const gate = deferred();
    server.use(
      http.get("*/api/papers/1/messages", async () => {
        await gate.promise;
        return HttpResponse.json([makeMessage({ id: 1, role: "user", content: "What is this?" })]);
      }),
    );
    renderApp(<Chat paperId={1} />);
    expect(screen.getByText("Loading conversation…")).toBeInTheDocument();
    gate.resolve();
    expect(await screen.findByText("What is this?")).toBeInTheDocument();
    expect(screen.queryByText("Loading conversation…")).not.toBeInTheDocument();
  });

  it("refetches the conversation after an answer", async () => {
    let fetches = 0;
    server.use(
      http.get("*/api/papers/1/messages", () => {
        fetches += 1;
        return HttpResponse.json([]);
      }),
      http.post("*/api/papers/1/ask", () => new HttpResponse(ndjson([{ type: "delta", text: "Hi" }, { type: "done" }]))),
    );
    const { user } = renderApp(<Chat paperId={1} />);
    await waitFor(() => expect(fetches).toBe(1));
    await user.type(input(), "Why?");
    await user.click(ask());
    await waitFor(() => expect(fetches).toBe(2));
    // One refetch per answer, not more.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetches).toBe(2);
  });
});
