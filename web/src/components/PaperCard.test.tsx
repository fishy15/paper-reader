import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    expect(screen.getByRole("article")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Attention Is All You Need (2017)" })).toBeInTheDocument();
    expect(screen.getByText("Ashish Vaswani, Noam Shazeer")).toBeInTheDocument();
    expect(screen.getByText("We propose the Transformer.")).toBeInTheDocument();
  });

  it("links to the PDF and Semantic Scholar in a new tab", () => {
    render(<PaperCard paper={paper} />);
    const pdf = screen.getByRole("link", { name: /PDF/ });
    expect(pdf).toHaveAttribute("href", paper.pdfUrl);
    expect(pdf).toHaveAttribute("target", "_blank");
    expect(pdf).toHaveAttribute("rel", "noreferrer");
    const s2 = screen.getByRole("link", { name: /Semantic Scholar/ });
    expect(s2).toHaveAttribute("href", paper.url);
    expect(s2).toHaveAttribute("target", "_blank");
    expect(s2).toHaveAttribute("rel", "noreferrer");
  });

  it("omits missing parts and says there is no abstract", () => {
    render(<PaperCard paper={{ ...paper, year: null, authors: [], abstract: null, url: null, pdfUrl: null }} />);
    expect(screen.getByRole("heading", { name: "Attention Is All You Need" })).toBeInTheDocument();
    expect(screen.getByText("No abstract available.")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    // Nothing else is rendered: no year, no byline for an empty author list.
    expect(screen.getByRole("article")).toHaveTextContent(/^Attention Is All You Need\s*No abstract available\.$/);
  });

  it("renders the badge, leading actions and children", () => {
    render(
      <PaperCard paper={paper} badge="uploaded" leading={<button>Lead</button>}>
        <button>Trail</button>
      </PaperCard>,
    );
    // The badge is a bare span with no role, so the class is the only way to check it is styled as a badge.
    expect(screen.getByText("uploaded")).toHaveClass("badge");
    expect(screen.getByRole("button", { name: "Lead" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trail" })).toBeInTheDocument();
  });

  it("shows no extra text for a year of 0", () => {
    render(<PaperCard paper={{ ...paper, year: 0 }} />);
    // A string name must match the whole heading text, so a stray "0" would fail it.
    expect(screen.getByRole("heading", { name: "Attention Is All You Need" })).toBeInTheDocument();
  });

  it.each([
    { name: "only pdfUrl", set: { url: null }, link: /PDF/, href: "https://example.com/paper.pdf" },
    { name: "only url", set: { pdfUrl: null }, link: /Semantic Scholar/, href: "https://example.com/s2" },
  ])("shows a single link with $name", ({ set, link, href }) => {
    render(<PaperCard paper={{ ...paper, ...set }} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName(link);
    expect(links[0]).toHaveAttribute("href", href);
  });

  it("keeps the abstract collapsed until the summary is clicked", async () => {
    const user = userEvent.setup();
    render(<PaperCard paper={paper} />);
    const details = screen.getByRole("group");
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText("Abstract")).toBeInTheDocument();
    expect(screen.getByText("We propose the Transformer.")).not.toBeVisible();

    await user.click(screen.getByText("Abstract"));
    expect(details).toHaveAttribute("open");
    expect(screen.getByText("We propose the Transformer.")).toBeVisible();
  });

  it("orders leading actions, links, then children, with children in the trailing wrapper", () => {
    const { container } = render(
      <PaperCard paper={paper} leading={<button>Lead</button>}>
        <button>Trail</button>
      </PaperCard>,
    );
    const order = [...container.querySelectorAll("a, button")].map((el) => el.textContent);
    expect(order).toEqual(["Lead", "PDF ↗", "Semantic Scholar ↗", "Trail"]);
    // The wrapper is a bare span with no role, so the class is the only way to identify it.
    expect(screen.getByRole("button", { name: "Trail" }).parentElement).toHaveClass("actions-end");
  });

  it("has no trailing wrapper without children", () => {
    const { container } = render(<PaperCard paper={paper} />);
    // The wrapper is a bare span with no role, so the class is the only way to look for it.
    expect(container.querySelector(".actions-end")).toBeNull();
  });

  it("shows HTML in the title and abstract as literal text", () => {
    const title = "<img src=x onerror=alert(1)>";
    const abstract = "<b>bold</b> <img src=y>";
    const { container } = render(<PaperCard paper={{ ...paper, title, abstract }} />);
    expect(screen.getByRole("heading", { name: `${title} (2017)` })).toBeInTheDocument();
    expect(screen.getByText(abstract)).toBeInTheDocument();
    expect(container.querySelector("img, b")).toBeNull();
  });
});
