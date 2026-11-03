import { screen } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import type { Paper } from "@paper-reader/shared";
import { makePaper } from "../test/fixtures.js";
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

function usePaper(paper: Paper) {
  server.use(
    http.get(`*/api/papers/${paper.id}`, () => HttpResponse.json(paper)),
    http.get(`*/api/papers/${paper.id}/messages`, () => HttpResponse.json([])),
  );
}

describe("PaperPage", () => {
  it.each(["abc", "0", "-1", "1.5"])("rejects the invalid id %s without any request", (id) => {
    renderAt(`/papers/${id}`);
    expect(screen.getByText("Invalid paper id.")).toHaveClass("error");
  });

  it("shows the paper's details, links and chat", async () => {
    usePaper(makePaper({ title: "Deep Paper", year: 2021, authors: ["A", "B"], url: "https://s2.example/p", pdfUrl: "https://x.example/p.pdf" }));
    renderAt("/papers/1");
    expect(await screen.findByRole("heading", { name: "Deep Paper (2021)" })).toBeInTheDocument();
    expect(screen.getByText("A, B")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /PDF/ })).toHaveAttribute("href", "https://x.example/p.pdf");
    expect(screen.getByRole("link", { name: /Semantic Scholar/ })).toHaveAttribute("href", "https://s2.example/p");
    expect(screen.getByRole("link", { name: "← Library" })).toHaveAttribute("href", "/library");
    expect(screen.getByLabelText("Question about this paper")).toBeInTheDocument();
  });

  it("notes a missing abstract", async () => {
    usePaper(makePaper({ abstract: null }));
    renderAt("/papers/1");
    expect(await screen.findByText("No abstract available.")).toBeInTheDocument();
  });

  it("shows the server's error for an unknown paper", async () => {
    server.use(http.get("*/api/papers/9", () => HttpResponse.json({ error: "Paper not found" }, { status: 404 })));
    renderAt("/papers/9");
    expect(await screen.findByText("Paper not found")).toHaveClass("error");
  });

  it("offers Summarize when there is no summary, and shows the result", async () => {
    let paper = makePaper();
    server.use(
      http.get("*/api/papers/1", () => HttpResponse.json(paper)),
      http.get("*/api/papers/1/messages", () => HttpResponse.json([])),
      http.post("*/api/papers/1/summarize", async () => {
        await delay(200);
        paper = makePaper({ summary: "It is about X." });
        return HttpResponse.json(paper);
      }),
    );
    const { user } = renderAt("/papers/1");
    await user.click(await screen.findByRole("button", { name: "Summarize" }));
    expect(await screen.findByText(/Summarizing…/)).toBeInTheDocument();
    expect(await screen.findByText("It is about X.")).toHaveClass("summary");
    expect(screen.getByRole("button", { name: "Regenerate summary" })).toBeInTheDocument();
  });

  it("shows an error when summarizing fails", async () => {
    usePaper(makePaper({ summary: "Old." }));
    server.use(http.post("*/api/papers/1/summarize", () => HttpResponse.json({ error: "No PDF link" }, { status: 422 })));
    const { user } = renderAt("/papers/1");
    await user.click(await screen.findByRole("button", { name: "Regenerate summary" }));
    expect(await screen.findByText("No PDF link")).toHaveClass("error");
    expect(screen.getByText("Old.")).toBeInTheDocument();
  });
});
