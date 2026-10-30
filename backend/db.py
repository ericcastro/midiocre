from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .schemas import SongState, utc_now_iso


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.getenv("CADENCE_DATA_DIR", PROJECT_ROOT / "data"))
MIDI_DIR = DATA_DIR / "midi"
DB_PATH = DATA_DIR / "cadence.sqlite3"


def ensure_storage() -> None:
    MIDI_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.executescript(
            """
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;

            CREATE TABLE IF NOT EXISTS songs (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                filename TEXT NOT NULL,
                midi_path TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                context_text TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS song_state (
                song_id TEXT PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
                state_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS analyses (
                id TEXT PRIMARY KEY,
                song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
                schema_version TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                input_fingerprint TEXT NOT NULL DEFAULT '',
                analysis_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS analyses_song_updated_idx
                ON analyses(song_id, updated_at DESC);
            """
        )
        columns = {
            row["name"] for row in db.execute("PRAGMA table_info(analyses)").fetchall()
        }
        if "input_fingerprint" not in columns:
            db.execute(
                "ALTER TABLE analyses ADD COLUMN input_fingerprint TEXT NOT NULL DEFAULT ''"
            )
        song_columns = {
            row["name"] for row in db.execute("PRAGMA table_info(songs)").fetchall()
        }
        if "context_text" not in song_columns:
            db.execute(
                "ALTER TABLE songs ADD COLUMN context_text TEXT NOT NULL DEFAULT ''"
            )
        # MIDI files are stored under a stable ID-based name. Repair paths saved
        # before the project was moved to a different folder.
        for row in db.execute("SELECT id, midi_path FROM songs").fetchall():
            current_path = Path(row["midi_path"])
            relocated_path = MIDI_DIR / f"{row['id']}.mid"
            if relocated_path.exists() and current_path != relocated_path:
                db.execute(
                    "UPDATE songs SET midi_path = ? WHERE id = ?",
                    (str(relocated_path), row["id"]),
                )


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    try:
        yield db
        db.commit()
    finally:
        db.close()


def dumps(value: Any) -> str:
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json")
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def loads(value: str) -> Any:
    return json.loads(value)


def default_state(duration_seconds: float, assignments: dict[str, str]) -> SongState:
    return SongState(
        loop_end_seconds=duration_seconds,
        practice_route="structured",
        track_assignments=assignments,
        last_opened_at=utc_now_iso(),
    )
