import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import { renderApp } from "./test/render.js";
import { server } from "./test/server.js";

describe("App", () => {
  it("redirects / to the search page", () => {
    server.use(http.get("*/api/papers", () => HttpResponse.json([])));
    renderApp(<App />);
    expect(screen.getByLabelText("Search research papers")).toBeInTheDocument();
  });

  it("navigates between Search and Library", async () => {
    server.use(http.get("*/api/papers", () => HttpResponse.json([])));
    const { user } = renderApp(<App />);
    await user.click(screen.getByRole("link", { name: "Library" }));
    expect(await screen.findByText(/Your library is empty/)).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Search" }));
    expect(screen.getByLabelText("Search research papers")).toBeInTheDocument();
  });

  it("renders the paper page at /papers/:id", async () => {
    renderApp(<App />, { route: "/papers/abc" });
    expect(screen.getByText("Invalid paper id.")).toBeInTheDocument();
  });
});
