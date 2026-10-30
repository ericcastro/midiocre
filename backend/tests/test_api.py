from __future__ import annotations

from io import BytesIO
import json

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


def make_musescore_multinstrument_midi() -> bytes:
    midi = mido.MidiFile(ticks_per_beat=480)
    vocals = mido.MidiTrack()
    vocals.name = "Vocals\x00"
    vocals.append(mido.Message("program_change", channel=1, program=66, time=0))
    vocals.append(mido.Message("note_on", channel=1, note=67, velocity=80, time=0))
    vocals.append(mido.Message("note_off", channel=1, note=67, velocity=0, time=480))

    piano_right = mido.MidiTrack()
    piano_right.name = "Piano\x00"
    piano_right.append(mido.Message("program_change", channel=0, program=0, time=0))
    for pitch in (72, 76):
        piano_right.append(mido.Message("note_on", channel=0, note=pitch, velocity=84, time=0))
        piano_right.append(mido.Message("note_off", channel=0, note=pitch, velocity=0, time=480))

    piano_left = mido.MidiTrack()
    piano_left.name = "Piano\x00"
    for pitch in (48, 43):
        piano_left.append(mido.Message("note_on", channel=0, note=pitch, velocity=72, time=0))
        piano_left.append(mido.Message("note_off", channel=0, note=pitch, velocity=0, time=480))

    midi.tracks.extend([vocals, piano_right, piano_left])
    output = BytesIO()
    midi.save(file=output)
    return output.getvalue()


def test_upload_resume_and_delete(tmp_path, monkeypatch):
    monkeypatch.setenv("CADENCE_DATA_DIR", str(tmp_path))
    from backend import db
    import backend.main as main

    db.DATA_DIR = tmp_path
    db.MIDI_DIR = tmp_path / "midi"
    db.DB_PATH = tmp_path / "cadence.sqlite3"
    main.MIDI_DIR = db.MIDI_DIR
    app = main.app

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


def test_multinstrument_import_selects_piano_and_preserves_its_staves(tmp_path, monkeypatch):
    monkeypatch.setenv("CADENCE_DATA_DIR", str(tmp_path))
    from backend import db
    import backend.main as main

    db.DATA_DIR = tmp_path
    db.MIDI_DIR = tmp_path / "midi"
    db.DB_PATH = tmp_path / "cadence.sqlite3"
    main.MIDI_DIR = db.MIDI_DIR
    app = main.app

    midi_data = make_musescore_multinstrument_midi()
    with TestClient(app) as client:
        inspected = client.post(
            "/api/midi/inspect",
            files={"file": ("arrangement.mid", midi_data, "audio/midi")},
        )
        assert inspected.status_code == 200
        tracks = inspected.json()["tracks"]
        assert [track["name"] for track in tracks] == ["Vocals", "Piano", "Piano"]
        assert [track["instrument_id"] for track in tracks] == ["vocals", "piano", "piano"]
        assert [track["default_selected"] for track in tracks] == [False, True, True]
        assert [track["suggested_assignment"] for track in tracks] == ["right", "right", "left"]

        assignments = {"0": "ignore", "1": "right", "2": "left"}
        uploaded = client.post(
            "/api/songs",
            files={"file": ("arrangement.mid", midi_data, "audio/midi")},
            data={"track_assignments": json.dumps(assignments)},
        )
        assert uploaded.status_code == 201
        song = uploaded.json()
        assert song["state"]["track_assignments"] == assignments
        events = client.get(f"/api/songs/{song['id']}/events").json()
        assert {event["track_index"] for event in events} == {1, 2}
        assert {event["hand"] for event in events if event["track_index"] == 1} == {"right"}
        assert {event["hand"] for event in events if event["track_index"] == 2} == {"left"}

        legacy_metadata = song["metadata"]
        for track in legacy_metadata["tracks"]:
            for key in ("instrument_id", "instrument_name", "is_piano", "default_selected"):
                track.pop(key)
            track["suggested_assignment"] = "split"
        legacy_state = song["state"]
        legacy_state["track_assignments"] = {"0": "split", "1": "split", "2": "split"}
        with db.connect() as connection:
            connection.execute(
                "UPDATE songs SET metadata_json = ? WHERE id = ?",
                (json.dumps(legacy_metadata), song["id"]),
            )
            connection.execute(
                "UPDATE song_state SET state_json = ? WHERE song_id = ?",
                (json.dumps(legacy_state), song["id"]),
            )

        migrated = client.get(f"/api/songs/{song['id']}").json()
        assert migrated["state"]["track_assignments"] == assignments
        assert migrated["metadata"]["tracks"][0]["instrument_id"] == "vocals"
