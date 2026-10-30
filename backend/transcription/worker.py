"""JSON-lines worker; run with the isolated MuScriptor Python, never the API venv.

stdout is protocol only. Cancellation terminates this process; successful requests
reuse the model. No user-provided code, paths to model weights, or shell commands.
"""
from __future__ import annotations

import dataclasses
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import traceback
from contextlib import redirect_stdout
from importlib.metadata import version, distribution

PIN = "8a1ef88672cc23c26619adaff37ec48d82c0b906"
wire = sys.stdout
model = None
model_size = None
identity = None


def resolve_weights(size):
    """Prefer the user's local named checkpoint; identify it by content."""
    project = Path(__file__).resolve().parents[2]
    directory = Path(os.getenv("MUSCRIPTOR_WEIGHTS_DIR", str(project)))
    local = directory / f"muscriptor-{size}.safetensors"
    if local.is_file():
        with local.open("rb") as stream:
            checksum = hashlib.file_digest(stream, "sha256").hexdigest()
        return local, f"sha256:{checksum}", "local"
    from huggingface_hub import hf_hub_download
    cache_dir = str(Path(os.getenv("CADENCE_DATA_DIR", str(project / "data"))) / "youtube" / "models")
    repo = f"MuScriptor/muscriptor-{size}"
    weights = Path(hf_hub_download(repo, "model.safetensors", revision=os.getenv("MUSCRIPTOR_WEIGHTS_REVISION", "main"), cache_dir=cache_dir))
    revision = weights.parent.name
    hf_hub_download(repo, "config.json", revision=revision, cache_dir=cache_dir)
    return weights, revision, "huggingface"


def emit(value):
    wire.write(json.dumps(value, allow_nan=False) + "\n")
    wire.flush()


def load(size):
    global model, model_size, identity
    if model is not None and model_size == size:
        return
    from muscriptor.transcription_model import TranscriptionModel
    import muscriptor.accelerator as accelerator
    # Upstream's timing helper calls torch.accelerator.synchronize even on
    # CPU-only hosts. Some PyTorch builds segfault there instead of raising.
    if not accelerator.is_available():
        accelerator.synchronize = lambda: None
    if version("muscriptor") != "0.4.0":
        raise RuntimeError("Install the documented pinned MuScriptor revision (0.4.0).")
    direct = json.loads(distribution("muscriptor").read_text("direct_url.json") or "{}")
    if direct.get("vcs_info", {}).get("commit_id") != PIN:
        raise RuntimeError("MuScriptor source revision differs from the inspected adapter. Reinstall the pinned commit in docs/YOUTUBE_IMPORT.md.")
    repo = f"MuScriptor/muscriptor-{size}"
    weights, revision, origin = resolve_weights(size)
    model = None  # release the previous size before loading another
    model = TranscriptionModel.load_model(weights, device=os.getenv("MUSCRIPTOR_DEVICE") or None)
    model_size = size
    identity = {"code": PIN, "adapter": 1, "package": version("muscriptor"), "model": repo,
                "weights_revision": revision, "origin": origin, "device": str(model._device)}


def run(req):
    from muscriptor.events import NoteStartEvent, NoteEndEvent, ProgressEvent
    from muscriptor.utils.beats import BeatGrid
    from muscriptor.utils.midi import ExportOptions
    import numpy as np
    if req["op"] != "export":
        load(req.get("settings", {}).get("model", "small"))
    if req["op"] == "identity":
        return identity
    if req["op"] == "infer":
        settings = req["settings"]
        events = []
        starts = {}
        notes = []
        for ev in model.transcribe(req["audio"], instruments=["acoustic_piano"] if settings["instruments"] == "piano" else None,
                                   beam_size=settings["beam_size"], batch_size=1, prelude_forcing=True):
            if isinstance(ev, ProgressEvent):
                emit({"progress": {"completed": ev.completed, "total": ev.total, "phase": "Transcribing"}})
            else:
                events.append(ev)
                if isinstance(ev, NoteStartEvent):
                    starts[ev.index] = ev
                elif isinstance(ev, NoteEndEvent):
                    start = starts.pop(ev.start_event_index)
                    notes.append({"id": str(start.index), "pitch": start.pitch, "start": start.start_time,
                                  "end": ev.end_time, "instrument": start.instrument})
        emit({"progress": {"phase": "Detecting beats and bars"}})
        grid = model.detect_beat_grid_for(req["audio"], "best-effort")
        if grid:
            grid = grid.with_onset_delay([n["start"] for n in notes])
        raw_grid = dataclasses.asdict(grid) if grid else None
        if raw_grid and raw_grid.get("beats") is not None:
            raw_grid["beats"] = raw_grid["beats"].tolist()
        return {"notes": notes, "grid": raw_grid, "identity": identity,
                "events": [dataclasses.asdict(e) for e in events]}
    if req["op"] == "export":
        from muscriptor.tokenizer.mt3 import MT3Tokenizer, MT3_FULL_PLUS_GROUP_NAMES
        from muscriptor.tokenizer.notes import Note, validate_notes, trim_overlapping_notes
        from muscriptor.utils.midi import notes_to_midi
        tokenizer = MT3Tokenizer(instrument_vocabulary="MT3_FULL_PLUS", max_shift_steps=1001)
        names = {}
        notes = []
        for note in req["notes"]:
            group = MT3_FULL_PLUS_GROUP_NAMES[note["instrument"]]
            program = tokenizer.group_program_map[group][0]
            names[program] = note["instrument"].replace("_", " ")
            notes.append(Note(is_drum=False, program=program, onset=note["start"], offset=note["end"], pitch=note["pitch"]))
        notes = trim_overlapping_notes(validate_notes(notes, fix=True), sort=True)
        fields = req.get("grid")
        grid = None
        if fields:
            fields = dict(fields)
            fields["onset_delay"] = 0.0  # review times are authoritative, including manual edits
            if fields.get("beats") is not None:
                fields["beats"] = np.asarray(fields["beats"])
            grid = BeatGrid(**fields)
        options = ExportOptions(**req["practice"])
        midi = notes_to_midi(notes, program_names=names, beat_grid=grid, options=options)
        output = io.BytesIO()
        midi.save(file=output)
        data = output.getvalue()
        Path(req["output"]).write_bytes(data)
        return {"bytes": len(data)}
    raise ValueError("Unknown worker operation")


if __name__ == "__main__":
    for line in sys.stdin:
        try:
            with redirect_stdout(sys.stderr):
                result = run(json.loads(line))
            emit({"result": result})
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            emit({"error": str(exc)})
