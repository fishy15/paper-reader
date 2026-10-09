import { Link, useParams } from "react-router";
import { Chat } from "../components/Chat.js";
import { usePaper, useSummarizePaper } from "../queries.js";

export function PaperPage() {
  const id = Number(useParams().id);
  if (!Number.isInteger(id) || id <= 0) return <p className="error">Invalid paper id.</p>;
  return <PaperDetail id={id} />;
}

function PaperDetail({ id }: { id: number }) {
  const paper = usePaper(id);
  const summarize = useSummarizePaper();

  if (paper.isPending) return <p className="muted">Loading…</p>;
  if (paper.error) return <p className="error">{paper.error.message}</p>;

  const { data } = paper;
  const byline = data.authors.join(", ");
  return (
    <section>
      <p>
        <Link to="/library">← Library</Link>
      </p>
      <h2>
        {data.title}
        {data.year && ` (${data.year})`}
      </h2>
      {byline && <p className="byline">{byline}</p>}
      <div className="actions">
        {data.pdfUrl && (
          <a href={data.pdfUrl} target="_blank" rel="noreferrer">
            PDF ↗
          </a>
        )}
        {data.url && (
          <a href={data.url} target="_blank" rel="noreferrer">
            Semantic Scholar ↗
          </a>
        )}
      </div>

      <h3>Abstract</h3>
      <p>{data.abstract ?? <span className="muted">No abstract available.</span>}</p>

      <h3>Summary</h3>
      {data.summary && <p className="summary">{data.summary}</p>}
      {summarize.isPending ? (
        <p className="muted">Summarizing… this can take a minute, especially if the PDF has to be downloaded first.</p>
      ) : (
        <button onClick={() => summarize.mutate(id)}>{data.summary ? "Regenerate summary" : "Summarize"}</button>
      )}
      {summarize.error && <p className="error">{summarize.error.message}</p>}

      <h3>Ask about this paper</h3>
      <Chat key={id} paperId={id} />
    </section>
  );
}
