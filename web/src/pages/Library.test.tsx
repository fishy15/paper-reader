import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import type { Paper } from "@paper-reader/shared";
import { makePaper } from "../test/fixtures.js";
import { renderApp } from "../test/render.js";
import { server } from "../test/server.js";
import { Library } from "./Library.js";

function useLibrary(initial: Paper[]) {
  const papers = [...initial];
  server.use(http.get("*/api/papers", () => HttpResponse.json(papers)));
  return papers;
}

describe("Library", () => {
  it("shows a loading state, then an empty-library message", async () => {
    useLibrary([]);
    renderApp(<Library />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(await screen.findByText(/Your library is empty/)).toBeInTheDocument();
  });

  it("lists papers with a link to each and a badge for uploads", async () => {
    useLibrary([
      makePaper({ id: 1, title: "Uploaded One", source: "upload" }),
      makePaper({ id: 2, title: "Searched Two", source: "search", externalId: "e2" }),
    ]);
    renderApp(<Library />);
    const uploaded = (await screen.findByRole("heading", { name: /Uploaded One/ })).closest("article")!;
    expect(within(uploaded).getByText("uploaded")).toBeInTheDocument();
    expect(within(uploaded).getByRole("link", { name: "More Info" })).toHaveAttribute("href", "/papers/1");
    const searched = screen.getByRole("heading", { name: /Searched Two/ }).closest("article")!;
    expect(within(searched).queryByText("uploaded")).not.toBeInTheDocument();
  });

  it("shows an error when the library can't be loaded", async () => {
    server.use(http.get("*/api/papers", () => HttpResponse.json({ error: "Database down" }, { status: 500 })));
    renderApp(<Library />);
    expect(await screen.findByText("Database down")).toHaveClass("error");
  });

  it("deletes a paper after confirmation and refreshes the list", async () => {
    const papers = useLibrary([makePaper({ id: 1, title: "Doomed" })]);
    server.use(
      http.delete("*/api/papers/1", () => {
        papers.length = 0;
        return HttpResponse.json({ ok: true });
      }),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = renderApp(<Library />);
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith('Delete "Doomed"?');
    expect(await screen.findByText(/Your library is empty/)).toBeInTheDocument();
  });

  it("does nothing when the confirmation is declined", async () => {
    useLibrary([makePaper({ title: "Safe" })]);
    let deleted = false;
    server.use(http.delete("*/api/papers/1", () => ((deleted = true), HttpResponse.json({ ok: true }))));
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { user } = renderApp(<Library />);
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(deleted).toBe(false);
    expect(screen.getByRole("heading", { name: /Safe/ })).toBeInTheDocument();
  });

  it("shows an error when deleting fails", async () => {
    useLibrary([makePaper()]);
    server.use(http.delete("*/api/papers/1", () => HttpResponse.json({ error: "Cannot delete" }, { status: 500 })));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = renderApp(<Library />);
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Cannot delete")).toHaveClass("error");
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled());
  });
});
