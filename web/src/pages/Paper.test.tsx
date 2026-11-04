import { screen, waitFor } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { Link, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { Paper } from "@paper-reader/shared";
import { makeMessage, makePaper } from "../test/fixtures.js";
import { renderApp } from "../test/render.js";
import { server } from "../test/server.js";
import { PaperPage } from "./Paper.js";

function renderAt(route: string) {
  return renderApp(
    <Routes>
      <Route path="/papers/:id" element={<PaperPage />} />
    </Routes>,
    { route },
  );
}

/** Like `renderAt`, with links beside the routes so a test can move between papers without remounting. */
function renderWithLinks(route: string, ids: number[]) {
  return renderApp(
    <>
      {ids.map((id) => (
        <Link key={id} to={`/papers/${id}`}>
          Go to {id}
        </Link>
      ))}
      <Routes>
        <Route path="/papers/:id" element={<PaperPage />} />
      </Routes>
    </>,
    { route },
  );
}

function usePaper(paper: Paper, messages: ReturnType<typeof makeMessage>[] = []) {
  server.use(
    http.get(`*/api/papers/${paper.id}`, () => HttpResponse.json(paper)),
    http.get(`*/api/papers/${paper.id}/messages`, () => HttpResponse.json(messages)),
  );
}

/** Records the path of every request that starts, until the test ends. */
function recordRequests() {
  const paths: string[] = [];
  const onStart = ({ request }: { request: Request }) => void paths.push(new URL(request.url).pathname);
  server.events.on("request:start", onStart);
  cleanups.push(() => server.events.removeListener("request:start", onStart));
  return paths;
}
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

describe("PaperPage", () => {
  it.each([
    // Accepted: the request goes to the numeric id.
    { segment: "007", id: 7 },
    { segment: "+5", id: 5 },
    { segment: "1.0", id: 1 },
    { segment: "%205", id: 5 },
    { segment: "1e3", id: 1000 },
    { segment: "0x10", id: 16 },
  ])("accepts the id segment $segment as $id", async ({ segment, id }) => {
    usePaper(makePaper({ id, title: `Paper ${id}` }));
    const paths = recordRequests();
    renderAt(`/papers/${segment}`);
    expect(await screen.findByRole("heading", { name: /Paper/ })).toHaveTextContent(`Paper ${id}`);
    expect(paths).toContain(`/api/papers/${id}`);
    expect(screen.queryByText("Invalid paper id.")).not.toBeInTheDocument();
  });

  it.each(["abc", "0", "-1", "1.5", "12abc", "%20", "Infinity", "1e400"])(
    "rejects the invalid id %s without any request",
    (segment) => {
      const paths = recordRequests();
      renderAt(`/papers/${segment}`);
      expect(screen.getByText("Invalid paper id.")).toHaveClass("error");
      expect(paths).toEqual([]);
    },
  );

  it("shows a loading state, then the paper", async () => {
    server.use(
      http.get("*/api/papers/4", async () => {
        await delay(100);
        return HttpResponse.json(makePaper({ id: 4, title: "Slow Paper" }));
      }),
      http.get("*/api/papers/4/messages", () => HttpResponse.json([])),
    );
    renderAt("/papers/4");
    expect(screen.getByText("Loading…")).toHaveClass("muted");
    expect(await screen.findByRole("heading", { name: "Slow Paper (2020)" })).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("shows the title, year, authors and a link back to the library", async () => {
    usePaper(makePaper({ id: 6, title: "Deep Paper", year: 2021, authors: ["A", "B"] }));
    renderAt("/papers/6");
    expect(await screen.findByRole("heading", { name: "Deep Paper (2021)" })).toBeInTheDocument();
    expect(screen.getByText("A, B")).toHaveClass("byline");
    expect(screen.getByRole("link", { name: "← Library" })).toHaveAttribute("href", "/library");
  });

  it("links the PDF and Semantic Scholar page in a new tab", async () => {
    usePaper(makePaper({ id: 6, url: "https://s2.example/p", pdfUrl: "https://x.example/p.pdf" }));
    renderAt("/papers/6");
    const pdf = await screen.findByRole("link", { name: /PDF/ });
    expect(pdf).toHaveAttribute("href", "https://x.example/p.pdf");
    expect(pdf).toHaveAttribute("target", "_blank");
    expect(pdf).toHaveAttribute("rel", "noreferrer");
    const s2 = screen.getByRole("link", { name: /Semantic Scholar/ });
    expect(s2).toHaveAttribute("href", "https://s2.example/p");
    expect(s2).toHaveAttribute("target", "_blank");
    expect(s2).toHaveAttribute("rel", "noreferrer");
  });

  it("shows the chat for the paper", async () => {
    usePaper(makePaper({ id: 6 }));
    renderAt("/papers/6");
    expect(await screen.findByLabelText("Question about this paper")).toBeInTheDocument();
  });

  it.each([
    { name: "no year", overrides: { year: null }, byline: true, pdf: false, s2: false },
    { name: "no authors", overrides: { authors: [] }, byline: false, pdf: false, s2: false },
    { name: "only a PDF link", overrides: { pdfUrl: "https://x.example/p.pdf" }, byline: true, pdf: true, s2: false },
    { name: "only a Semantic Scholar link", overrides: { url: "https://s2.example/p" }, byline: true, pdf: false, s2: true },
    { name: "neither link", overrides: {}, byline: true, pdf: false, s2: false },
  ] satisfies { name: string; overrides: Partial<Paper>; byline: boolean; pdf: boolean; s2: boolean }[])(
    "hides what is missing: $name",
    async ({ overrides, byline, pdf, s2 }) => {
      usePaper(makePaper({ id: 6, title: "Bare", ...overrides }));
      const { container } = renderAt("/papers/6");
      const heading = await screen.findByRole("heading", { name: /Bare/ });
      if ("year" in overrides) expect(heading).toHaveTextContent(/^Bare$/);
      expect(container.querySelector(".byline") !== null).toBe(byline);
      expect(screen.queryByRole("link", { name: /PDF/ }) !== null).toBe(pdf);
      expect(screen.queryByRole("link", { name: /Semantic Scholar/ }) !== null).toBe(s2);
    },
  );

  it("shows no stray 0 when the year is 0", async () => {
    usePaper(makePaper({ id: 6, title: "Ancient", year: 0 }));
    renderAt("/papers/6");
    expect(await screen.findByRole("heading", { name: "Ancient" })).toHaveTextContent(/^Ancient$/);
  });

  it("notes a missing abstract", async () => {
    usePaper(makePaper({ id: 3, abstract: null }));
    renderAt("/papers/3");
    expect(await screen.findByText("No abstract available.")).toBeInTheDocument();
  });

  it("shows the server's error for an unknown paper", async () => {
    server.use(http.get("*/api/papers/9", () => HttpResponse.json({ error: "Paper not found" }, { status: 404 })));
    renderAt("/papers/9");
    expect(await screen.findByText("Paper not found")).toHaveClass("error");
  });

  it("offers Summarize when there is no summary, and shows the result", async () => {
    let paper = makePaper({ id: 8 });
    server.use(
      http.get("*/api/papers/8", () => HttpResponse.json(paper)),
      http.get("*/api/papers/8/messages", () => HttpResponse.json([])),
      http.post("*/api/papers/8/summarize", async () => {
        await delay(200);
        paper = makePaper({ id: 8, summary: "It is about X." });
        return HttpResponse.json(paper);
      }),
    );
    const { user } = renderAt("/papers/8");
    await user.click(await screen.findByRole("button", { name: "Summarize" }));
    expect(await screen.findByText(/Summarizing…/)).toBeInTheDocument();
    expect(await screen.findByText("It is about X.")).toHaveClass("summary");
    expect(screen.getByRole("button", { name: "Regenerate summary" })).toBeInTheDocument();
  });

  it("replaces the summarize button while pending, so only one request is sent", async () => {
    let paper = makePaper({ id: 8 });
    let posts = 0;
    server.use(
      http.get("*/api/papers/8", () => HttpResponse.json(paper)),
      http.get("*/api/papers/8/messages", () => HttpResponse.json([])),
      http.post("*/api/papers/8/summarize", async () => {
        posts++;
        await delay(100);
        paper = makePaper({ id: 8, summary: "Done." });
        return HttpResponse.json(paper);
      }),
    );
    const { user } = renderAt("/papers/8");
    await user.click(await screen.findByRole("button", { name: "Summarize" }));
    expect(await screen.findByText(/Summarizing…/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Summarize" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Regenerate summary" })).not.toBeInTheDocument();
    await screen.findByText("Done.");
    expect(posts).toBe(1);
  });

  it("shows an error when summarizing fails, and lets the user retry", async () => {
    usePaper(makePaper({ id: 8, summary: "Old." }));
    server.use(http.post("*/api/papers/8/summarize", () => HttpResponse.json({ error: "No PDF link" }, { status: 422 })));
    const { user } = renderAt("/papers/8");
    await user.click(await screen.findByRole("button", { name: "Regenerate summary" }));
    expect(await screen.findByText("No PDF link")).toHaveClass("error");
    expect(screen.getByText("Old.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate summary" })).toBeEnabled();
  });

  it("clears the summarize error after a successful retry", async () => {
    let paper = makePaper({ id: 8 });
    let attempts = 0;
    server.use(
      http.get("*/api/papers/8", () => HttpResponse.json(paper)),
      http.get("*/api/papers/8/messages", () => HttpResponse.json([])),
      http.post("*/api/papers/8/summarize", () => {
        if (++attempts === 1) return HttpResponse.json({ error: "No PDF link" }, { status: 422 });
        paper = makePaper({ id: 8, summary: "Finally." });
        return HttpResponse.json(paper);
      }),
    );
    const { user } = renderAt("/papers/8");
    await user.click(await screen.findByRole("button", { name: "Summarize" }));
    await screen.findByText("No PDF link");
    await user.click(screen.getByRole("button", { name: "Summarize" }));
    expect(await screen.findByText("Finally.")).toHaveClass("summary");
    expect(screen.queryByText("No PDF link")).not.toBeInTheDocument();
  });

  it("does not carry a summarize error over to another paper", async () => {
    usePaper(makePaper({ id: 1, title: "First" }));
    usePaper(makePaper({ id: 2, title: "Second" }));
    server.use(http.post("*/api/papers/1/summarize", () => HttpResponse.json({ error: "No PDF link" }, { status: 422 })));
    const { user } = renderWithLinks("/papers/1", [1, 2]);
    await user.click(await screen.findByRole("button", { name: "Summarize" }));
    await screen.findByText("No PDF link");
    await user.click(screen.getByRole("link", { name: "Go to 2" }));
    await screen.findByRole("heading", { name: /Second/ });
    expect(screen.queryByText("No PDF link")).not.toBeInTheDocument();
  });

  it("does not carry a pending summarize over to another paper", async () => {
    usePaper(makePaper({ id: 1, title: "First" }));
    usePaper(makePaper({ id: 2, title: "Second" }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post("*/api/papers/1/summarize", async () => {
        await gate;
        return HttpResponse.json(makePaper({ id: 1, summary: "S" }));
      }),
    );
    const { user } = renderWithLinks("/papers/1", [1, 2]);
    await user.click(await screen.findByRole("button", { name: "Summarize" }));
    await screen.findByText(/Summarizing…/);
    await user.click(screen.getByRole("link", { name: "Go to 2" }));
    await screen.findByRole("heading", { name: /Second/ });
    try {
      expect(screen.queryByText(/Summarizing…/)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Summarize" })).toBeInTheDocument();
    } finally {
      release();
    }
  });

  it("resets the chat when the id changes", async () => {
    usePaper(makePaper({ id: 1, title: "First" }), [makeMessage({ id: 1, paperId: 1, content: "Only on one" })]);
    usePaper(makePaper({ id: 2, title: "Second" }), [makeMessage({ id: 2, paperId: 2, content: "Only on two" })]);
    const { user } = renderWithLinks("/papers/1", [1, 2]);
    await screen.findByText("Only on one");
    await user.type(screen.getByLabelText("Question about this paper"), "half a thought");
    await user.click(screen.getByRole("link", { name: "Go to 2" }));
    expect(await screen.findByText("Only on two")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Question about this paper")).toHaveValue(""));
    expect(screen.queryByText("Only on one")).not.toBeInTheDocument();
  });
});
