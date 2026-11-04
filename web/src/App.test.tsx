import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { NavigationType, useLocation, useNavigationType } from "react-router";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import { makePaper } from "./test/fixtures.js";
import { renderApp } from "./test/render.js";
import { server } from "./test/server.js";

/** Shows the current path and how it was reached, so a test can check redirects. */
function LocationProbe() {
  const { pathname } = useLocation();
  return <output data-testid="location">{`${pathname} ${useNavigationType()}`}</output>;
}

describe("App", () => {
  it("redirects / to the search page, replacing the history entry", () => {
    server.use(http.get("*/api/papers", () => HttpResponse.json([])));
    renderApp(
      <>
        <App />
        <LocationProbe />
      </>,
    );
    expect(screen.getByLabelText("Search research papers")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(`/search ${NavigationType.Replace}`);
  });

  it("navigates between Search and Library and marks the active link", async () => {
    server.use(http.get("*/api/papers", () => HttpResponse.json([])));
    const { user } = renderApp(<App />);
    const search = screen.getByRole("link", { name: "Search" });
    const library = screen.getByRole("link", { name: "Library" });
    expect(search).toHaveAttribute("aria-current", "page");
    expect(library).not.toHaveAttribute("aria-current");

    await user.click(library);
    expect(await screen.findByText(/Your library is empty/)).toBeInTheDocument();
    expect(library).toHaveAttribute("aria-current", "page");
    expect(search).not.toHaveAttribute("aria-current");

    await user.click(search);
    expect(screen.getByLabelText("Search research papers")).toBeInTheDocument();
    expect(search).toHaveAttribute("aria-current", "page");
    expect(library).not.toHaveAttribute("aria-current");
  });

  it("shows an error for an invalid paper id", () => {
    renderApp(<App />, { route: "/papers/abc" });
    expect(screen.getByText("Invalid paper id.")).toBeInTheDocument();
  });

  it("renders the paper page for a valid id", async () => {
    server.use(
      http.get("*/api/papers/5", () => HttpResponse.json(makePaper({ id: 5, title: "Five" }))),
      http.get("*/api/papers/5/messages", () => HttpResponse.json([])),
    );
    renderApp(<App />, { route: "/papers/5" });
    expect(await screen.findByRole("heading", { name: /Five/ })).toBeInTheDocument();
  });

  it("goes from the library to a paper and back", async () => {
    const paper = makePaper({ id: 5, title: "Five", source: "search" });
    server.use(
      http.get("*/api/papers", () => HttpResponse.json([paper])),
      http.get("*/api/papers/5", () => HttpResponse.json(paper)),
      http.get("*/api/papers/5/messages", () => HttpResponse.json([])),
    );
    const { user } = renderApp(<App />, { route: "/library" });
    await user.click(await screen.findByRole("link", { name: "More Info" }));
    expect(await screen.findByRole("heading", { name: /Five/ })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "← Library" }));
    expect(await screen.findByRole("link", { name: "More Info" })).toBeInTheDocument();
  });

  it.each(["/nope", "/papers", "/papers/1/extra"])("shows a not-found page for %s", (route) => {
    renderApp(<App />, { route });
    expect(screen.getByRole("heading", { name: "Paper Reader" })).toBeInTheDocument();
    expect(screen.getByText("Page not found")).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Search" })).toBeInTheDocument();
  });
});
