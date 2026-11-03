import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { Paper, SearchResult } from "@paper-reader/shared";
import { makePaper, makeSearchResult } from "../test/fixtures.js";
import { renderApp } from "../test/render.js";
import { server } from "../test/server.js";
import { Search } from "./Search.js";

function useBackend({ results = [] as SearchResult[], library = [] as Paper[] } = {}) {
  const queries: (string | null)[] = [];
  const saved: unknown[] = [];
  server.use(
    http.get("*/api/search", ({ request }) => {
      queries.push(new URL(request.url).searchParams.get("query"));
      return HttpResponse.json(results);
    }),
    http.get("*/api/papers", () => HttpResponse.json(library)),
    http.post("*/api/papers/from-search", async ({ request }) => {
      saved.push(await request.json());
      return HttpResponse.json(makePaper({ source: "search", externalId: "s2-1" }), { status: 201 });
    }),
  );
  return { queries, saved };
}

const box = () => screen.getByLabelText("Search research papers");

describe("Search", () => {
  it("disables Search until the query is non-blank and sends nothing on load", () => {
    const { queries } = useBackend();
    renderApp(<Search />);
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
    expect(queries).toEqual([]);
  });

  it("searches with the trimmed query and lists results", async () => {
    const { queries } = useBackend({
      results: [makeSearchResult({ title: "First", externalId: "a" }), makeSearchResult({ title: "Second", externalId: "b" })],
    });
    const { user } = renderApp(<Search />);
    await user.type(box(), "  graphs ");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("heading", { name: /First/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Second/ })).toBeInTheDocument();
    expect(queries).toEqual(["graphs"]);
  });

  it("says when nothing was found", async () => {
    useBackend({ results: [] });
    const { user } = renderApp(<Search />);
    await user.type(box(), "zzz{Enter}");
    expect(await screen.findByText("No papers found.")).toBeInTheDocument();
  });

  it("shows the server's error message", async () => {
    server.use(
      http.get("*/api/search", () => HttpResponse.json({ error: "Search is rate limited" }, { status: 429 })),
      http.get("*/api/papers", () => HttpResponse.json([])),
    );
    const { user } = renderApp(<Search />);
    await user.type(box(), "graphs{Enter}");
    expect(await screen.findByText("Search is rate limited")).toHaveClass("error");
  });

  it("saves a result with the full search payload", async () => {
    const result = makeSearchResult({ externalId: "s2-1", title: "Savable" });
    const { saved } = useBackend({ results: [result] });
    const { user } = renderApp(<Search />);
    await user.type(box(), "x{Enter}");
    const card = (await screen.findByRole("heading", { name: /Savable/ })).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { name: /Savable/ });
    expect(saved).toEqual([result]);
  });

  it("marks results already in the library as Saved and disabled", async () => {
    useBackend({
      results: [makeSearchResult({ externalId: "have", title: "Have" }), makeSearchResult({ externalId: "new", title: "New" })],
      library: [makePaper({ source: "search", externalId: "have" }), makePaper({ id: 2, source: "upload" })],
    });
    const { user } = renderApp(<Search />);
    await user.type(box(), "x{Enter}");
    const have = (await screen.findByRole("heading", { name: /Have/ })).closest("article")!;
    expect(await within(have).findByRole("button", { name: "Saved" })).toBeDisabled();
    const added = screen.getByRole("heading", { name: /New/ }).closest("article")!;
    expect(within(added).getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("shows an error when saving fails", async () => {
    useBackend({ results: [makeSearchResult()] });
    server.use(http.post("*/api/papers/from-search", () => HttpResponse.json({ error: "Could not save" }, { status: 500 })));
    const { user } = renderApp(<Search />);
    await user.type(box(), "x{Enter}");
    await user.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByText("Could not save")).toHaveClass("error");
  });
});
