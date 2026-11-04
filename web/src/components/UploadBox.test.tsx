import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { server } from "../test/server.js";
import { renderApp } from "../test/render.js";
import { UploadBox } from "./UploadBox.js";

const pdf = () => new File(["%PDF-1.4"], "paper.pdf", { type: "application/pdf" });
const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"]')!;

const saved = {
  id: 1, title: "T", authors: [], year: null, abstract: null, url: null,
  pdfUrl: null, hasPdf: true, summary: null, createdAt: "2026-01-01T00:00:00Z", source: "upload",
};

/** A promise that is resolved from outside, to hold a mocked upload pending. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Registers an upload handler that counts requests and records the uploaded filenames. */
function useUpload(respond: () => Response | Promise<Response> = () => HttpResponse.json(saved, { status: 201 })) {
  const uploads: string[] = [];
  server.use(
    http.post("*/api/papers/upload", async ({ request }) => {
      uploads.push(((await request.formData()).get("file") as File).name);
      return respond();
    }),
  );
  return uploads;
}

const zone = () => document.querySelector(".dropzone")!;
const named = (name: string) => new File(["%PDF-1.4"], name, { type: "application/pdf" });

describe("UploadBox", () => {
  it("uploads a chosen file and refreshes the library", async () => {
    let uploaded: FormDataEntryValue | null = null;
    server.use(
      http.post("*/api/papers/upload", async ({ request }) => {
        uploaded = (await request.formData()).get("file");
        return HttpResponse.json(saved, { status: 201 });
      }),
    );
    const { user, queryClient } = renderApp(<UploadBox />);
    queryClient.setQueryData(["papers"], []);
    await user.upload(fileInput(), pdf());
    await waitFor(() => expect(uploaded).toBeInstanceOf(File));
    expect(fileInput()).toHaveAttribute("accept", "application/pdf");
    expect(fileInput()).toHaveAttribute("hidden");
    const file = uploaded as unknown as File;
    expect(file.name).toBe("paper.pdf");
    expect(file.type).toBe("application/pdf");
    expect(await file.text()).toBe("%PDF-1.4");
    await waitFor(() => expect(queryClient.getQueryState(["papers"])?.isInvalidated).toBe(true));
  });

  it("shows progress while uploading, hiding the prompt and button until it finishes", async () => {
    const gate = deferred();
    useUpload(async () => {
      await gate.promise;
      return HttpResponse.json(saved, { status: 201 });
    });
    const { user } = renderApp(<UploadBox />);
    await user.upload(fileInput(), pdf());
    expect(await screen.findByText(/Uploading and extracting metadata/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose file" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Drop a PDF here/)).not.toBeInTheDocument();

    gate.resolve();
    await waitFor(() => expect(screen.queryByText(/Uploading/)).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Choose file" })).toBeInTheDocument();
    expect(screen.getByText(/Drop a PDF here/)).toBeInTheDocument();
  });

  it("shows the server's error message", async () => {
    server.use(http.post("*/api/papers/upload", () => HttpResponse.json({ error: "Not a PDF" }, { status: 400 })));
    const { user } = renderApp(<UploadBox />);
    await user.upload(fileInput(), pdf());
    expect(await screen.findByText("Not a PDF")).toHaveClass("error");
  });

  it("uploads a dropped file", async () => {
    const uploads = useUpload();
    renderApp(<UploadBox />);
    fireEvent.drop(zone(), { dataTransfer: { files: [pdf()] } });
    await waitFor(() => expect(uploads).toEqual(["paper.pdf"]));
  });

  it("toggles the dragging style on drag over and drag leave", () => {
    renderApp(<UploadBox />);
    fireEvent.dragOver(zone());
    expect(zone()).toHaveClass("dragging");
    fireEvent.dragLeave(zone());
    expect(zone()).not.toHaveClass("dragging");
  });

  it("clears the dragging style on drop without a drag leave", async () => {
    const gate = deferred();
    useUpload(async () => {
      await gate.promise;
      return HttpResponse.json(saved, { status: 201 });
    });
    renderApp(<UploadBox />);
    fireEvent.dragOver(zone());
    expect(zone()).toHaveClass("dragging");
    fireEvent.drop(zone(), { dataTransfer: { files: [pdf()] } });
    expect(zone()).not.toHaveClass("dragging");
    gate.resolve();
    await waitFor(() => expect(screen.queryByText(/Uploading/)).not.toBeInTheDocument());
  });

  it("prevents the browser default on drag over and drop", async () => {
    const uploads = useUpload();
    renderApp(<UploadBox />);
    // fireEvent returns false when the default action was prevented.
    expect(fireEvent.dragOver(zone())).toBe(false);
    expect(fireEvent.drop(zone(), { dataTransfer: { files: [pdf()] } })).toBe(false);
    await waitFor(() => expect(uploads).toHaveLength(1));
  });

  it.each([
    { name: "an empty change event", act: () => fireEvent.change(fileInput(), { target: { files: [] } }) },
    { name: "a drop with no files", act: () => fireEvent.drop(zone(), { dataTransfer: { files: [] } }) },
  ])("sends nothing for $name", async ({ act }) => {
    const uploads = useUpload();
    const { user } = renderApp(<UploadBox />);
    act();
    // A real upload afterwards is the first request that arrives, so the empty one sent nothing.
    await user.upload(fileInput(), pdf());
    await waitFor(() => expect(uploads).toEqual(["paper.pdf"]));
  });

  it("resets the input so the same file can be picked again", async () => {
    const uploads = useUpload();
    const { user } = renderApp(<UploadBox />);
    await user.upload(fileInput(), pdf());
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(fileInput().value).toBe("");
    await user.upload(fileInput(), pdf());
    await waitFor(() => expect(uploads).toHaveLength(2));
  });

  it("clears an error after a successful retry", async () => {
    let calls = 0;
    useUpload(() => {
      calls += 1;
      return calls === 1 ? HttpResponse.json({ error: "Not a PDF" }, { status: 400 }) : HttpResponse.json(saved, { status: 201 });
    });
    const { user } = renderApp(<UploadBox />);
    await user.upload(fileInput(), pdf());
    expect(await screen.findByText("Not a PDF")).toBeInTheDocument();
    await user.upload(fileInput(), pdf());
    await waitFor(() => expect(screen.queryByText("Not a PDF")).not.toBeInTheDocument());
    expect(calls).toBe(2);
  });

  it("does not refresh the library when the upload fails", async () => {
    useUpload(() => HttpResponse.json({ error: "Not a PDF" }, { status: 400 }));
    const { user, queryClient } = renderApp(<UploadBox />);
    queryClient.setQueryData(["papers"], []);
    await user.upload(fileInput(), pdf());
    expect(await screen.findByText("Not a PDF")).toBeInTheDocument();
    expect(queryClient.getQueryState(["papers"])?.isInvalidated).toBe(false);
  });

  it("opens the file picker when Choose file is clicked", async () => {
    const { user } = renderApp(<UploadBox />);
    const click = vi.spyOn(fileInput(), "click");
    await user.click(screen.getByRole("button", { name: "Choose file" }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("uploads only the first of several dropped files", async () => {
    const uploads = useUpload();
    renderApp(<UploadBox />);
    fireEvent.drop(zone(), { dataTransfer: { files: [named("paper.pdf"), named("other.pdf")] } });
    await waitFor(() => expect(uploads).toEqual(["paper.pdf"]));
  });

  it("tells the user when only the first of several dropped files was uploaded", async () => {
    useUpload();
    renderApp(<UploadBox />);
    fireEvent.drop(zone(), { dataTransfer: { files: [named("paper.pdf"), named("other.pdf")] } });
    expect(await screen.findByText(/Only paper\.pdf was uploaded/)).toBeInTheDocument();
  });

  it("ignores a drop while an upload is pending", async () => {
    const gate = deferred();
    const uploads = useUpload(async () => {
      await gate.promise;
      return HttpResponse.json(saved, { status: 201 });
    });
    renderApp(<UploadBox />);
    fireEvent.drop(zone(), { dataTransfer: { files: [named("first.pdf")] } });
    await screen.findByText(/Uploading/);
    fireEvent.drop(zone(), { dataTransfer: { files: [named("second.pdf")] } });
    gate.resolve();
    await waitFor(() => expect(screen.queryByText(/Uploading/)).not.toBeInTheDocument());
    expect(uploads).toEqual(["first.pdf"]);
  });
});
