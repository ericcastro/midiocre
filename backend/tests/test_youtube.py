from copy import deepcopy
from io import BytesIO
import json
import threading
import time
import wave

import mido
import pytest
from fastapi.testclient import TestClient

from backend.transcription import engine, reviews
from backend.transcription.models import Note


@pytest.fixture
def client(tmp_path, monkeypatch):
    from backend import db
    from backend.main import app
    monkeypatch.setattr(db, "DATA_DIR", tmp_path)
    monkeypatch.setattr(db, "MIDI_DIR", tmp_path / "midi")
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "library.sqlite3")
    with TestClient(app) as c:
        yield c
    deadline = time.monotonic() + 4
    while reviews.cancellations and time.monotonic() < deadline:
        time.sleep(.01)


def note(id="a", start=1, end=2, pitch=60):
    return Note(id=id, start=start, end=end, pitch=pitch).model_dump()


def fixture_review(client, full=True):
    s = {"id": "a"*32, "revision": 0, "video_id": "abcdefghijk", "source": {"duration": 30, "title": "Test performance", "url": "https://youtu.be/abcdefghijk", "sha256": "audio", "original": "original.webm"},
         "passage": {"start": 5.2, "end": 12.3}, "settings": {"model": "small", "instruments": "piano", "beam_size": 1},
         "practice": {"bpm": None, "beats_per_bar": None, "first_downbeat": None, "tempo_map": None, "quantize": False, "subdivision": 4, "strength": 1},
         "versions": {"v1": {"id": "v1", "notes": [note()], "full": full, "settings": {}, "grid": {"bpm": 120, "beats_per_bar": 4}}}, "baseline": "v1", "candidate": None, "edits": [], "edit_cursor": 0, "archives": [], "prepared": None, "job": None}
    with reviews.lock:
        reviews.save(s)
    return s


def post(client, s, route, **body):
    return client.post(f"/api/youtube/reviews/{s['id']}/{route}", json={"revision": s["revision"], **body})


def await_job(client, s):
    for _ in range(300):
        s = client.get(f"/api/youtube/reviews/{s['id']}").json()
        if s["job"]["status"] not in {"queued", "running"}:
            return s
        time.sleep(.01)
    raise AssertionError("job did not finish")


def test_source_validation():
    assert engine.youtube_id("https://youtu.be/abcdefghijk?t=10") == "abcdefghijk"
    assert engine.youtube_id("https://www.youtube.com/watch?v=abcdefghijk&list=123") == "abcdefghijk"
    for url in ["file:///etc/passwd", "https://youtube.com.evil.test/watch?v=abcdefghijk", "http://127.0.0.1/video", "https://youtube.com/playlist?list=abc", "https://user@youtube.com/watch?v=abcdefghijk"]:
        with pytest.raises(ValueError):
            engine.youtube_id(url)


def test_context_and_source_alignment_preserve_crossing_notes():
    passage = {"start": 12.3, "end": 18.7}
    assert engine.crop_bounds(passage, 100, False) == (5, 25)
    raw = [note("a", 6.5, 9), note("b", 13, 17), note("outside", 0, 1), note("edge", 12, 20)]
    result, excluded = engine.align_notes(raw, 5, 25, passage, False)
    assert [(n["start"], n["end"]) for n in result] == [(11.5, 14), (18, 22), (17, 25)]
    assert result[-1]["boundary"]
    assert not result[0]["boundary"]
    assert excluded == 0
    assert engine.crop_bounds(passage, 100, True) == (0, 100)


def test_edits_undo_redo_and_explicit_branch_conflict(client):
    s = fixture_review(client)
    changed = [note(start=1.2, end=2.4, pitch=62)]
    s = post(client, s, "edits", notes=changed, label="Move").json()
    assert reviews.active_notes(s) == changed
    assert s["versions"]["v1"]["notes"][0]["pitch"] == 60
    s = post(client, s, "history/undo").json()
    assert reviews.active_notes(s)[0]["pitch"] == 60
    s = post(client, s, "history/redo").json()
    assert reviews.active_notes(s) == changed
    s["versions"]["v2"] = {**s["versions"]["v1"], "id": "v2", "notes": [note(pitch=65)]}
    s["candidate"] = "v2"
    reviews.save(s)
    assert post(client, s, "accept").status_code == 409
    s = post(client, s, "accept", archive_corrections=True).json()
    assert reviews.active_notes(s)[0]["pitch"] == 65
    assert s["archives"][0]["edits"][1]["notes"] == changed
    s = post(client, s, "restore/0").json()
    assert reviews.active_notes(s) == changed
    assert post(client, {**s, "revision": 0}, "edits", notes=[]).status_code == 409
    assert client.get(f"/api/youtube/reviews/{s['id']}").json()["edits"] == s["edits"]


def test_cancellation_and_late_result_cannot_replace_newer_candidate(client):
    s = fixture_review(client)
    started, release = threading.Event(), threading.Event()
    def slow(snapshot, cancel, progress):
        started.set()
        release.wait(3)
        return {"id": "late", "notes": [note(pitch=40)]}
    with reviews.lock:
        s = reviews.launch(s, "infer", slow)
    assert started.wait(1)
    s = client.post(f"/api/youtube/reviews/{s['id']}/cancel").json()
    assert s["job"]["status"] == "cancelled"
    with reviews.lock:
        s = reviews.launch(s, "infer", lambda *args: {"id": "new", "notes": [note(pitch=80)]})
    s = await_job(client, s)
    release.set()
    time.sleep(.05)
    s = client.get(f"/api/youtube/reviews/{s['id']}").json()
    assert s["candidate"] == "new"
    assert "late" not in s["versions"]
    assert s["baseline"] == "v1"


def test_failure_preserves_accepted_and_manual_results(client):
    s = fixture_review(client)
    s = post(client, s, "edits", notes=[note(pitch=70)]).json()
    def fail(*args):
        raise RuntimeError("offline")
    with reviews.lock:
        s = reviews.launch(s, "infer", fail)
    s = await_job(client, s)
    assert s["job"]["status"] == "failed"
    assert reviews.active_notes(s)[0]["pitch"] == 70


def test_passage_cannot_be_imported(client):
    s = fixture_review(client, full=False)
    assert post(client, s, "prepare").status_code == 409
    assert post(client, s, "confirm", title="No partials", reviewed=True).status_code == 409


def midi_with_offset():
    midi = mido.MidiFile(ticks_per_beat=480)
    track = mido.MidiTrack()
    midi.tracks.append(track)
    track.append(mido.MetaMessage("set_tempo", tempo=500000))
    track.append(mido.MetaMessage("time_signature", numerator=4, denominator=4))
    track.append(mido.MetaMessage("marker", text="muscriptor:bar_offset=0.5"))
    track.append(mido.Message("note_on", note=60, velocity=100, time=1440))
    track.append(mido.Message("note_off", note=60, time=960))
    stream = BytesIO()
    midi.save(file=stream)
    return stream.getvalue()


def test_export_alignment_and_confirmed_structured_import(client):
    s = fixture_review(client)
    data = midi_with_offset()
    notes, offset = reviews.read_export(data)
    assert offset == .5
    assert notes[0]["start"] == 1
    assert notes[0]["end"] == 2
    (reviews.folder(s["id"]) / "prepared.mid").write_bytes(data)
    s["prepared"] = {"id": "prepared", "fingerprint": reviews.fingerprint(s), "source_offset": offset}
    reviews.save(s)
    response = post(client, s, "confirm", title="Reviewed performance", reviewed=True)
    assert response.status_code == 200, response.text
    song = response.json()
    assert song["state"]["practice_route"] == "structured"
    assert song["metadata"]["note_count"] == 1
    assert "bar-alignment padding: 0.500000" in song["context_text"]
    assert client.get(f"/api/songs/{song['id']}/bars").status_code == 200
    assert client.get(f"/api/songs/{song['id']}/events").json()[0]["time"] == 1.5
    assert post(client, s, "confirm", title="Reviewed performance", reviewed=True).json()["id"] == song["id"]
    assert len(client.get("/api/songs").json()) == 1


def test_prepare_result_invalidated_by_concurrent_edit(client):
    s = fixture_review(client)
    release = threading.Event()
    def prepare(snapshot, *args):
        release.wait(3)
        return {"fingerprint": reviews.fingerprint(snapshot)}
    with reviews.lock:
        s = reviews.launch(s, "prepare", prepare)
    s = post(client, s, "edits", notes=[note(pitch=66)]).json()
    release.set()
    s = await_job(client,s)
    assert s["job"]["status"] == "stale"
    assert s["prepared"] is None


def test_inference_cache_keys_and_real_ffmpeg_crop(client, monkeypatch):
    s = fixture_review(client)
    source = reviews.root() / "sources" / s["video_id"]
    source.mkdir(parents=True)
    with wave.open(str(source / "playback.wav"), "w") as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(8000)
        wav.writeframes(b"\0\0" * 30 * 8000)
    calls = []
    class Worker:
        def request(self, req, *args):
            calls.append(req["op"])
            if req["op"] == "identity": return {"code": "pinned", "weights_revision": "abc"}
            with wave.open(req["audio"]) as crop:
                assert crop.getframerate() == 16000
                assert crop.getnframes() / crop.getframerate() == 20
            return {"notes": [note("a", 5, 8)], "grid": None}
    monkeypatch.setattr(reviews, "worker", Worker())
    first = reviews.infer(s, threading.Event(), lambda _:None, False)
    second = reviews.infer(s, threading.Event(), lambda _:None, False)
    assert first["notes"][0]["start"] == 5
    assert second["cached"]
    assert calls.count("infer") == 1
    assert first["cache_key"] == second["cache_key"]
    s["settings"]["beam_size"] = 2
    third = reviews.infer(s, threading.Event(), lambda _:None, False)
    assert third["cache_key"] != second["cache_key"]
    assert calls.count("infer") == 2


def test_restart_marks_abandoned_job_interrupted(client):
    s = fixture_review(client)
    s["job"] = {"id": "gone", "status": "running"}
    reviews.save(s)
    assert client.get(f"/api/youtube/reviews/{s['id']}").json()["job"]["status"] == "interrupted"


def test_local_weights_use_content_identity_without_hub_access(tmp_path, monkeypatch):
    from backend.transcription.worker import resolve_weights
    monkeypatch.setenv("MUSCRIPTOR_WEIGHTS_DIR", str(tmp_path))
    checkpoint = tmp_path / "muscriptor-small.safetensors"
    checkpoint.write_bytes(b"first checkpoint")
    path, first, origin = resolve_weights("small")
    assert path == checkpoint
    assert origin == "local"
    assert first.startswith("sha256:")
    checkpoint.write_bytes(b"replacement checkpoint")
    assert resolve_weights("small")[1] != first


def test_real_worker_exports_without_model_weights(tmp_path):
    import subprocess
    from pathlib import Path
    python = Path(__file__).resolve().parents[2] / ".venv-muscriptor/bin/python"
    if not python.exists():
        pytest.skip("Optional MuScriptor environment is not installed")
    request = {"op": "export", "notes": [note(start=1.03, end=1.49)],
               "grid": {"bpm": 120, "beats_per_bar": 4, "first_downbeat": .5, "steady": True, "onset_delay": .025},
               "practice": {"quantize": False}, "output": str(tmp_path / "practice.mid")}
    result = subprocess.run([str(python), str(Path(reviews.__file__).with_name("worker.py"))],
                            input=json.dumps(request)+"\n", text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert "result" in json.loads(result.stdout), result.stdout
    notes, offset = reviews.read_export((tmp_path / "practice.mid").read_bytes())
    assert offset == 1.5
    assert notes[0]["start"] == pytest.approx(1.03, abs=.002)
    assert notes[0]["end"] == pytest.approx(1.49, abs=.002)


def test_real_worker_variable_grid_and_quantization_are_separate(tmp_path):
    import subprocess
    from pathlib import Path
    python = Path(__file__).resolve().parents[2] / ".venv-muscriptor/bin/python"
    if not python.exists():
        pytest.skip("Optional MuScriptor environment is not installed")
    original = [note("a", .61, 1.07), note("b", 1.35, 2.41, 64)]
    grid = {"bpm": 100, "beats_per_bar": 4, "first_downbeat": .5, "steady": False,
            "onset_delay": .025, "beats": [0, .5, 1, 1.7, 2.5, 3.1, 3.8, 4.6], "beat_subdivision": 4}
    requests = []
    for name, options in [("faithful", {}), ("grid", {"beats_per_bar": 3, "first_downbeat": 1.7}),
                          ("quantized", {"quantize": True, "subdivision": 4})]:
        requests.append({"op": "export", "notes": original, "grid": grid, "practice": options,
                         "output": str(tmp_path / f"{name}.mid")})
    result = subprocess.run([str(python), str(Path(reviews.__file__).with_name("worker.py"))],
                            input="\n".join(json.dumps(r) for r in requests)+"\n", text=True, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr
    assert all("result" in json.loads(line) for line in result.stdout.splitlines()), result.stdout
    for name in ["faithful", "grid"]:
        data = (tmp_path / f"{name}.mid").read_bytes()
        exported, _ = reviews.read_export(data)
        for actual, expected in zip(exported, original):
            assert actual["start"] == pytest.approx(expected["start"], abs=.003)
            assert actual["end"] == pytest.approx(expected["end"], abs=.003)
        midi = mido.MidiFile(file=BytesIO(data))
        assert sum(m.type == "set_tempo" for t in midi.tracks for m in t) > 1
    quantized, _ = reviews.read_export((tmp_path / "quantized.mid").read_bytes())
    assert any(abs(n["start"]-o["start"]) > .01 for n, o in zip(quantized, original))
    assert original[0]["start"] == .61


def test_inference_choices_do_not_invalidate_prepared_accepted_notes(client):
    s = fixture_review(client)
    s["prepared"] = {"id": "ready", "fingerprint": reviews.fingerprint(s)}
    reviews.save(s)
    config = {"revision": s["revision"], "passage": {"start": 1, "end": 4},
              "settings": {**s["settings"], "beam_size": 2}, "practice": s["practice"]}
    response = client.put(f"/api/youtube/reviews/{s['id']}/configuration", json=config)
    assert response.status_code == 200
    s = response.json()
    assert s["prepared"]["id"] == "ready"
    s = post(client, s, "edits", notes=[note(pitch=62)]).json()
    assert s["prepared"] is None
