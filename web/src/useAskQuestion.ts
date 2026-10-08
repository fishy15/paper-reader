import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { askQuestion } from "./api.js";
import { messagesKey } from "./queries.js";

/** The question currently being answered, shown until the saved conversation replaces it. */
export interface Turn {
  question: string;
  answer: string;
}

export function useAskQuestion(paperId: number) {
  const queryClient = useQueryClient();
  const [turn, setTurn] = useState<Turn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const controller = useRef<AbortController | null>(null);

  // Leaving the page cancels an answer that is still streaming.
  useEffect(() => () => controller.current?.abort(), []);

  const stop = () => controller.current?.abort();

  /** Resolves to true once the answer is complete and saved. */
  async function ask(question: string): Promise<boolean> {
    const abort = new AbortController();
    controller.current = abort;
    setError(null);
    setTurn({ question, answer: "" });
    setStreaming(true);
    try {
      for await (const event of askQuestion(paperId, question, abort.signal)) {
        if (event.type === "delta") {
          setTurn((t) => t && { ...t, answer: t.answer + event.text });
        } else if (event.type === "error") {
          setError(event.message);
          return false;
        }
      }
      // The server saved the question and answer; load them before the temporary turn is dropped.
      await queryClient.invalidateQueries({ queryKey: messagesKey(paperId) });
      return true;
    } catch (err) {
      // A stopped answer is not an error; anything else is shown to the user.
      if (!abort.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      // Whatever happened, the turn is over: it is either saved (and now in the messages) or dropped.
      setTurn(null);
      if (controller.current === abort) controller.current = null;
      setStreaming(false);
    }
  }

  return { turn, error, streaming, ask, stop };
}
