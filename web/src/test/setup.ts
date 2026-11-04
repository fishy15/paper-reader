import { File as NodeFile } from "node:buffer";
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./server.js";

// jsdom replaces FormData and File with its own, which Node's fetch can't send as a file upload (the file
// arrives as the text "[object File]"). Use Node's pair, matching the fetch that actually sends the request.
globalThis.FormData = (await new Response("", { headers: { "content-type": "application/x-www-form-urlencoded" } }).formData())
  .constructor as typeof FormData;
globalThis.File = NodeFile as unknown as typeof File;

// The api client uses relative URLs ("/api/..."), which Node's fetch rejects; resolve them against the page origin.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) =>
  nativeFetch(input instanceof Request ? input : new URL(String(input), window.location.origin), init);

// For each mocked response MSW hands its event listeners a clone (a stream tee). A tee only finishes
// cancelling once both branches are cancelled, so without this, cancelling a partly-read mocked response
// (as the chat does after an `error` event) would never settle.
server.events.on("response:mocked", ({ response }) => void response.body?.cancel());

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });

  // Real fetch errors the body stream when its signal aborts after the response has started; MSW's mocked
  // response does not, so a reader would hang. Wrap MSW's fetch (installed by `listen`, so this has to come
  // after it) and pipe the body through the signal to get the real behavior.
  const mswFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await mswFetch(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (!signal || !response.body) return response;
    return new Response(response.body.pipeThrough(new TransformStream(), { signal }), response);
  };
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());
