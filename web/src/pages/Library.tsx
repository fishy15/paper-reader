import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deletePaper, listPapers } from "../api.js";
import { PaperCard } from "../components/PaperCard.js";
import { UploadBox } from "../components/UploadBox.js";

export function Library() {
  const queryClient = useQueryClient();
  const papers = useQuery({ queryKey: ["papers"], queryFn: listPapers });
  const remove = useMutation({
    mutationFn: deletePaper,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["papers"] }),
  });

  return (
    <section>
      <UploadBox />
      {remove.error && <p className="error">{remove.error.message}</p>}
      {papers.isPending && <p className="muted">Loading…</p>}
      {papers.error && <p className="error">{papers.error.message}</p>}
      {papers.data?.length === 0 && (
        <p className="muted">Your library is empty. Search for papers or upload a PDF.</p>
      )}
      {papers.data?.map((paper) => (
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
