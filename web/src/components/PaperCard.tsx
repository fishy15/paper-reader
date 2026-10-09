import type { ReactNode } from "react";
import type { PaperMetadata } from "@paper-reader/shared";

interface PaperCardProps {
  paper: PaperMetadata & { pdfUrl: string | null };
  badge?: string | undefined;
  children?: ReactNode;
}

export function PaperCard({ paper, badge, children }: PaperCardProps) {
  const byline = paper.authors.join(", ");
  return (
    <article className="card">
      <h3>
        {paper.title}
        {paper.year && ` (${paper.year})`}
        {badge && <span className="badge">{badge}</span>}
      </h3>
      {byline && <p className="byline">{byline}</p>}
      {paper.abstract ? (
        <details>
          <summary>Abstract</summary>
          <p>{paper.abstract}</p>
        </details>
      ) : (
        <p className="muted">No abstract available.</p>
      )}
      <div className="actions">
        {paper.url && (
          <a href={paper.url} target="_blank" rel="noreferrer">
            View
          </a>
        )}
        {paper.pdfUrl && (
          <a href={paper.pdfUrl} target="_blank" rel="noreferrer">
            PDF
          </a>
        )}
        {children}
      </div>
    </article>
  );
}
