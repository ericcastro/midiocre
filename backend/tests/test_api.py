from __future__ import annotations

from io import BytesIO

import mido
from fastapi.testclient import TestClient


def make_test_midi() -> bytes:
    midi = mido.MidiFile(ticks_per_beat=480)
    right = mido.MidiTrack()
    right.name = "Right Hand"
    right.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(96), time=0))
    for pitch in (60, 64, 67, 72):
        right.append(mido.Message("note_on", note=pitch, velocity=84, time=0))
        right.append(mido.Message("note_off", note=pitch, velocity=0, time=480))
    left = mido.MidiTrack()
    left.name = "Left Hand"
    for pitch in (48, 43, 45, 41):
        left.append(mido.Message("note_on", note=pitch, velocity=72, time=0))
        left.append(mido.Message("note_off", note=pitch, velocity=0, time=480))
    midi.tracks.extend([right, left])
    output = BytesIO()
    midi.save(file=output)
    return output.getvalue()


def test_upload_resume_and_delete(tmp_path, monkeypatch):
    monkeypatch.setenv("CADENCE_DATA_DIR", str(tmp_path))
    from backend import db
    from backend.main import app

    db.DATA_DIR = tmp_path
    db.MIDI_DIR = tmp_path / "midi"
    db.DB_PATH = tmp_path / "cadence.sqlite3"

    with TestClient(app) as client:
        response = client.post(
            "/api/songs",
            files={"file": ("practice.mid", make_test_midi(), "audio/midi")},
        )
        assert response.status_code == 201
        song = response.json()
        assert song["metadata"]["note_count"] == 8
        assert song["metadata"]["tracks"][0]["suggested_assignment"] == "right"
        assert song["metadata"]["tracks"][1]["suggested_assignment"] == "left"

        state = song["state"]
        state["position_seconds"] = 1.25
        state["hand_mode"] = "left"
        saved = client.put(f"/api/songs/{song['id']}/state", json=state)
        assert saved.status_code == 200

        resumed = client.get(f"/api/songs/{song['id']}").json()
        assert resumed["state"]["position_seconds"] == 1.25
        assert resumed["state"]["hand_mode"] == "left"

        deleted = client.delete(f"/api/songs/{song['id']}")
        assert deleted.status_code == 204
        assert client.get("/api/songs").json() == []
