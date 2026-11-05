import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { makePaper, makeSearchResult } from "./test/fixtures.js";
import { server } from "./test/server.js";
import { useDeletePaper, useSavePaper, useUploadPaper } from "./queries.js";

function setup<T>(useHook: () => T) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  // Seed one list that the mutations should refresh and one that they should leave alone.
  queryClient.setQueryData(["papers"], []);
  queryClient.setQueryData(["search", "graphs"], []);
  return { queryClient, ...renderHook(useHook, { wrapper }) };
}

const isInvalidated = (queryClient: QueryClient, key: unknown[]) => queryClient.getQueryState(key)?.isInvalidated;
const file = new File(["%PDF-1.4"], "paper.pdf", { type: "application/pdf" });

describe("library mutations", () => {
  it("saving a search result refreshes the library and nothing else", async () => {
    server.use(http.post("*/api/papers/from-search", () => HttpResponse.json(makePaper(), { status: 201 })));
    const { result, queryClient } = setup(useSavePaper);
    result.current.mutate(makeSearchResult());
    await waitFor(() => expect(isInvalidated(queryClient, ["papers"])).toBe(true));
    expect(isInvalidated(queryClient, ["search", "graphs"])).toBe(false);
  });

  it("uploading a paper refreshes the library and nothing else", async () => {
    server.use(http.post("*/api/papers/upload", () => HttpResponse.json(makePaper(), { status: 201 })));
    const { result, queryClient } = setup(useUploadPaper);
    result.current.mutate(file);
    await waitFor(() => expect(isInvalidated(queryClient, ["papers"])).toBe(true));
    expect(isInvalidated(queryClient, ["search", "graphs"])).toBe(false);
  });

  it("deleting a paper refreshes the library and nothing else", async () => {
    server.use(http.delete("*/api/papers/1", () => new HttpResponse(null, { status: 204 })));
    const { result, queryClient } = setup(useDeletePaper);
    result.current.mutate(1);
    await waitFor(() => expect(isInvalidated(queryClient, ["papers"])).toBe(true));
    expect(isInvalidated(queryClient, ["search", "graphs"])).toBe(false);
  });
});
