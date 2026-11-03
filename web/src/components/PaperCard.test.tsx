import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PaperMetadata } from "@paper-reader/shared";
import { PaperCard } from "./PaperCard.js";

type Paper = PaperMetadata & { pdfUrl: string | null };

const paper: Paper = {
  title: "Attention Is All You Need",
  authors: ["Ashish Vaswani", "Noam Shazeer"],
  year: 2017,
  abstract: "We propose the Transformer.",
  url: "https://example.com/s2",
  pdfUrl: "https://example.com/paper.pdf",
};

describe("PaperCard", () => {
  it("shows title with year, authors and abstract", () => {
    render(<PaperCard paper={paper} />);
    expect(screen.getByRole("heading", { name: "Attention Is All You Need (2017)" })).toBeInTheDocument();
    expect(screen.getByText("Ashish Vaswani, Noam Shazeer")).toBeInTheDocument();
    expect(screen.getByText("We propose the Transformer.")).toBeInTheDocument();
  });

  it("links to the PDF and Semantic Scholar in a new tab", () => {
    render(<PaperCard paper={paper} />);
    const pdf = screen.getByRole("link", { name: /PDF/ });
    expect(pdf).toHaveAttribute("href", paper.pdfUrl);
    expect(pdf).toHaveAttribute("target", "_blank");
    expect(pdf).toHaveAttribute("rel", "noreferrer");
    expect(screen.getByRole("link", { name: /Semantic Scholar/ })).toHaveAttribute("href", paper.url);
  });

  it("omits missing parts and says there is no abstract", () => {
    render(<PaperCard paper={{ ...paper, year: null, authors: [], abstract: null, url: null, pdfUrl: null }} />);
    expect(screen.getByRole("heading", { name: "Attention Is All You Need" })).toBeInTheDocument();
    expect(screen.getByText("No abstract available.")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(document.querySelector(".byline")).toBeNull();
  });

  it("renders the badge, leading actions and children", () => {
    render(
      <PaperCard paper={paper} badge="uploaded" leading={<button>Lead</button>}>
        <button>Trail</button>
      </PaperCard>,
    );
    expect(screen.getByText("uploaded")).toHaveClass("badge");
    expect(screen.getByRole("button", { name: "Lead" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trail" })).toBeInTheDocument();
  });
});
