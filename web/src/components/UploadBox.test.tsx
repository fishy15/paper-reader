import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "../test/deferred.js";
import { makePaper } from "../test/fixtures.js";
import { server } from "../test/server.js";
import { renderApp } from "../test/render.js";
import { UploadBox } from "./UploadBox.js";

const pdf = () => new File(["%PDF-1.4"], "paper.pdf", { type: "application/pdf" });
const fileInput = () => {
  const found = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!found) throw new Error("No file input rendered");
  return found;
};

const saved = makePaper({ id: 1, title: "T", authors: [], year: null, abstract: null, hasPdf: true });

/** Registers an upload handler that counts requests and records the uploaded filenames. */
function useUpload(respond: () => Response | Promise<Response> = () => HttpResponse.json(saved, { status: 201 })) {
  const uploads: string[] = [];
  server.use(
    http.post("*/api/papers/upload", async ({ request }) => {
      const file = (await request.formData()).get("file");
      if (!(file instanceof File)) throw new Error("No file was uploaded");
      uploads.push(file.name);
      return respond();
    }),
  );
  return uploads;
}

// The drop zone is a plain div with no role or label, so the class is the only way to find it.
const zone = () => {
  const found = document.querySelector(".dropzone");
  if (!found) throw new Error("No drop zone rendered");
  return found;
};
const named = (name: string) => new File(["%PDF-1.4"], name, { type: "application/pdf" });

describe("UploadBox", () => {
  it("starts idle: not dragging, with only the prompt text", () => {
    renderApp(<UploadBox />);
    expect(zone()).not.toHaveClass("dragging");
    expect(zone().querySelectorAll("p")).toHaveLength(1);
  });

  it("shows no notice for a single dropped file", async () => {
    const uploads = useUpload();
    renderApp(<UploadBox />);
    fireEvent.drop(zone(), { dataTransfer: { files: [named("paper.pdf")] } });
    await waitFor(() => expect(uploads).toEqual(["paper.pdf"]));
    expect(screen.queryByText(/Only .* was uploaded/)).not.toBeInTheDocument();
  });

  it("clears the notice on the next single-file upload", async () => {
    const uploads = useUpload();
    renderApp(<UploadBox />);
    fireEvent.drop(zone(), { dataTransfer: { files: [named("a.pdf"), named("b.pdf")] } });
    await screen.findByText(/Only a\.pdf was uploaded/);
    await waitFor(() => expect(screen.queryByText(/Uploading/)).not.toBeInTheDocument());
    fireEvent.drop(zone(), { dataTransfer: { files: [named("c.pdf")] } });
    await waitFor(() => expect(uploads).toEqual(["a.pdf", "c.pdf"]));
    expect(screen.queryByText(/Only .* was uploaded/)).not.toBeInTheDocument();
  });

  it("makes no request at all when no file was chosen", async () => {
    let requests = 0;
    server.use(
      http.post("*/api/papers/upload", () => {
        requests += 1;
        return HttpResponse.json(saved, { status: 201 });
      }),
    );
    renderApp(<UploadBox />);
    fireEvent.change(fileInput(), { target: { files: [] } });
    fireEvent.drop(zone(), { dataTransfer: { files: [] } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests).toBe(0);
    expect(screen.queryByText(/Uploading/)).not.toBeInTheDocument();
  });

  it("uploads a chosen file and refreshes the library", async () => {
    const received: (FormDataEntryValue | null)[] = [];
    server.use(
      http.post("*/api/papers/upload", async ({ request }) => {
        received.push((await request.formData()).get("file"));
        return HttpResponse.json(saved, { status: 201 });
      }),
    );
    const { user, queryClient } = renderApp(<UploadBox />);
    queryClient.setQueryData(["papers"], []);
    await user.upload(fileInput(), pdf());
    await waitFor(() => expect(received[0]).toBeInstanceOf(File));
    expect(fileInput()).toHaveAttribute("accept", "application/pdf");
    expect(fileInput()).toHaveAttribute("hidden");
    const file = received[0];
    if (!(file instanceof File)) throw new Error("No file was uploaded");
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
    // Give a second upload time to start before the first one finishes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    gate.resolve();
    await waitFor(() => expect(screen.queryByText(/Uploading/)).not.toBeInTheDocument());
    expect(uploads).toEqual(["first.pdf"]);
  });
});
