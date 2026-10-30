from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
import threading
import time
import uuid

import mido
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from .. import db
from . import engine
from .models import Accept, Configure, Confirm, CreateReview, Edit, Inference, Practice, Revision, Run

router = APIRouter(prefix="/api/youtube", tags=["YouTube review"])
lock = threading.RLock()
pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="youtube")
worker = engine.Worker()
cancellations: dict[str, threading.Event] = {}
source_locks: dict[str, threading.Lock] = {}


def shutdown():
    with lock:
        for cancel in cancellations.values():
            cancel.set()
    if isinstance(worker, engine.Worker):
        with worker.lock:
            worker.stop()


def root():
    path = db.DATA_DIR / "youtube"
    path.mkdir(parents=True, exist_ok=True)
    return path


def folder(review_id):
    if len(review_id) != 32 or any(c not in "0123456789abcdef" for c in review_id):
        raise HTTPException(404, "Review not found")
    return root() / "reviews" / review_id


def save(session):
    path = folder(session["id"])
    path.mkdir(parents=True, exist_ok=True)
    temporary = path / "review.tmp"
    temporary.write_text(json.dumps(session, allow_nan=False))
    temporary.replace(path / "review.json")


def read(review_id):
    path = folder(review_id) / "review.json"
    if not path.exists():
        raise HTTPException(404, "Review not found")
    session = json.loads(path.read_text())
    job = session.get("job")
    if job and job["status"] in {"queued", "running"} and job["id"] not in cancellations:
        job.update(status="interrupted", phase="Interrupted by API restart; retry to continue")
        save(session)
    return session


def require_revision(session, revision):
    if session["revision"] != revision:
        raise HTTPException(409, "This review changed in another window. Reload it before editing.")


def bump(session):
    session["revision"] += 1
    if session.get("prepared") and session["prepared"]["fingerprint"] != fingerprint(session):
        session["prepared"] = None
    save(session)
    return session


def active_notes(session):
    if session["baseline"] is None:
        return []
    history = session["edits"]
    return history[session["edit_cursor"]]["notes"] if history else session["versions"][session["baseline"]]["notes"]


def corrected(session):
    return bool(session["baseline"] and active_notes(session) != session["versions"][session["baseline"]]["notes"])


def fingerprint(session):
    practice = Practice.model_validate(session["practice"]).model_dump()
    return engine.digest({"baseline": session["baseline"], "notes": active_notes(session), "practice": practice})


def launch(session, kind, operation):
    old = session.get("job")
    if old and old["id"] in cancellations:
        cancellations[old["id"]].set()
    job_id = uuid.uuid4().hex
    cancel = threading.Event()
    cancellations[job_id] = cancel
    job = {"id": job_id, "kind": kind, "status": "queued", "phase": "Waiting for worker", "elapsed": 0, "started": time.time()}
    session["job"] = job
    session["revision"] += 1
    save(session)
    snapshot = deepcopy(session)
    def progress(update):
        with lock:
            current = read(session["id"])
            if current["job"]["id"] == job_id and not cancel.is_set():
                current["job"].update(update, status="running", elapsed=time.time() - job["started"])
                save(current)
    def execute():
        try:
            result = operation(snapshot, cancel, progress)
            with lock:
                current = read(session["id"])
                if current["job"]["id"] != job_id or cancel.is_set():
                    return
                if kind == "download":
                    current["source"] = result
                    current["passage"] = {"start": 0, "end": min(20, result["duration"])}
                elif kind == "infer":
                    current["versions"][result["id"]] = result
                    current["candidate"] = result["id"]
                elif kind == "prepare":
                    # Never publish an export of edits/settings that changed mid-job.
                    if result["fingerprint"] != fingerprint(current):
                        current["job"].update(status="stale", phase="Review changed; prepare again")
                        save(current)
                        return
                    current["prepared"] = result
                current["job"].update(status="complete", phase="Ready to review", elapsed=time.time() - job["started"])
                current["revision"] += 1
                save(current)
        except engine.Cancelled:
            pass
        except Exception as exc:
            with lock:
                current = read(session["id"])
                if current["job"]["id"] == job_id and not cancel.is_set():
                    current["job"].update(status="failed", phase="Failed — previous results retained", error=str(exc), elapsed=time.time() - job["started"])
                    save(current)
        finally:
            with lock:
                cancellations.pop(job_id, None)
    pool.submit(execute)
    return session


def obtain_source(session, cancel, progress):
    video = session["video_id"]
    with lock:
        source_lock = source_locks.setdefault(video, threading.Lock())
    while not source_lock.acquire(timeout=.1):
        if cancel.is_set():
            raise engine.Cancelled()
    try:
        return engine.download(video, root() / "sources" / video, cancel, progress)
    finally:
        source_lock.release()


def infer(session, cancel, progress, full):
    source = session["source"]
    path = folder(session["id"])
    progress({"phase": "Loading model / checking cached weights (first use may download)"})
    identity = worker.request({"op": "identity", "settings": session["settings"]}, cancel, progress, path)
    start, end = engine.crop_bounds(session["passage"], source["duration"], full)
    key = engine.digest({"source": source["sha256"], "range": [start, end], "identity": identity, "settings": session["settings"]})
    cache_dir = root() / "predictions"
    cache_dir.mkdir(exist_ok=True)
    cached = cache_dir / f"{key}.json"
    hit = cached.exists()
    if hit:
        raw = json.loads(cached.read_text())
        progress({"phase": "Reusing cached raw predictions"})
    else:
        crop = path / f"{uuid.uuid4().hex}.wav"
        try:
            # Output-side seek decodes accurately; only inference is resampled to 16 kHz mono.
            engine.run_process(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(root() / "sources" / session["video_id"] / "playback.wav"),
                                "-ss", str(start), "-t", str(end - start), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(crop)], cancel, path / "crop.log")
            began = time.monotonic()
            raw = worker.request({"op": "infer", "audio": str(crop), "settings": session["settings"]}, cancel, progress, path)
            raw["processing_seconds"] = time.monotonic() - began
            temporary = cache_dir / f"{key}.{uuid.uuid4().hex}.tmp"
            temporary.write_text(json.dumps(raw))
            temporary.replace(cached)
        finally:
            crop.unlink(missing_ok=True)
    notes, excluded = engine.align_notes(raw["notes"], start, end, session["passage"], full)
    grid = deepcopy(raw["grid"])
    if grid:
        grid["first_downbeat"] += start
        if grid.get("beats") is not None:
            grid["beats"] = [b + start for b in grid["beats"]]
    return {"id": uuid.uuid4().hex, "notes": notes, "grid": grid, "full": full,
            "passage": {"start": 0, "end": source["duration"]} if full else session["passage"],
            "context": [start, end], "settings": session["settings"], "identity": identity,
            "cache_key": key, "cached": hit, "processing_seconds": raw["processing_seconds"], "excluded": excluded}


def read_export(data):
    """Read actual exported timing and undo only the explicit bar-alignment padding."""
    midi = mido.MidiFile(file=BytesIO(data))
    offset = 0
    for track in midi.tracks:
        for event in track:
            if event.type == "marker" and event.text.startswith("muscriptor:bar_offset="):
                offset = float(event.text.split("=", 1)[1])
    seconds = 0.0
    open_notes = {}
    notes = []
    for event in midi:
        seconds += event.time
        if event.type == "note_on" and event.velocity:
            open_notes.setdefault((event.channel, event.note), []).append(seconds)
        elif event.type == "note_off" or (event.type == "note_on" and not event.velocity):
            pending = open_notes.get((event.channel, event.note), [])
            if pending:
                start = pending.pop(0)
                if seconds > start and 21 <= event.note <= 108:
                    notes.append({"id": f"export-{len(notes)}", "pitch": event.note, "start": max(0, start-offset), "end": max(.001, seconds-offset), "instrument": "acoustic_piano", "boundary": False})
    return notes, offset


def prepare(session, cancel, progress):
    baseline = session["versions"][session["baseline"]]
    notes = active_notes(session)
    output_id = uuid.uuid4().hex
    output = folder(session["id"]) / f"{output_id}.mid"
    progress({"phase": "Preparing practice MIDI from reviewed notes"})
    worker.request({"op": "export", "settings": baseline["settings"], "notes": notes, "grid": baseline["grid"],
                    "practice": session["practice"], "output": str(output)}, cancel, progress, folder(session["id"]))
    exported, offset = read_export(output.read_bytes())
    from ..midi_analysis import resolve_bar_timings
    bars = [b.model_dump() for b in resolve_bar_timings(output.read_bytes())]
    return {"id": output_id, "fingerprint": fingerprint(session), "notes": exported,
            "source_offset": offset, "bars": bars, "practice": session["practice"]}


@router.get("/reviews")
def list_reviews():
    with lock:
        paths = (root() / "reviews").glob("*/review.json")
        sessions = [read(p.parent.name) for p in paths]
        return [{"id": s["id"], "title": (s.get("source") or {}).get("title", s["video_id"]), "imported_song_id": s.get("imported_song_id")} for s in sessions]


@router.post("/reviews")
def create_review(body: CreateReview):
    try:
        video = engine.youtube_id(body.url)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    with lock:
        session = {"id": uuid.uuid4().hex, "revision": 0, "video_id": video, "source": None, "passage": {"start": 0, "end": 20},
                   "settings": Inference().model_dump(), "practice": Practice().model_dump(), "versions": {}, "baseline": None,
                   "candidate": None, "edits": [], "edit_cursor": 0, "archives": [], "prepared": None, "job": None}
        return launch(session, "download", obtain_source)


@router.get("/reviews/{review_id}")
def get_review(review_id: str):
    with lock:
        session = read(review_id)
        if session.get("job") and session["job"]["status"] in {"queued", "running"}:
            session["job"]["elapsed"] = time.time() - session["job"]["started"]
        return session


@router.post("/reviews/{review_id}/retry-download")
def retry_download(review_id: str, body: Revision):
    with lock:
        session = read(review_id)
        require_revision(session, body.revision)
        return launch(session, "download", obtain_source)


@router.put("/reviews/{review_id}/configuration")
def configure(review_id: str, body: Configure):
    with lock:
        session = read(review_id)
        require_revision(session, body.revision)
        if not session["source"] or body.passage.end > session["source"]["duration"]:
            raise HTTPException(422, "Passage must be inside the source recording")
        session.update(body.model_dump(exclude={"revision"}))
        return bump(session)


@router.post("/reviews/{review_id}/transcribe")
def transcribe(review_id: str, body: Run):
    with lock:
        session = read(review_id)
        require_revision(session, body.revision)
        if not session["source"]:
            raise HTTPException(409, "Download source audio first")
        if not body.full and session["passage"]["end"] - session["passage"]["start"] > 60:
            raise HTTPException(422, "Choose a passage of at most 60 seconds for experiments")
        return launch(session, "infer", lambda s, c, p: infer(s, c, p, body.full))


@router.post("/reviews/{review_id}/cancel")
def cancel_job(review_id: str):
    with lock:
        session = read(review_id)
        job = session.get("job")
        if job and job["id"] in cancellations:
            cancellations[job["id"]].set()
            job.update(status="cancelled", phase="Cancelled — previous results retained", elapsed=time.time()-job["started"])
            session["revision"] += 1
            save(session)
        return session


@router.post("/reviews/{review_id}/accept")
def accept(review_id: str, body: Accept):
    with lock:
        session = read(review_id)
        require_revision(session, body.revision)
        if not session["candidate"]:
            raise HTTPException(409, "There is no candidate to accept")
        if corrected(session) and not body.archive_corrections:
            raise HTTPException(409, "Manual corrections belong to the current baseline. Keep them, or explicitly archive this branch before accepting the candidate.")
        if session["baseline"]:
            session["archives"].append({"baseline": session["baseline"], "edits": session["edits"], "edit_cursor": session["edit_cursor"]})
        session.update(baseline=session["candidate"], candidate=None, edits=[], edit_cursor=0)
        return bump(session)


@router.post("/reviews/{review_id}/discard")
def discard(review_id: str, body: Revision):
    with lock:
        session = read(review_id)
        require_revision(session, body.revision)
        session["candidate"] = None
        return bump(session)


@router.post("/reviews/{review_id}/restore/{index}")
def restore(review_id: str, index: int, body: Revision):
    with lock:
        session = read(review_id)
        require_revision(session, body.revision)
        if not 0 <= index < len(session["archives"]):
            raise HTTPException(404, "Correction branch not found")
        branch = deepcopy(session["archives"][index])
        session["archives"].append({"baseline": session["baseline"], "edits": session["edits"], "edit_cursor": session["edit_cursor"]})
        session.update(branch)
        return bump(session)


@router.post("/reviews/{review_id}/edits")
def edit(review_id: str, body: Edit):
    with lock:
        session = read(review_id)
        require_revision(session, body.revision)
        if not session["baseline"]:
            raise HTTPException(409, "Accept a baseline before editing")
        if any(n.end > session["source"]["duration"] + .1 for n in body.notes):
            raise HTTPException(422, "Notes must stay within the source recording")
        if not session["edits"]:
            session["edits"] = [{"label": "Generated baseline", "notes": active_notes(session)}]
        history = session["edits"][:session["edit_cursor"]+1]
        history.append({"label": body.label, "notes": [n.model_dump() for n in body.notes]})
        session.update(edits=history, edit_cursor=len(history)-1)
        return bump(session)


@router.post("/reviews/{review_id}/history/{direction}")
def history(review_id: str, direction: str, body: Revision):
    with lock:
        session = read(review_id)
        require_revision(session, body.revision)
        if direction not in {"undo", "redo"}:
            raise HTTPException(422, "Use undo or redo")
        cursor = session["edit_cursor"] + (-1 if direction == "undo" else 1)
        if not 0 <= cursor < len(session["edits"]):
            raise HTTPException(409, "No further history")
        session["edit_cursor"] = cursor
        return bump(session)


@router.post("/reviews/{review_id}/prepare")
def prepare_review(review_id: str, body: Revision):
    with lock:
        session = read(review_id)
        require_revision(session, body.revision)
        baseline = session["versions"].get(session["baseline"])
        if not baseline or not baseline["full"]:
            raise HTTPException(409, "Accept and review a full-recording transcription before import. Passage experiments cannot be imported.")
        if not active_notes(session):
            raise HTTPException(422, "Add at least one note before preparing practice")
        if not baseline["grid"] and not session["practice"]["bpm"]:
            raise HTTPException(422, "No beat grid was detected. Set a deliberate fixed BPM before preparing structured practice.")
        if not session["practice"]["beats_per_bar"] and not (baseline["grid"] or {}).get("beats_per_bar"):
            raise HTTPException(422, "Set beats per bar: the model did not detect a meter.")
        return launch(session, "prepare", prepare)


@router.get("/reviews/{review_id}/audio")
def audio(review_id: str):
    with lock:
        session = read(review_id)
        if not session["source"]:
            raise HTTPException(404, "Audio is not ready")
        path = root() / "sources" / session["video_id"] / "playback.wav"
    return FileResponse(path, media_type="audio/wav")


@router.get("/reviews/{review_id}/original")
def original(review_id: str):
    with lock:
        session = read(review_id)
        if not session["source"]:
            raise HTTPException(404, "Audio is not ready")
        path = root() / "sources" / session["video_id"] / session["source"]["original"]
    return FileResponse(path, filename=path.name)


@router.post("/reviews/{review_id}/confirm")
def confirm(review_id: str, body: Confirm, request: Request):
    # Lock spans commit: duplicate clicks are idempotent and can't race an edit.
    from ..main import SONG_QUERY, _row_to_song
    from ..midi_analysis import parse_midi
    from ..schemas import utc_now_iso
    with lock:
        session = read(review_id)
        prepared = session.get("prepared")
        if session.get("imported_fingerprint") == fingerprint(session):
            with db.connect() as connection:
                row = connection.execute(SONG_QUERY + " WHERE s.id = ?", (session["imported_song_id"],)).fetchone()
            if row:
                return _row_to_song(row, request, detail=True)
        require_revision(session, body.revision)
        if not body.reviewed or not prepared or prepared["fingerprint"] != fingerprint(session):
            raise HTTPException(409, "Prepare and review the current practice MIDI before confirming")
        if not body.title.strip():
            raise HTTPException(422, "Give the piece a title")
        data = (folder(review_id) / f"{prepared['id']}.mid").read_bytes()
        _, _, metadata = parse_midi(data)
        song_id = uuid.uuid4().hex
        path = db.MIDI_DIR / f"{song_id}.mid"
        path.write_bytes(data)
        now = utc_now_iso()
        assignments = {str(t.index): t.suggested_assignment if t.default_selected else "ignore" for t in metadata.tracks}
        state = db.default_state(metadata.duration_seconds, assignments)
        context = f"Reviewed YouTube performance: {session['source']['url']}\nReview ID: {review_id}. Original expressive notes and correction history retained locally. MIDI bar-alignment padding: {prepared['source_offset']:.6f} seconds."
        with db.connect() as connection:
            connection.execute("INSERT INTO songs(id,title,filename,midi_path,created_at,updated_at,metadata_json,context_text) VALUES (?,?,?,?,?,?,?,?)",
                               (song_id, body.title.strip(), "youtube-reviewed.mid", str(path), now, now, db.dumps(metadata), context))
            connection.execute("INSERT INTO song_state(song_id,state_json,updated_at) VALUES (?,?,?)", (song_id, db.dumps(state), now))
            row = connection.execute(SONG_QUERY + " WHERE s.id = ?", (song_id,)).fetchone()
        session.update(imported_song_id=song_id, imported_fingerprint=prepared["fingerprint"])
        save(session)
        return _row_to_song(row, request, detail=True)
