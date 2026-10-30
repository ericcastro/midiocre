"use client";

import {
  FileMusic,
  Download,
  LoaderCircle,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { SongListItem } from "../lib/types";

interface SongLibraryDialogProps {
  songs: SongListItem[];
  activeSongId: string | null;
  loading: boolean;
  importing: boolean;
  backendOnline: boolean | null;
  onClose: () => void;
  onOpen: (songId: string) => void;
  onDelete: (song: SongListItem) => void;
  onImport: () => void;
  backupBusy: boolean;
  backupNotice: string | null;
  onBackupExport: () => void;
  onBackupImport: () => void;
}

function relativeDate(value: string | null) {
  if (!value) return "New";
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}

export function SongLibraryDialog({
  songs,
  activeSongId,
  loading,
  importing,
  backendOnline,
  onClose,
  onOpen,
  onDelete,
  onImport,
  backupBusy,
  backupNotice,
  onBackupExport,
  onBackupImport,
}: SongLibraryDialogProps) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-modal library-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="library-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header library-modal-header">
          <div>
            <span className="eyebrow">Local library · {songs.length} pieces</span>
            <h2 id="library-title">Choose what to practice</h2>
          </div>
          <button className="quiet-icon" onClick={onClose} aria-label="Close song library">
            <X size={18} />
          </button>
        </div>

        <div className="library-backup-actions">
          <button className="secondary-action" onClick={onBackupExport} disabled={backupBusy || backendOnline === false}>
            <Download size={15} /> Export library backup
          </button>
          <button className="secondary-action" onClick={onBackupImport} disabled={backupBusy || backendOnline === false}>
            <Upload size={15} /> Restore backup
          </button>
        </div>
        {backupNotice && <p className="library-backup-notice" role="status">{backupNotice}</p>}

        <button
          className="upload-button library-import"
          disabled={importing || backendOnline === false}
          onClick={onImport}
        >
          {importing ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}
          {importing ? "Importing…" : "Import MIDI"}
        </button>

        <div className="library-dialog-list">
          {loading && (
            <div className="sidebar-status">
              <LoaderCircle className="spin" size={16} /> Loading library
            </div>
          )}
          {!loading && songs.length === 0 && (
            <div className="sidebar-empty">
              Your pieces and practice progress will live here.
            </div>
          )}
          {songs.map((song) => (
            <div
              className={`library-song-row ${activeSongId === song.id ? "active" : ""}`}
              key={song.id}
            >
              <button className="library-song-open" onClick={() => onOpen(song.id)}>
                <span className="song-icon"><FileMusic size={18} /></span>
                <span className="song-copy">
                  <strong>{song.title}</strong>
                  <span>
                    {relativeDate(song.last_opened_at)}
                    {song.has_analysis ? " · tutored" : ""}
                  </span>
                  <span className="song-progress">
                    <i style={{ width: `${Math.max(2, song.progress * 100)}%` }} />
                  </span>
                </span>
              </button>
              <button
                className="library-song-delete"
                aria-label={`Remove ${song.title}`}
                onClick={() => onDelete(song)}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>

        <span className={`backend-status ${backendOnline ? "online" : ""}`}>
          <i />
          {backendOnline === null
            ? "Checking local library"
            : backendOnline
              ? "Local library online"
              : "Backend not running"}
        </span>
      </section>
    </div>
  );
}
