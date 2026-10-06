import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deletePaper, listPapers } from "../api.js";
import { PaperCard } from "../components/PaperCard.js";

export function Library() {
  const queryClient = useQueryClient();
  const papers = useQuery({ queryKey: ["papers"], queryFn: listPapers });
  const remove = useMutation({
    mutationFn: deletePaper,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["papers"] }),
  });

  if (papers.isPending) return <p className="muted">Loading…</p>;
  if (papers.error) return <p className="error">{papers.error.message}</p>;
  if (papers.data.length === 0) {
    return <p className="muted">Your library is empty. Search for papers and save them here.</p>;
  }

  return (
    <section>
      {remove.error && <p className="error">{remove.error.message}</p>}
      {papers.data.map((paper) => (
        <PaperCard key={paper.id} paper={paper} badge={paper.source === "upload" ? "uploaded" : undefined}>
          <button
            className="danger"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(`Delete "${paper.title}"?`)) remove.mutate(paper.id);
            }}
          >
            Delete
          </button>
        </PaperCard>
      ))}
    </section>
  );
}
