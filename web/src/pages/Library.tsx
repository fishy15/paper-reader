import { Link } from "react-router";
import { PaperCard } from "../components/PaperCard.js";
import { UploadBox } from "../components/UploadBox.js";
import { useDeletePaper, usePapers } from "../queries.js";

export function Library() {
  const papers = usePapers();
  const remove = useDeletePaper();

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
          <Link to={`/papers/${paper.id}`}>More Info</Link>
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
