import { useState, type ReactNode, type SubmitEvent } from "react";
import { useMessages } from "../queries.js";
import { useAskQuestion } from "../useAskQuestion.js";

function Message({ role, children }: { role: "user" | "assistant"; children: ReactNode }) {
  return <div className={`message ${role}`}>{children}</div>;
}

export function Chat({ paperId }: { paperId: number }) {
  const messages = useMessages(paperId);
  const { turn, error, streaming, ask, stop } = useAskQuestion(paperId);
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
      <form onSubmit={onSubmit} className="inline-form">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question about this paper…"
          aria-label="Question about this paper"
          disabled={streaming}
        />
        {streaming ? (
          <button type="button" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={input.trim() === ""}>
            Ask
          </button>
        )}
      </form>
    </div>
  );
}
