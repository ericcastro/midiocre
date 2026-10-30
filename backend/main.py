from __future__ import annotations

import os
import json
import re
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response

from .ai import AnalysisProviderError, analyze_with_ollama, analyze_with_openai
from .library_backup import MAX_BACKUP_BYTES, export_library, import_library
from .db import MIDI_DIR, connect, default_state, dumps, ensure_storage, loads
from .midi_analysis import (
    analysis_input_fingerprint,
    build_symbolic_digest,
    parse_midi,
    resolve_bar_timings,
    resolve_midi_events,
)
from .schemas import (
    AnalysisEnvelope,
    AnalysisRequest,
    BarTiming,
    MidiEvent,
    LegacyPieceAnalysis,
    Landmark,
    MusicalCharacter,
    PieceAnalysisView,
    PieceAnalysis,
    PracticeRoute,
    PracticeStep,
    PracticeUnitView,
    ReferencedCue,
    SongContextUpdate,
    SongDetail,
    SongListItem,
    SongMetadata,
    SongState,
    utc_now_iso,
)


load_dotenv()
MAX_MIDI_BYTES = 20 * 1024 * 1024


@asynccontextmanager
async def lifespan(_app: FastAPI):
    ensure_storage()
    yield


app = FastAPI(title="MIDIocre API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=(
        r"^https?://("
        r"localhost|127(?:\.\d{1,3}){3}|\[::1\]|"
        r"10(?:\.\d{1,3}){3}|"
        r"100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}|"
        r"192\.168(?:\.\d{1,3}){2}|"
        r"172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|"
        r"[a-zA-Z0-9-]+\.local|"
        r"(?:[a-zA-Z0-9-]+\.)+[a-zA-Z0-9-]+\.ts\.net"
        r")(?::\d+)?$"
    ),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _row_to_song(row, request: Request, detail: bool = False):
    metadata = SongMetadata.model_validate(loads(row["metadata_json"]))
    state = SongState.model_validate(loads(row["state_json"]))
    duration = metadata.duration_seconds
    progress = min(1.0, state.position_seconds / duration) if duration else 0
    common = {
        "id": row["id"],
        "title": row["title"],
        "filename": row["filename"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "last_opened_at": state.last_opened_at,
        "duration_seconds": duration,
        "note_count": metadata.note_count,
        "progress": progress,
        "has_analysis": bool(row["analysis_json"]),
    }
    if not detail:
        return SongListItem(**common)
    analysis = adapt_analysis(loads(row["analysis_json"])) if row["analysis_json"] else None
    analysis_is_stale = False
    if analysis:
        midi_data = Path(row["midi_path"]).read_bytes()
        current_fingerprint = analysis_input_fingerprint(
            midi_data,
            state.track_assignments,
            state.split_pitch,
            row["title"],
            row["context_text"] or "",
        )
        analysis_is_stale = (
            not row["input_fingerprint"]
            or current_fingerprint != row["input_fingerprint"]
        )
    return SongDetail(
        **common,
        midi_url=str(request.url_for("song_midi", song_id=row["id"])),
        metadata=metadata,
        state=state,
        context_text=row["context_text"] or "",
        analysis=analysis,
        analysis_provider=row["analysis_provider"],
        analysis_model=row["analysis_model"],
        analysis_updated_at=row["analysis_updated_at"],
        analysis_is_stale=analysis_is_stale,
    )


def adapt_analysis(raw: dict) -> PieceAnalysisView:
    if raw.get("schema_version") == "1.1":
        return PieceAnalysisView.model_validate({**raw, "legacy_analysis": False})

    legacy = LegacyPieceAnalysis.model_validate(raw)
    chronological = sorted(
        legacy.practice_units,
        key=lambda unit: (unit.timing.start_bar, unit.timing.end_bar),
    )
    view_units: list[PracticeUnitView] = []
    for unit in legacy.practice_units:
        hand = unit.hands[0] if len(unit.hands) == 1 else "both"
        cues = [
            ReferencedCue(
                id=f"{unit.id}-legacy-cue-{index + 1}",
                hand=hand,
                text=tip,
                event_refs=[],
            )
            for index, tip in enumerate(unit.tips)
        ]
        steps = [
            PracticeStep(
                instruction=step.instruction,
                hand_mode=step.hand_mode,
                tempo_percent=step.tempo_percent,
                repetitions=step.repetitions,
                event_refs=[],
            )
            for step in unit.steps
        ]
        view_units.append(
            PracticeUnitView(
                id=unit.id,
                title=unit.title,
                timing=unit.timing,
                hands=unit.hands,
                difficulty=unit.difficulty,
                focus=unit.focus,
                pattern_summary=unit.pattern_summary,
                landmarks=[],
                cues=cues,
                steps=steps,
                success_criteria=unit.success_criteria,
                common_traps=unit.common_traps,
            )
        )
    return PieceAnalysisView(
        schema_version="1.0",
        title=legacy.title,
        overview=legacy.overview,
        musical_character=MusicalCharacter(
            summary="This saved analysis predates interactive landmarks and musical-character guidance.",
            style_hint=None,
            confidence="low",
            basis="midi",
            evidence=["The original v1.0 analysis did not include a musical-character field."],
            practice_implications=["Regenerate the map to receive visual note references and richer context-aware guidance."],
        ),
        player_strategy=legacy.player_strategy,
        routes=[
            PracticeRoute(
                id="balanced",
                title="Balanced",
                rationale="Start at the beginning so the piece becomes familiar before visiting harder passages.",
                unit_ids=[unit.id for unit in chronological],
            ),
            PracticeRoute(
                id="challenge",
                title="Challenge",
                rationale="Use the saved v1.0 practice order, which was designed around coordination risk.",
                unit_ids=legacy.practice_order,
            ),
        ],
        practice_units=view_units,
        assumptions=legacy.assumptions,
        legacy_analysis=True,
    )


def _validate_event_references(analysis: PieceAnalysis, events) -> None:
    event_by_id = {event.id: event for event in events}

    def validate_refs(unit, owner: str, hand: str, refs: list[str]) -> None:
        for event_id in refs:
            event = event_by_id.get(event_id)
            if event is None:
                raise HTTPException(
                    status_code=502,
                    detail=f"The model referenced an unknown MIDI event in {owner}.",
                )
            if not (unit.timing.start_tick <= event.start_tick < unit.timing.end_tick):
                raise HTTPException(
                    status_code=502,
                    detail=f"The model referenced an event outside {unit.title}.",
                )
            if hand != "both" and event.hand != hand:
                raise HTTPException(
                    status_code=502,
                    detail=(
                        f"The model assigned a {event.hand} event ({event_id}) to a {hand} cue "
                        f"{owner} in {unit.title}. Regenerate after checking hand setup."
                    ),
                )

    for unit in analysis.practice_units:
        landmark_ids = [landmark.id for landmark in unit.landmarks]
        if len(landmark_ids) != len(set(landmark_ids)):
            raise HTTPException(
                status_code=502,
                detail=f"The model returned duplicate landmark ids in {unit.title}.",
            )
        cue_ids = [cue.id for cue in unit.cues]
        if len(cue_ids) != len(set(cue_ids)):
            raise HTTPException(
                status_code=502,
                detail=f"The model returned duplicate cue ids in {unit.title}.",
            )
        if len(landmark_ids + cue_ids) != len(set(landmark_ids + cue_ids)):
            raise HTTPException(
                status_code=502,
                detail=f"The model reused a landmark or cue id in {unit.title}.",
            )
        for landmark in unit.landmarks:
            validate_refs(unit, f"landmark {landmark.label}", landmark.hand, landmark.event_refs)
        for cue in unit.cues:
            validate_refs(unit, f"cue {cue.id}", cue.hand, cue.event_refs)
        for step in unit.steps:
            validate_refs(unit, f"practice step in {unit.title}", step.hand_mode, step.event_refs)


SONG_QUERY = """
SELECT s.*,
       st.state_json,
       a.analysis_json,
       a.provider AS analysis_provider,
       a.model AS analysis_model,
       a.updated_at AS analysis_updated_at,
       a.input_fingerprint
FROM songs s
JOIN song_state st ON st.song_id = s.id
LEFT JOIN analyses a ON a.id = (
    SELECT id FROM analyses
    WHERE song_id = s.id
    ORDER BY updated_at DESC
    LIMIT 1
)
"""


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/analysis/schema")
def analysis_schema() -> dict:
    """Canonical JSON Schema for every saved AI analysis."""
    return PieceAnalysis.model_json_schema()


@app.get("/api/library/backup")
def download_library_backup() -> Response:
    payload = json.dumps(export_library(), separators=(",", ":"), ensure_ascii=False)
    return Response(
        payload,
        media_type="application/json",
        headers={
            "Content-Disposition": 'attachment; filename="midiocre-library.json"',
            "Cache-Control": "no-store",
        },
    )


def _migrate_legacy_track_mapping(db, row):
    """Refresh pre-classification metadata without overwriting user choices."""
    raw_metadata = loads(row["metadata_json"])
    raw_tracks = raw_metadata.get("tracks", []) if isinstance(raw_metadata, dict) else []
    if not raw_tracks or any("instrument_id" in track for track in raw_tracks):
        return row

    midi_path = Path(row["midi_path"])
    if not midi_path.exists():
        return row
    try:
        _midi, _notes, metadata = parse_midi(midi_path.read_bytes())
    except ValueError:
        return row

    state = SongState.model_validate(loads(row["state_json"]))
    legacy_defaults = {
        str(track["index"]): track["suggested_assignment"]
        for track in raw_tracks
        if "index" in track and "suggested_assignment" in track
    }
    if state.track_assignments == legacy_defaults:
        state.track_assignments = {
            str(track.index): (
                track.suggested_assignment if track.default_selected else "ignore"
            )
            for track in metadata.tracks
        }
        db.execute(
            "UPDATE song_state SET state_json = ? WHERE song_id = ?",
            (dumps(state), row["id"]),
        )
    db.execute(
        "UPDATE songs SET metadata_json = ? WHERE id = ?",
        (dumps(metadata), row["id"]),
    )
    return db.execute(SONG_QUERY + " WHERE s.id = ?", (row["id"],)).fetchone()


@app.post("/api/library/backup")
async def upload_library_backup(file: UploadFile = File(...)) -> dict[str, int]:
    raw = await file.read(MAX_BACKUP_BYTES + 1)
    return import_library(raw)


@app.get("/api/songs", response_model=list[SongListItem])
def list_songs(request: Request) -> list[SongListItem]:
    with connect() as db:
        rows = db.execute(SONG_QUERY + " ORDER BY s.updated_at DESC").fetchall()
    return [_row_to_song(row, request) for row in rows]


@app.post("/api/midi/inspect", response_model=SongMetadata)
async def inspect_midi(file: UploadFile = File(...)) -> SongMetadata:
    filename = Path(file.filename or "Untitled.mid").name
    if Path(filename).suffix.lower() not in {".mid", ".midi"}:
        raise HTTPException(status_code=415, detail="Choose a .mid or .midi file.")
    data = await file.read(MAX_MIDI_BYTES + 1)
    if len(data) > MAX_MIDI_BYTES:
        raise HTTPException(status_code=413, detail="MIDI files are limited to 20 MB.")
    try:
        _midi, _notes, metadata = parse_midi(data)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return metadata


@app.post("/api/songs", response_model=SongDetail, status_code=201)
async def upload_song(
    request: Request,
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    context_text: str = Form(default=""),
    track_assignments: str | None = Form(default=None),
) -> SongDetail:
    filename = Path(file.filename or "Untitled.mid").name
    if Path(filename).suffix.lower() not in {".mid", ".midi"}:
        raise HTTPException(status_code=415, detail="Choose a .mid or .midi file.")
    data = await file.read(MAX_MIDI_BYTES + 1)
    if len(data) > MAX_MIDI_BYTES:
        raise HTTPException(status_code=413, detail="MIDI files are limited to 20 MB.")
    try:
        _midi, _notes, metadata = parse_midi(data)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if len(context_text) > 4000:
        raise HTTPException(status_code=422, detail="Piece context is limited to 4,000 characters.")

    resolved_title = (title or "").strip() or re.sub(r"[_-]+", " ", Path(filename).stem).strip() or "Untitled"
    if len(resolved_title) > 160:
        raise HTTPException(status_code=422, detail="Song titles are limited to 160 characters.")

    assignments = {
        str(track.index): (
            track.suggested_assignment if track.default_selected else "ignore"
        )
        for track in metadata.tracks
    }
    if track_assignments:
        try:
            requested_assignments = json.loads(track_assignments)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=422, detail="Invalid track selection.") from exc
        valid_track_ids = {str(track.index) for track in metadata.tracks}
        valid_assignments = {"left", "right", "split", "ignore"}
        if (
            not isinstance(requested_assignments, dict)
            or set(requested_assignments) != valid_track_ids
            or any(value not in valid_assignments for value in requested_assignments.values())
            or all(value == "ignore" for value in requested_assignments.values())
        ):
            raise HTTPException(status_code=422, detail="Invalid track selection.")
        assignments = requested_assignments

    song_id = uuid.uuid4().hex
    stored_path = MIDI_DIR / f"{song_id}.mid"
    stored_path.write_bytes(data)
    now = utc_now_iso()
    state = default_state(metadata.duration_seconds, assignments)

    with connect() as db:
        db.execute(
            """
            INSERT INTO songs(id, title, filename, midi_path, created_at, updated_at, metadata_json, context_text)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (song_id, resolved_title, filename, str(stored_path), now, now, dumps(metadata), context_text.strip()),
        )
        db.execute(
            "INSERT INTO song_state(song_id, state_json, updated_at) VALUES (?, ?, ?)",
            (song_id, dumps(state), now),
        )
        row = db.execute(SONG_QUERY + " WHERE s.id = ?", (song_id,)).fetchone()
    return _row_to_song(row, request, detail=True)


@app.get("/api/songs/{song_id}", response_model=SongDetail)
def get_song(song_id: str, request: Request) -> SongDetail:
    with connect() as db:
        row = db.execute(SONG_QUERY + " WHERE s.id = ?", (song_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Song not found.")
        row = _migrate_legacy_track_mapping(db, row)
        return _row_to_song(row, request, detail=True)


@app.put("/api/songs/{song_id}/context", response_model=SongDetail)
def update_song_context(
    song_id: str,
    context: SongContextUpdate,
    request: Request,
) -> SongDetail:
    now = utc_now_iso()
    with connect() as db:
        result = db.execute(
            "UPDATE songs SET title = ?, context_text = ?, updated_at = ? WHERE id = ?",
            (context.title.strip(), context.context_text.strip(), now, song_id),
        )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Song not found.")
        row = db.execute(SONG_QUERY + " WHERE s.id = ?", (song_id,)).fetchone()
    return _row_to_song(row, request, detail=True)


@app.get("/api/songs/{song_id}/midi", name="song_midi")
def song_midi(song_id: str) -> FileResponse:
    with connect() as db:
        row = db.execute("SELECT midi_path, filename FROM songs WHERE id = ?", (song_id,)).fetchone()
    if row is None or not Path(row["midi_path"]).exists():
        raise HTTPException(status_code=404, detail="MIDI file not found.")
    return FileResponse(
        row["midi_path"],
        media_type="audio/midi",
        filename=row["filename"],
    )


@app.get("/api/songs/{song_id}/events", response_model=list[MidiEvent])
def song_events(song_id: str) -> list[MidiEvent]:
    with connect() as db:
        row = db.execute(
            "SELECT s.midi_path, st.state_json FROM songs s JOIN song_state st ON st.song_id = s.id WHERE s.id = ?",
            (song_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Song not found.")
    state = SongState.model_validate(loads(row["state_json"]))
    events, _metadata = resolve_midi_events(
        Path(row["midi_path"]).read_bytes(),
        assignments=state.track_assignments,
        split_pitch=state.split_pitch,
    )
    return events


@app.get("/api/songs/{song_id}/bars", response_model=list[BarTiming])
def song_bars(song_id: str) -> list[BarTiming]:
    with connect() as db:
        row = db.execute(
            "SELECT midi_path FROM songs WHERE id = ?",
            (song_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Song not found.")
    return resolve_bar_timings(Path(row["midi_path"]).read_bytes())


@app.put("/api/songs/{song_id}/state", response_model=SongState)
def update_state(song_id: str, state: SongState) -> SongState:
    now = utc_now_iso()
    state.last_opened_at = now
    with connect() as db:
        result = db.execute(
            "UPDATE song_state SET state_json = ?, updated_at = ? WHERE song_id = ?",
            (dumps(state), now, song_id),
        )
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Song not found.")
        db.execute("UPDATE songs SET updated_at = ? WHERE id = ?", (now, song_id))
    return state


@app.post("/api/songs/{song_id}/analyze", response_model=AnalysisEnvelope)
def analyze_song(song_id: str, request_body: AnalysisRequest) -> AnalysisEnvelope:
    with connect() as db:
        row = db.execute(
            """
            SELECT s.title, s.context_text, s.midi_path, st.state_json
            FROM songs s JOIN song_state st ON st.song_id = s.id
            WHERE s.id = ?
            """,
            (song_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Song not found.")
    state = SongState.model_validate(loads(row["state_json"]))
    data = Path(row["midi_path"]).read_bytes()
    digest = build_symbolic_digest(
        data,
        assignments=state.track_assignments,
        split_pitch=state.split_pitch,
    )
    input_fingerprint = analysis_input_fingerprint(
        data,
        state.track_assignments,
        state.split_pitch,
        row["title"],
        row["context_text"] or "",
    )
    events, _metadata = resolve_midi_events(
        data,
        assignments=state.track_assignments,
        split_pitch=state.split_pitch,
    )

    try:
        if request_body.provider == "openai":
            analysis = analyze_with_openai(
                digest=digest,
                song_title=row["title"],
                context_text=row["context_text"] or "",
                model=request_body.model,
                api_key=request_body.api_key,
                reasoning_effort=request_body.reasoning_effort,
            )
        else:
            analysis = analyze_with_ollama(
                digest=digest,
                song_title=row["title"],
                context_text=row["context_text"] or "",
                model=request_body.model,
                base_url=request_body.ollama_base_url,
            )
    except AnalysisProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    maximum_duration = digest["metadata"]["duration_seconds"] + 0.25
    maximum_bar = digest["metadata"]["bars"]
    _validate_event_references(analysis, events)
    for unit in analysis.practice_units:
        if unit.timing.end_seconds > maximum_duration:
            raise HTTPException(
                status_code=502,
                detail=(
                    f"The model returned an invalid end time for “{unit.title}”. "
                    "Nothing was saved; try the analysis again."
                ),
            )
        if unit.timing.end_bar > maximum_bar:
            raise HTTPException(
                status_code=502,
                detail=(
                    f"The model returned an invalid bar number for “{unit.title}”. "
                    "Nothing was saved; try the analysis again."
                ),
            )

    now = utc_now_iso()
    analysis_id = uuid.uuid4().hex
    with connect() as db:
        db.execute(
            """
            INSERT INTO analyses(
                id, song_id, schema_version, provider, model, input_fingerprint,
                analysis_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                analysis_id,
                song_id,
                analysis.schema_version,
                request_body.provider,
                request_body.model,
                input_fingerprint,
                dumps(analysis),
                now,
                now,
            ),
        )
        db.execute("UPDATE songs SET updated_at = ? WHERE id = ?", (now, song_id))
    return AnalysisEnvelope(
        analysis=analysis,
        provider=request_body.provider,
        model=request_body.model,
        updated_at=now,
        input_fingerprint=input_fingerprint,
    )


@app.delete("/api/songs/{song_id}", status_code=204)
def delete_song(song_id: str) -> None:
    with connect() as db:
        row = db.execute("SELECT midi_path FROM songs WHERE id = ?", (song_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Song not found.")
        db.execute("DELETE FROM songs WHERE id = ?", (song_id,))
    try:
        os.remove(row["midi_path"])
    except FileNotFoundError:
        pass
