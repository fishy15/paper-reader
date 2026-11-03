import { setupServer } from "msw/node";

/** Intercepts `fetch` for component tests; each test registers the handlers it needs with `server.use`. */
export const server = setupServer();
