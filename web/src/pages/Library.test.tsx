import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import type { Paper } from "@paper-reader/shared";
import { makeMessage, makePaper } from "../test/fixtures.js";
import { renderApp } from "../test/render.js";
import { server } from "../test/server.js";
import { Library } from "./Library.js";

/** Serves the library and counts the `GET /api/papers` requests it receives. */
function serveLibrary(initial: Paper[]) {
  const papers = [...initial];
  const requests = { list: 0 };
  server.use(
    http.get("*/api/papers", () => {
      requests.list++;
      return HttpResponse.json(papers);
    }),
  );
  return Object.assign(papers, { requests });
}

function card(title: RegExp): HTMLElement {
  const article = screen.getByRole("heading", { name: title }).closest("article");
  if (!article) throw new Error(`No <article> card found for heading ${title}`);
  return article;
}

describe("Library", () => {
  it("shows a loading state, then an empty-library message", async () => {
    serveLibrary([]);
    renderApp(<Library />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(await screen.findByText(/Your library is empty/)).toBeInTheDocument();
  });

  it("lists papers with a link to each and a badge for uploads", async () => {
    serveLibrary([
      makePaper({ id: 4, title: "Uploaded One", source: "upload" }),
      makePaper({ id: 9, title: "Searched Two", source: "search", externalId: "e2" }),
    ]);
    renderApp(<Library />);
    await screen.findByRole("heading", { name: /Uploaded One/ });
    const uploaded = card(/Uploaded One/);
    expect(within(uploaded).getByText("uploaded")).toBeInTheDocument();
    expect(within(uploaded).getByRole("link", { name: "More Info" })).toHaveAttribute("href", "/papers/4");
    const searched = card(/Searched Two/);
    expect(within(searched).queryByText("uploaded")).not.toBeInTheDocument();
    expect(within(searched).getByRole("link", { name: "More Info" })).toHaveAttribute("href", "/papers/9");
  });

  it("shows an error when the library can't be loaded", async () => {
    server.use(http.get("*/api/papers", () => HttpResponse.json({ error: "Database down" }, { status: 500 })));
    renderApp(<Library />);
    // The `error` class is the only hook: the paragraph has no role.
    expect(await screen.findByText("Database down")).toHaveClass("error");
  });

  it("shows neither the empty message nor the loading text when loading fails", async () => {
    server.use(http.get("*/api/papers", () => HttpResponse.json({ error: "Database down" }, { status: 500 })));
    renderApp(<Library />);
    await screen.findByText("Database down");
    expect(screen.queryByText(/Your library is empty/)).not.toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("shows the upload control while loading, when empty, and after a load error", async () => {
    serveLibrary([]);
    const first = renderApp(<Library />);
    expect(screen.getByRole("button", { name: "Choose file" })).toBeInTheDocument();
    await screen.findByText(/Your library is empty/);
    expect(screen.getByRole("button", { name: "Choose file" })).toBeInTheDocument();
    first.unmount();

    server.use(http.get("*/api/papers", () => HttpResponse.json({ error: "Database down" }, { status: 500 })));
    renderApp(<Library />);
    await screen.findByText("Database down");
    expect(screen.getByRole("button", { name: "Choose file" })).toBeInTheDocument();
  });

  it("deletes a paper after confirmation and refreshes the list", async () => {
    const papers = serveLibrary([makePaper({ id: 7, title: "Doomed" })]);
    server.use(
      http.delete("*/api/papers/7", () => {
        papers.length = 0;
        return HttpResponse.json({ ok: true });
      }),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = renderApp(<Library />);
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith('Delete "Doomed"?');
    expect(await screen.findByText(/Your library is empty/)).toBeInTheDocument();
    // The list is refetched, not just the mock mutated.
    expect(papers.requests.list).toBe(2);
  });

  it("deletes only the chosen paper", async () => {
    const papers = serveLibrary([makePaper({ id: 7, title: "Keeper" }), makePaper({ id: 12, title: "Goner" })]);
    const deleted: string[] = [];
    server.use(
      http.delete("*/api/papers/:id", ({ params }) => {
        deleted.push(String(params.id));
        papers.splice(1, 1);
        return HttpResponse.json({ ok: true });
      }),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = renderApp(<Library />);
    await screen.findByRole("heading", { name: /Goner/ });
    await user.click(within(card(/Goner/)).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: /Goner/ })).not.toBeInTheDocument());
    expect(confirm).toHaveBeenCalledWith('Delete "Goner"?');
    expect(deleted).toEqual(["12"]);
    expect(screen.getByRole("heading", { name: /Keeper/ })).toBeInTheDocument();
  });

  it("disables every Delete button while a delete is pending", async () => {
    const papers = serveLibrary([makePaper({ id: 7, title: "One" }), makePaper({ id: 12, title: "Two" })]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.delete("*/api/papers/12", async () => {
        await gate;
        papers.splice(1, 1);
        return HttpResponse.json({ ok: true });
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = renderApp(<Library />);
    await screen.findByRole("heading", { name: /Two/ });
    await user.click(within(card(/Two/)).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      const buttons = screen.getAllByRole("button", { name: "Delete" });
      expect(buttons).toHaveLength(2);
      for (const b of buttons) expect(b).toBeDisabled();
    });
    release();
    await waitFor(() => expect(screen.queryByRole("heading", { name: /Two/ })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("drops the deleted paper's cached detail and messages", async () => {
    const papers = serveLibrary([makePaper({ id: 7, title: "Doomed" }), makePaper({ id: 12, title: "Other" })]);
    server.use(
      http.delete("*/api/papers/7", () => {
        papers.splice(0, 1);
        return HttpResponse.json({ ok: true });
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user, queryClient } = renderApp(<Library />);
    queryClient.setQueryData(["papers", 7], makePaper({ id: 7 }));
    queryClient.setQueryData(["messages", 7], [makeMessage({ paperId: 7 })]);
    queryClient.setQueryData(["papers", 12], makePaper({ id: 12 }));
    queryClient.setQueryData(["messages", 12], [makeMessage({ paperId: 12 })]);
    await screen.findByRole("heading", { name: /Doomed/ });
    await user.click(within(card(/Doomed/)).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: /Doomed/ })).not.toBeInTheDocument());
    expect(queryClient.getQueryData(["papers", 7])).toBeUndefined();
    expect(queryClient.getQueryData(["messages", 7])).toBeUndefined();
    // Other papers' caches are untouched.
    expect(queryClient.getQueryData(["papers", 12])).toBeDefined();
    expect(queryClient.getQueryData(["messages", 12])).toBeDefined();
  });

  it("does nothing when the confirmation is declined", async () => {
    const papers = serveLibrary([makePaper({ id: 5, title: "Safe" })]);
    let deleted = false;
    server.use(http.delete("*/api/papers/5", () => ((deleted = true), HttpResponse.json({ ok: true }))));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { user } = renderApp(<Library />);
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith('Delete "Safe"?');
    expect(deleted).toBe(false);
    expect(papers.requests.list).toBe(1);
    expect(screen.getByRole("heading", { name: /Safe/ })).toBeInTheDocument();
  });

  it("shows an error when deleting fails and keeps the paper", async () => {
    serveLibrary([makePaper({ id: 5, title: "Stays" })]);
    server.use(http.delete("*/api/papers/5", () => HttpResponse.json({ error: "Cannot delete" }, { status: 500 })));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = renderApp(<Library />);
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    // The `error` class is the only hook: the paragraph has no role.
    expect(await screen.findByText("Cannot delete")).toHaveClass("error");
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled());
    expect(screen.getByRole("heading", { name: /Stays/ })).toBeInTheDocument();
  });

  it("clears the delete error after a later successful delete", async () => {
    const papers = serveLibrary([makePaper({ id: 5, title: "Stubborn" })]);
    let attempts = 0;
    server.use(
      http.delete("*/api/papers/5", () => {
        if (++attempts === 1) return HttpResponse.json({ error: "Cannot delete" }, { status: 500 });
        papers.length = 0;
        return HttpResponse.json({ ok: true });
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = renderApp(<Library />);
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await screen.findByText("Cannot delete");
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(/Your library is empty/)).toBeInTheDocument();
    expect(screen.queryByText("Cannot delete")).not.toBeInTheDocument();
  });
});
