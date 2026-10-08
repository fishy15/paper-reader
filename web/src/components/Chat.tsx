import { useState, type ReactNode, type SubmitEvent } from "react";
import { useMessages } from "../queries.js";
import { useAskQuestion } from "../useAskQuestion.js";

function Message({ role, children }: { role: "user" | "assistant"; children: ReactNode }) {
  return <div className={`message ${role}`}>{children}</div>;
}

export function Chat({ paperId }: { paperId: number }) {
  const messages = useMessages(paperId);
  const { turn, error, stopped, streaming, ask, stop } = useAskQuestion(paperId);
  const [input, setInput] = useState("");

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || streaming) return;
    // The question stays in the box if asking fails, so it can be retried.
    if (await ask(question)) setInput("");
  }

  return (
    <div>
      {messages.isPending && <p className="muted">Loading conversation…</p>}
      {messages.error && <p className="error">{messages.error.message}</p>}
      <div className="chat">
        {messages.data?.map((m) => (
          <Message key={m.id} role={m.role}>
            {m.content}
          </Message>
        ))}
        {turn && (
          <>
            <Message role="user">{turn.question}</Message>
            <Message role="assistant">{turn.answer || "Thinking…"}</Message>
          </>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {stopped && <p className="muted">Answer stopped. The question and partial answer were not saved.</p>}
      <form onSubmit={onSubmit} className="inline-form">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question about this paper…"
          aria-label="Question about this paper"
          disabled={streaming}
        />
        {/* Distinct keys keep these two from sharing one DOM node: a Stop click that flips the node
            back to a submit button before the browser finishes the click would submit the form again. */}
        {streaming ? (
          <button key="stop" type="button" onClick={stop}>
            Stop
          </button>
        ) : (
          <button key="ask" type="submit" disabled={input.trim() === ""}>
            Ask
          </button>
        )}
      </form>
    </div>
  );
}
