import { screen, waitFor } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { QaMessage } from "@paper-reader/shared";
import { makeMessage, ndjson } from "../test/fixtures.js";
import { renderApp } from "../test/render.js";
import { server } from "../test/server.js";
import { Chat } from "./Chat.js";

const input = () => screen.getByLabelText("Question about this paper");

function useConversation(initial: QaMessage[] = []) {
  const messages = [...initial];
  server.use(http.get("*/api/papers/1/messages", () => HttpResponse.json(messages)));
  return messages;
}

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
    let sent: unknown;
    server.use(
      http.post("*/api/papers/1/ask", async ({ request }) => {
        sent = await request.json();
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
    expect(sent).toEqual({ question: "Why?" });
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
    expect(await screen.findByText(/.+/, { selector: ".error" })).toBeInTheDocument();
  });
});
