import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { Paper, SearchResult } from "@paper-reader/shared";
import { makePaper, makeSearchResult } from "../test/fixtures.js";
import { renderApp } from "../test/render.js";
import { server } from "../test/server.js";
import { Search } from "./Search.js";

function serveBackend({ results = [], library = [] }: { results?: SearchResult[]; library?: Paper[] } = {}) {
  const queries: (string | null)[] = [];
  const saved: unknown[] = [];
  const requests = { library: 0 };
  server.use(
    http.get("*/api/search", ({ request }) => {
      queries.push(new URL(request.url).searchParams.get("query"));
      return HttpResponse.json(results);
    }),
    http.get("*/api/papers", () => {
      requests.library++;
      return HttpResponse.json(library);
    }),
    http.post("*/api/papers/from-search", async ({ request }) => {
      saved.push(await request.json());
      return HttpResponse.json(makePaper({ source: "search", externalId: "s2-1" }), { status: 201 });
    }),
  );
  return { queries, saved, library, requests };
}

const searchError = (message: string) => HttpResponse.json({ error: message }, { status: 429 });
const serverError = (message: string) => HttpResponse.json({ error: message }, { status: 500 });
function cardOf(title: RegExp): HTMLElement {
  const article = screen.getByRole("heading", { name: title }).closest("article");
  if (!article) throw new Error(`No <article> card found for heading ${title}`);
  return article;
}

const box = () => screen.getByLabelText("Search research papers");

describe("Search", () => {
  it("disables Search until the query is non-blank and sends nothing on load", () => {
    const { queries } = serveBackend();
    renderApp(<Search />);
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
    expect(queries).toEqual([]);
  });

  it("searches with the trimmed query and lists results", async () => {
    const { queries } = serveBackend({
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
    serveBackend({ results: [] });
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
    const { saved } = serveBackend({ results: [result] });
    const { user } = renderApp(<Search />);
    await user.type(box(), "x{Enter}");
    const card = (await screen.findByRole("heading", { name: /Savable/ })).closest("article")!;
    await user.click(within(card).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved).toEqual([result]);
  });

  it("marks results already in the library as Saved and disabled", async () => {
    serveBackend({
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
    serveBackend({ results: [makeSearchResult()] });
    server.use(http.post("*/api/papers/from-search", () => HttpResponse.json({ error: "Could not save" }, { status: 500 })));
    const { user } = renderApp(<Search />);
    await user.type(box(), "x{Enter}");
    await user.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByText("Could not save")).toHaveClass("error");
  });

  it("turns the button into a disabled Saved once the library has the paper", async () => {
    const result = makeSearchResult({ externalId: "s2-9", title: "Savable" });
    const { library, requests } = serveBackend({ results: [result] });
    server.use(
      http.post("*/api/papers/from-search", () => {
        const paper = makePaper({ id: 3, source: "search", externalId: "s2-9" });
        library.push(paper);
        return HttpResponse.json(paper, { status: 201 });
      }),
    );
    const { user } = renderApp(<Search />);
    await user.type(box(), "x{Enter}");
    await screen.findByRole("heading", { name: /Savable/ });
    await waitFor(() => expect(requests.library).toBe(1));
    await user.click(within(cardOf(/Savable/)).getByRole("button", { name: "Save" }));
    expect(await within(cardOf(/Savable/)).findByRole("button", { name: "Saved" })).toBeDisabled();
    expect(requests.library).toBe(2);
  });

  it("disables only the Save button of the paper being saved", async () => {
    serveBackend({
      results: [makeSearchResult({ externalId: "a", title: "Alpha" }), makeSearchResult({ externalId: "b", title: "Beta" })],
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post("*/api/papers/from-search", async () => {
        await gate;
        return HttpResponse.json(makePaper({ source: "search", externalId: "a" }), { status: 201 });
      }),
    );
    const { user } = renderApp(<Search />);
    await user.type(box(), "x{Enter}");
    await screen.findByRole("heading", { name: /Alpha/ });
    await user.click(within(cardOf(/Alpha/)).getByRole("button", { name: "Save" }));
    try {
      await waitFor(() => expect(within(cardOf(/Alpha/)).getByRole("button", { name: "Save" })).toBeDisabled());
      expect(within(cardOf(/Beta/)).getByRole("button", { name: "Save" })).toBeEnabled();
    } finally {
      release();
    }
    await waitFor(() => expect(within(cardOf(/Alpha/)).getByRole("button", { name: "Save" })).toBeEnabled());
  });

  it("shows Searching… while the search is in flight", async () => {
    server.use(
      http.get("*/api/search", async () => {
        await delay(100);
        return HttpResponse.json([makeSearchResult({ title: "Late" })]);
      }),
      http.get("*/api/papers", () => HttpResponse.json([])),
    );
    const { user } = renderApp(<Search />);
    await user.type(box(), "x{Enter}");
    expect(await screen.findByText("Searching…")).toHaveClass("muted");
    expect(await screen.findByRole("heading", { name: /Late/ })).toBeInTheDocument();
    expect(screen.queryByText("Searching…")).not.toBeInTheDocument();
  });

  it("ignores a blank query submitted directly", async () => {
    const { queries } = serveBackend({ results: [makeSearchResult({ title: "Real" })] });
    const { user } = renderApp(<Search />);
    fireEvent.submit(box());
    fireEvent.change(box(), { target: { value: "   " } });
    fireEvent.submit(box());
    expect(screen.queryByText("Searching…")).not.toBeInTheDocument();

    // A real search afterwards is the first request that arrives, so the blank ones sent nothing.
    await user.clear(box());
    await user.type(box(), "real{Enter}");
    expect(await screen.findByRole("heading", { name: /Real/ })).toBeInTheDocument();
    expect(queries).toEqual(["real"]);
  });

  it("replaces the old error and results with a new search", async () => {
    let failing = true;
    server.use(
      http.get("*/api/search", ({ request }) => {
        if (new URL(request.url).searchParams.get("query") === "bad") return searchError("Search is rate limited");
        failing = false;
        return HttpResponse.json([makeSearchResult({ title: "Fresh" })]);
      }),
      http.get("*/api/papers", () => HttpResponse.json([])),
    );
    const { user } = renderApp(<Search />);
    await user.type(box(), "bad{Enter}");
    await screen.findByText("Search is rate limited");
    await user.clear(box());
    await user.type(box(), "good{Enter}");
    expect(await screen.findByRole("heading", { name: /Fresh/ })).toBeInTheDocument();
    expect(failing).toBe(false);
    expect(screen.queryByText("Search is rate limited")).not.toBeInTheDocument();
  });

  it("still shows results with enabled Save buttons when the library fails to load", async () => {
    server.use(
      http.get("*/api/search", () => HttpResponse.json([makeSearchResult({ title: "Found" })])),
      http.get("*/api/papers", () => serverError("Library down")),
    );
    const { user, queryClient } = renderApp(<Search />);
    await user.type(box(), "x{Enter}");
    expect(await screen.findByRole("heading", { name: /Found/ })).toBeInTheDocument();
    // Check only once the library request has failed, so a late error would still be seen.
    await waitFor(() => expect(queryClient.getQueryState(["papers"])?.status).toBe("error"));
    expect(within(cardOf(/Found/)).getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.queryByText("Library down")).not.toBeInTheDocument();
    // Error paragraphs have no role, so a class query is the only option.
    expect(document.querySelector(".error")).toBeNull();
  });

  it("clears a save error after a later successful save", async () => {
    serveBackend({ results: [makeSearchResult({ title: "Retry me" })] });
    let attempts = 0;
    server.use(
      http.post("*/api/papers/from-search", () => {
        if (++attempts === 1) return serverError("Could not save");
        return HttpResponse.json(makePaper({ source: "search", externalId: "s2-1" }), { status: 201 });
      }),
    );
    const { user } = renderApp(<Search />);
    await user.type(box(), "x{Enter}");
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await screen.findByText("Could not save");
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByText("Could not save")).not.toBeInTheDocument());
    expect(attempts).toBe(2);
  });

  it("searches again when the same query is submitted after an error", async () => {
    let calls = 0;
    server.use(
      http.get("*/api/search", () => {
        if (++calls === 1) return searchError("Search is rate limited");
        return HttpResponse.json([makeSearchResult({ title: "Second try" })]);
      }),
      http.get("*/api/papers", () => HttpResponse.json([])),
    );
    const { user } = renderApp(<Search />);
    await user.type(box(), "graphs{Enter}");
    await screen.findByText("Search is rate limited");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("heading", { name: /Second try/ })).toBeInTheDocument();
    expect(calls).toBe(2);
    expect(screen.queryByText("Search is rate limited")).not.toBeInTheDocument();
  });

  it("clears a save error when a new search is submitted", async () => {
    serveBackend({ results: [makeSearchResult({ title: "Savable" })] });
    server.use(http.post("*/api/papers/from-search", () => serverError("Could not save")));
    const { user } = renderApp(<Search />);
    await user.type(box(), "one{Enter}");
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await screen.findByText("Could not save");
    await user.clear(box());
    await user.type(box(), "two{Enter}");
    await screen.findByRole("heading", { name: /Savable/ });
    expect(screen.queryByText("Could not save")).not.toBeInTheDocument();
  });
});
