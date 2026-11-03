import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "../test/server.js";
import { renderApp } from "../test/render.js";
import { UploadBox } from "./UploadBox.js";

const pdf = () => new File(["%PDF-1.4"], "paper.pdf", { type: "application/pdf" });
const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"]')!;

const saved = {
  id: 1, title: "T", authors: [], year: null, abstract: null, url: null,
  pdfUrl: null, hasPdf: true, summary: null, createdAt: "2026-01-01T00:00:00Z", source: "upload",
};

describe("UploadBox", () => {
  it("uploads a chosen file and refreshes the library", async () => {
    let body = "";
    server.use(
      http.post("*/api/papers/upload", async ({ request }) => {
        // Raw multipart text: jsdom's File isn't a real file to undici's FormData, so only the field name is checked.
        body = await request.text();
        return HttpResponse.json(saved, { status: 201 });
      }),
    );
    const { user, queryClient } = renderApp(<UploadBox />);
    queryClient.setQueryData(["papers"], []);
    await user.upload(fileInput(), pdf());
    await waitFor(() => expect(body).toContain('name="file"'));
    await waitFor(() => expect(queryClient.getQueryState(["papers"])?.isInvalidated).toBe(true));
  });

  it("shows progress while uploading", async () => {
    server.use(
      http.post("*/api/papers/upload", async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json(saved, { status: 201 });
      }),
    );
    const { user } = renderApp(<UploadBox />);
    await user.upload(fileInput(), pdf());
    expect(await screen.findByText(/Uploading and extracting metadata/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Uploading/)).not.toBeInTheDocument());
  });

  it("shows the server's error message", async () => {
    server.use(http.post("*/api/papers/upload", () => HttpResponse.json({ error: "Not a PDF" }, { status: 400 })));
    const { user } = renderApp(<UploadBox />);
    await user.upload(fileInput(), pdf());
    expect(await screen.findByText("Not a PDF")).toHaveClass("error");
  });

  it("uploads a dropped file and toggles the dragging style", async () => {
    let called = false;
    server.use(
      http.post("*/api/papers/upload", () => {
        called = true;
        return HttpResponse.json(saved, { status: 201 });
      }),
    );
    renderApp(<UploadBox />);
    const zone = document.querySelector(".dropzone")!;
    fireEvent.dragOver(zone);
    expect(zone).toHaveClass("dragging");
    fireEvent.dragLeave(zone);
    expect(zone).not.toHaveClass("dragging");
    fireEvent.drop(zone, { dataTransfer: { files: [pdf()] } });
    await waitFor(() => expect(called).toBe(true));
  });
});
