"use client";

import { useMemo, useRef, useState } from "react";
import { Check, FileMusic, LoaderCircle, X } from "lucide-react";
import { inspectMidi } from "../lib/api";
import type { InstrumentGroup, SongMetadata, TrackAssignment } from "../lib/types";

interface ImportSongDialogProps {
  busy: boolean;
  onClose: () => void;
  onSubmit: (
    file: File,
    title: string,
    contextText: string,
    trackAssignments: Record<string, TrackAssignment>,
  ) => void;
}

export function ImportSongDialog({ busy, onClose, onSubmit }: ImportSongDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [contextText, setContextText] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<SongMetadata | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [selectedInstrumentIds, setSelectedInstrumentIds] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const inspectionIdRef = useRef(0);

  const instrumentGroups = useMemo<InstrumentGroup[]>(() => {
    if (!metadata) return [];
    const groups = new Map<string, InstrumentGroup>();
    metadata.tracks.forEach((track) => {
      const id = track.instrument_id || `track-${track.index}`;
      const existing = groups.get(id);
      if (existing) {
        existing.tracks.push(track);
        existing.defaultSelected ||= track.default_selected;
      } else {
        groups.set(id, {
          id,
          name: track.instrument_name || track.name,
          isPiano: track.is_piano,
          defaultSelected: track.default_selected,
          tracks: [track],
        });
      }
    });
    return [...groups.values()];
  }, [metadata]);

  const chooseFile = async (next: File | undefined) => {
    if (!next) return;
    const inspectionId = inspectionIdRef.current + 1;
    inspectionIdRef.current = inspectionId;
    if (!/\.midi?$/i.test(next.name)) {
      setFileError("Choose a .mid or .midi file.");
      setFile(null);
      setMetadata(null);
      setInspecting(false);
      return;
    }
    setFileError(null);
    setFile(next);
    setMetadata(null);
    setSelectedInstrumentIds(new Set());
    setTitle((current) => current || next.name.replace(/\.midi?$/i, "").replace(/[_-]+/g, " "));
    setInspecting(true);
    try {
      const inspected = await inspectMidi(next);
      if (inspectionId !== inspectionIdRef.current) return;
      setMetadata(inspected);
      setSelectedInstrumentIds(
        new Set(
          inspected.tracks
            .filter((track) => track.default_selected)
            .map((track) => track.instrument_id || `track-${track.index}`),
        ),
      );
    } catch (error) {
      if (inspectionId !== inspectionIdRef.current) return;
      setFileError(error instanceof Error ? error.message : "Could not inspect this MIDI.");
    } finally {
      if (inspectionId === inspectionIdRef.current) setInspecting(false);
    }
  };

  const trackAssignments = useMemo(() => {
    const assignments: Record<string, TrackAssignment> = {};
    metadata?.tracks.forEach((track) => {
      const instrumentId = track.instrument_id || `track-${track.index}`;
      assignments[String(track.index)] = selectedInstrumentIds.has(instrumentId)
        ? track.suggested_assignment
        : "ignore";
    });
    return assignments;
  }, [metadata, selectedInstrumentIds]);

  const hasSelection = Object.values(trackAssignments).some((value) => value !== "ignore");

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
            void chooseFile(event.dataTransfer.files?.[0]);
          }}
        >
          <input
            ref={inputRef}
            hidden
            type="file"
            accept=".mid,.midi,audio/midi,audio/x-midi"
            onChange={(event) => void chooseFile(event.target.files?.[0])}
          />
          <FileMusic size={22} />
          <strong>{file ? file.name : "Drop a MIDI here"}</strong>
          <span>{file ? "Choose another file" : "or browse from this computer"}</span>
          <button type="button" className="text-button" onClick={() => inputRef.current?.click()}>
            {file ? "Choose another MIDI" : "Choose MIDI"}
          </button>
        </div>
        {fileError && <div className="analysis-error">{fileError}</div>}

        {inspecting && (
          <div className="midi-inspecting" role="status">
            <LoaderCircle className="spin" size={16} /> Reading instruments and staves…
          </div>
        )}

        {metadata && instrumentGroups.length === 1 && (
          <div className="midi-part-summary">
            <Check size={16} />
            <span>
              <strong>{instrumentGroups[0].name} detected</strong>
              {instrumentGroups[0].isPiano && instrumentGroups[0].tracks.length > 1
                ? "Right and left hand staves will stay separate."
                : `${metadata.note_count} notes ready to import.`}
            </span>
          </div>
        )}

        {metadata && instrumentGroups.length > 1 && (
          <fieldset className="midi-part-picker">
            <legend>Which parts do you want to practise?</legend>
            <p>This MIDI contains several instruments. Piano is selected by default.</p>
            {instrumentGroups.map((group) => {
              const selected = selectedInstrumentIds.has(group.id);
              const noteCount = group.tracks.reduce((total, track) => total + track.note_count, 0);
              return (
                <label key={group.id} className={selected ? "selected" : ""}>
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => {
                      setSelectedInstrumentIds((current) => {
                        const next = new Set(current);
                        if (next.has(group.id)) next.delete(group.id);
                        else next.add(group.id);
                        return next;
                      });
                    }}
                  />
                  <span>
                    <strong>{group.name}</strong>
                    <small>
                      {group.tracks.length} {group.tracks.length === 1 ? "track" : "staves"} · {noteCount} notes
                      {group.isPiano && group.tracks.length > 1 ? " · left/right preserved" : ""}
                    </small>
                  </span>
                </label>
              );
            })}
            {!hasSelection && <small className="selection-error">Choose at least one part.</small>}
          </fieldset>
        )}

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
            onClick={() => file && onSubmit(file, title.trim(), contextText.trim(), trackAssignments)}
            disabled={!file || !metadata || !hasSelection || !title.trim() || busy || inspecting}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <FileMusic size={16} />}
            {busy ? "Importing…" : "Import and open"}
          </button>
        </div>
      </section>
    </div>
  );
}
