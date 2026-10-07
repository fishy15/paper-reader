import { useRef, useState } from "react";
import { useUploadPaper } from "../queries.js";

export function UploadBox() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const upload = useUploadPaper();

  function pick(files: FileList | null) {
    const file = files?.[0];
    if (file) upload.mutate(file);
  }

  return (
    <div
      className={dragging ? "dropzone dragging" : "dropzone"}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        pick(e.dataTransfer.files);
      }}
    >
      {upload.isPending ? (
        <p className="muted">Uploading and extracting metadata…</p>
      ) : (
        <>
          <p className="muted">Drop a PDF here to add it to your library, or</p>
          <button onClick={() => inputRef.current?.click()}>Choose file</button>
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        hidden
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = "";
        }}
      />
      {upload.error && <p className="error">{upload.error.message}</p>}
    </div>
  );
}
