"use client";

import { useRef, useState } from "react";
import { FileMusic, LoaderCircle, X } from "lucide-react";

interface ImportSongDialogProps {
  busy: boolean;
  onClose: () => void;
  onSubmit: (file: File, title: string, contextText: string) => void;
}

export function ImportSongDialog({ busy, onClose, onSubmit }: ImportSongDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [contextText, setContextText] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const chooseFile = (next: File | undefined) => {
    if (!next) return;
    if (!/\.midi?$/i.test(next.name)) {
      setFileError("Choose a .mid or .midi file.");
      return;
    }
    setFileError(null);
    setFile(next);
    setTitle((current) => current || next.name.replace(/\.midi?$/i, "").replace(/[_-]+/g, " "));
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-modal import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">New piece</span>
            <h2 id="import-title">Bring a MIDI into your library</h2>
          </div>
          <button className="quiet-icon" onClick={onClose} aria-label="Close import dialog">
            <X size={18} />
          </button>
        </div>

        <div
          className={`midi-dropzone ${file ? "has-file" : ""}`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            chooseFile(event.dataTransfer.files?.[0]);
          }}
        >
          <input
            ref={inputRef}
            hidden
            type="file"
            accept=".mid,.midi,audio/midi,audio/x-midi"
            onChange={(event) => chooseFile(event.target.files?.[0])}
          />
          <FileMusic size={22} />
          <strong>{file ? file.name : "Drop a MIDI here"}</strong>
          <span>{file ? "Choose another file" : "or browse from this computer"}</span>
          <button type="button" className="text-button" onClick={() => inputRef.current?.click()}>
            {file ? "Choose another MIDI" : "Choose MIDI"}
          </button>
        </div>
        {fileError && <div className="analysis-error">{fileError}</div>}

        <label className="field">
          <span>Piece title</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} />
        </label>

        <label className="field">
          <span>Piece context for your tutor</span>
          <textarea
            value={contextText}
            onChange={(event) => setContextText(event.target.value)}
            maxLength={4000}
            rows={6}
            placeholder="Composer, genre, what you hear, what feels difficult, which performance or arrangement this follows, and anything else the tutor should know."
          />
          <small>{contextText.length}/4000 · This is optional, but useful for style and phrasing guidance.</small>
        </label>

        <div className="modal-actions">
          <button className="secondary-action" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="primary-action"
            onClick={() => file && onSubmit(file, title.trim(), contextText.trim())}
            disabled={!file || !title.trim() || busy}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <FileMusic size={16} />}
            {busy ? "Importing…" : "Import and open"}
          </button>
        </div>
      </section>
    </div>
  );
}
