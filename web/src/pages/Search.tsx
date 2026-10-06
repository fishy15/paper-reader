import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { listPapers, savePaper, searchPapers } from "../api.js";
import { PaperCard } from "../components/PaperCard.js";

export function Search() {
  const [input, setInput] = useState("");
  const [submitted, setSubmitted] = useState("");
  const queryClient = useQueryClient();

  const results = useQuery({
    queryKey: ["search", submitted],
    queryFn: () => searchPapers(submitted),
    enabled: submitted !== "",
    retry: false,
  });
  const library = useQuery({ queryKey: ["papers"], queryFn: listPapers });
  const save = useMutation({
    mutationFn: savePaper,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["papers"] }),
  });

  const savedIds = new Set(
    (library.data ?? []).flatMap((p) => (p.source === "search" ? [p.externalId] : [])),
  );

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(input.trim());
  }

  return (
    <section>
      <form onSubmit={onSubmit} className="search-form">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search research papers…"
          aria-label="Search research papers"
        />
        <button type="submit" disabled={input.trim() === ""}>
          Search
        </button>
      </form>

      {results.isFetching && <p className="muted">Searching…</p>}
      {results.error && <p className="error">{results.error.message}</p>}
      {save.error && <p className="error">{save.error.message}</p>}
      {results.data?.length === 0 && <p className="muted">No papers found.</p>}

      {results.data?.map((paper) => {
        const saved = savedIds.has(paper.externalId);
        return (
          <PaperCard key={paper.externalId} paper={paper}>
            <button
              disabled={saved || (save.isPending && save.variables?.externalId === paper.externalId)}
              onClick={() => save.mutate(paper)}
            >
              {saved ? "Saved" : "Save"}
            </button>
          </PaperCard>
        );
      })}
    </section>
  );
}
