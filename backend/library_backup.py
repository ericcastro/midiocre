"""Portable, versioned library backup independent of SQLite and local paths."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import uuid
from pathlib import Path
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field, field_validator

from . import db as storage
from .db import connect, dumps, loads
from .midi_analysis import parse_midi
from .schemas import LegacyPieceAnalysis, PieceAnalysis, SongState, utc_now_iso

BACKUP_FORMAT = "midiocre-library"
BACKUP_VERSION = 1
MAX_BACKUP_BYTES = 100 * 1024 * 1024
MAX_MIDI_BYTES = 20 * 1024 * 1024


class BackupAnalysis(BaseModel):
    id: str = Field(pattern=r"^[a-f0-9]{32}$")
    schema_version: Literal["1.0", "1.1"]
    provider: str
    model: str
    input_fingerprint: str
    analysis: dict
    created_at: str
    updated_at: str

    @field_validator("analysis")
    @classmethod
    def validate_analysis(cls, value: dict) -> dict:
        try:
            if value.get("schema_version") == "1.1":
                PieceAnalysis.model_validate(value)
            else:
                LegacyPieceAnalysis.model_validate(value)
        except ValueError as exc:
            raise ValueError("Invalid saved analysis") from exc
        return value


class BackupSong(BaseModel):
    id: str = Field(pattern=r"^[a-f0-9]{32}$")
    title: str = Field(min_length=1, max_length=160)
    filename: str = Field(min_length=1, max_length=255)
    context_text: str = Field(default="", max_length=4000)
    created_at: str
    updated_at: str
    state: SongState
    midi_base64: str
    midi_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    analyses: list[BackupAnalysis] = Field(default_factory=list)

    @field_validator("filename")
    @classmethod
    def validate_filename(cls, value: str) -> str:
        if (Path(value).name != value or "\\" in value
                or Path(value).suffix.lower() not in {".mid", ".midi"}):
            raise ValueError("Backup filename must be a MIDI basename")
        return value

    def midi_bytes(self) -> bytes:
        try:
            data = base64.b64decode(self.midi_base64, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("Invalid MIDI encoding") from exc
        if not data or len(data) > MAX_MIDI_BYTES:
            raise ValueError("MIDI file is empty or exceeds 20 MB")
        if hashlib.sha256(data).hexdigest() != self.midi_sha256:
            raise ValueError("MIDI checksum does not match")
        return data


class LibraryBackup(BaseModel):
    format: Literal["midiocre-library"]
    version: Literal[1]
    exported_at: str
    songs: list[BackupSong]


def export_library() -> dict:
    songs = []
    with connect() as db:
        rows = db.execute(
            """SELECT s.*, st.state_json FROM songs s
               JOIN song_state st ON st.song_id = s.id
               ORDER BY s.updated_at DESC"""
        ).fetchall()
        for row in rows:
            data = Path(row["midi_path"]).read_bytes()
            analyses = db.execute(
                "SELECT * FROM analyses WHERE song_id = ? ORDER BY updated_at",
                (row["id"],),
            ).fetchall()
            songs.append({
                "id": row["id"],
                "title": row["title"],
                "filename": row["filename"],
                "context_text": row["context_text"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
                "state": loads(row["state_json"]),
                "midi_base64": base64.b64encode(data).decode("ascii"),
                "midi_sha256": hashlib.sha256(data).hexdigest(),
                "analyses": [
                    {
                        "id": item["id"],
                        "schema_version": item["schema_version"],
                        "provider": item["provider"],
                        "model": item["model"],
                        "input_fingerprint": item["input_fingerprint"],
                        "analysis": loads(item["analysis_json"]),
                        "created_at": item["created_at"],
                        "updated_at": item["updated_at"],
                    }
                    for item in analyses
                ],
            })
    return {"format": BACKUP_FORMAT, "version": BACKUP_VERSION,
            "exported_at": utc_now_iso(), "songs": songs}


def import_library(raw: bytes) -> dict[str, int]:
    if len(raw) > MAX_BACKUP_BYTES:
        raise HTTPException(status_code=413, detail="Library backup is limited to 100 MB.")
    try:
        backup = LibraryBackup.model_validate(json.loads(raw))
        ids = [song.id for song in backup.songs]
        if len(ids) != len(set(ids)):
            raise ValueError("Duplicate song IDs in backup")
        prepared = [(song, song.midi_bytes()) for song in backup.songs]
        for song, data in prepared:
            parse_midi(data)
            analysis_ids = [item.id for item in song.analyses]
            if len(analysis_ids) != len(set(analysis_ids)):
                raise ValueError("Duplicate analysis IDs in backup")
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=422, detail=f"Invalid library backup: {exc}") from exc

    created_files: list[Path] = []
    imported = 0
    skipped = 0
    try:
        with connect() as db:
            for song, data in prepared:
                if db.execute("SELECT 1 FROM songs WHERE id = ?", (song.id,)).fetchone():
                    skipped += 1
                    continue
                _midi, _notes, metadata = parse_midi(data)
                path = storage.MIDI_DIR / f"{song.id}.mid"
                if path.exists():
                    raise ValueError("A MIDI file already exists for an imported ID")
                # Write only to a generated ID path; never trust a path from the backup.
                path.write_bytes(data)
                created_files.append(path)
                db.execute(
                    """INSERT INTO songs(id, title, filename, midi_path, created_at,
                       updated_at, metadata_json, context_text)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (song.id, song.title, song.filename, str(path), song.created_at,
                     song.updated_at, dumps(metadata), song.context_text),
                )
                db.execute(
                    "INSERT INTO song_state(song_id, state_json, updated_at) VALUES (?, ?, ?)",
                    (song.id, dumps(song.state), song.updated_at),
                )
                for item in song.analyses:
                    analysis_id = item.id
                    if db.execute("SELECT 1 FROM analyses WHERE id = ?", (analysis_id,)).fetchone():
                        analysis_id = uuid.uuid4().hex
                    db.execute(
                        """INSERT INTO analyses(id, song_id, schema_version, provider,
                           model, input_fingerprint, analysis_json, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (analysis_id, song.id, item.schema_version, item.provider, item.model,
                         item.input_fingerprint, dumps(item.analysis), item.created_at, item.updated_at),
                    )
                imported += 1
    except Exception:
        for path in created_files:
            path.unlink(missing_ok=True)
        raise
    return {"imported": imported, "skipped_existing": skipped}
