from __future__ import annotations

from copy import deepcopy
from io import BytesIO

import mido
import pytest
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


def configure_app(tmp_path):
    from backend import db
    import backend.main as main

    db.DATA_DIR = tmp_path
    db.MIDI_DIR = tmp_path / "midi"
    db.DB_PATH = tmp_path / "cadence.sqlite3"
    main.MIDI_DIR = db.MIDI_DIR
    return main


def upload(client: TestClient, *, title: str = "Practice", context: str = "") -> dict:
    response = client.post(
        "/api/songs",
        files={"file": ("practice.mid", make_test_midi(), "audio/midi")},
        data={"title": title, "context_text": context},
    )
    assert response.status_code == 201, response.text
    return response.json()


def valid_analysis() -> dict:
    def unit(unit_id: str, start_seconds: float, end_seconds: float, start_tick: int, end_tick: int, refs: list[str]) -> dict:
        return {
            "id": unit_id,
            "title": f"Unit {unit_id}",
            "timing": {
                "start_seconds": start_seconds,
                "end_seconds": end_seconds,
                "start_tick": start_tick,
                "end_tick": end_tick,
                "start_bar": 1,
                "end_bar": 1,
            },
            "hands": ["left", "right"],
            "difficulty": 3,
            "challenge_reason": "The hands alternate roles at each landing.",
            "focus": "Keep both shapes relaxed while the melody moves.",
            "pattern_summary": "A repeating low anchor supports a stepwise upper line.",
            "landmarks": [{
                "id": f"{unit_id}-landmark",
                "label": "Anchor shape",
                "hand": "left",
                "text": "Use the low anchor as your visual starting point.",
                "event_refs": refs[:2],
            }],
            "cues": [
                {
                    "id": f"{unit_id}-cue-left",
                    "hand": "left",
                    "text": "Reuse this low shape before moving upward.",
                    "event_refs": refs[:2],
                },
                {
                    "id": f"{unit_id}-cue-both",
                    "hand": "both",
                    "text": "Land both hands together after the short gap.",
                    "event_refs": refs,
                },
            ],
            "steps": [
                {
                    "instruction": "Play the left hand shape alone, then pause.",
                    "hand_mode": "left",
                    "tempo_percent": 55,
                    "repetitions": 3,
                    "event_refs": refs[:2],
                },
                {
                    "instruction": "Add both hands and keep the landing together.",
                    "hand_mode": "both",
                    "tempo_percent": 65,
                    "repetitions": 4,
                    "event_refs": refs,
                },
            ],
            "success_criteria": ["Three clean repetitions without a timing wobble."],
            "common_traps": ["Rushing the second landing."],
        }

    return {
        "schema_version": "1.1",
        "title": "Practice",
        "overview": "This map starts with the opening shape and then isolates the coordination change.",
        "musical_character": {
            "summary": "A steady, repeating texture with clear low and high hand roles.",
            "style_hint": "dance-like",
            "confidence": "low",
            "basis": "midi",
            "evidence": ["Repeated low anchors and stepwise upper notes."],
            "practice_implications": ["Keep the low hand economical while the top line moves."],
        },
        "player_strategy": ["Start with the opening anchor.", "Recombine hands only after each landing feels automatic."],
        "routes": [
            {"id": "balanced", "title": "Balanced", "rationale": "Begin chronologically, then build toward the harder landing.", "unit_ids": ["u1", "u2"]},
            {"id": "challenge", "title": "Challenge", "rationale": "Start with the coordination bottleneck for faster payoff.", "unit_ids": ["u2", "u1"]},
        ],
        "practice_units": [
            unit("u1", 0.0, 1.0, 0, 960, ["n-000001", "n-000003", "n-000002"]),
            unit("u2", 1.0, 2.1, 960, 1920, ["n-000005", "n-000007", "n-000006"]),
        ],
        "assumptions": [],
    }


def test_context_events_fingerprint_and_mapping_are_stable(tmp_path):
    main = configure_app(tmp_path)
    with TestClient(main.app) as client:
        song = upload(client, title="Etude sketch", context="A gentle tango-like study")
        assert song["title"] == "Etude sketch"
        assert song["context_text"] == "A gentle tango-like study"

        events = client.get(f"/api/songs/{song['id']}/events").json()
        repeated = client.get(f"/api/songs/{song['id']}/events").json()
        assert events == repeated
        assert len({event["id"] for event in events}) == len(events)
        assert events[0]["id"] == "n-000001"
        bars = client.get(f"/api/songs/{song['id']}/bars").json()
        assert bars == [{
            "bar": 1,
            "start_seconds": 0.0,
            "end_seconds": 2.5,
            "start_tick": 0,
            "end_tick": 1920,
        }]

        from backend.midi_analysis import analysis_input_fingerprint, build_symbolic_digest
        from backend import db

        state = song["state"]
        before = analysis_input_fingerprint(
            (tmp_path / "midi" / f"{song['id']}.mid").read_bytes(),
            state["track_assignments"],
            state["split_pitch"],
            song["title"],
            song["context_text"],
        )
        changed = client.put(
            f"/api/songs/{song['id']}/context",
            json={"title": song["title"], "context_text": "A dark tango-like study"},
        )
        assert changed.status_code == 200
        assert changed.json()["analysis"] is None
        after = analysis_input_fingerprint(
            (tmp_path / "midi" / f"{song['id']}.mid").read_bytes(),
            state["track_assignments"],
            state["split_pitch"],
            song["title"],
            "A dark tango-like study",
        )
        assert before != after

        state["track_assignments"]["1"] = "right"
        assert client.put(f"/api/songs/{song['id']}/state", json=state).status_code == 200
        remapped = client.get(f"/api/songs/{song['id']}/events").json()
        assert [event["id"] for event in remapped] == [event["id"] for event in events]
        assert [event["hand"] for event in remapped] != [event["hand"] for event in events]
        digest = build_symbolic_digest(
            (tmp_path / "midi" / f"{song['id']}.mid").read_bytes(),
            state["track_assignments"],
            state["split_pitch"],
        )
        assert [item[0] for bar in digest["bars"] for item in bar["events"]] == [event["id"] for event in remapped]

        schema = client.get("/api/analysis/schema").json()
        assert schema["properties"]["schema_version"]["const"] == "1.1"
        assert "routes" in schema["properties"]
        assert "musical_character" in schema["properties"]


def test_context_edit_and_old_state_defaults(tmp_path):
    main = configure_app(tmp_path)
    with TestClient(main.app) as client:
        song = upload(client)
        old_state = song["state"]
        for field in (
            "practice_route",
            "roll_zoom",
            "note_visibility",
            "completed_structured_step_ids",
            "selected_structured_step_id",
            "metronome_enabled",
            "loop_delay_enabled",
            "loop_delay_beats",
            "loop_timing_offset_ms",
            "roll_horizontal_zoom",
            "roll_horizontal_pan",
        ):
            old_state.pop(field)
        response = client.put(f"/api/songs/{song['id']}/state", json=old_state)
        assert response.status_code == 200
        state = response.json()
        assert state["practice_route"] == "balanced"
        assert state["completed_structured_step_ids"] == []
        assert state["selected_structured_step_id"] is None
        assert state["roll_zoom"] == 1
        assert state["note_visibility"] == "enhanced"
        assert state["metronome_enabled"] is False
        assert state["loop_delay_enabled"] is False
        assert state["loop_delay_beats"] is None
        assert state["loop_timing_offset_ms"] == 0
        assert state["roll_horizontal_zoom"] == 1
        assert state["roll_horizontal_pan"] == 0.5

        legacy_state = {**state}
        legacy_state.pop("loop_timing_offset_ms")
        legacy_state["loop_end_trim_ms"] = 80
        migrated = client.put(f"/api/songs/{song['id']}/state", json=legacy_state)
        assert migrated.status_code == 200
        state = migrated.json()
        assert state["loop_timing_offset_ms"] == -80

        state["practice_route"] = "structured"
        state["completed_structured_step_ids"] = ["structured:u1:bar:1"]
        state["selected_structured_step_id"] = "structured:u1:connect:1-2"
        state["metronome_enabled"] = True
        state["loop_delay_enabled"] = True
        state["loop_delay_beats"] = 3
        state["loop_timing_offset_ms"] = 80
        state["roll_horizontal_zoom"] = 1.7
        state["roll_horizontal_pan"] = 0.35
        saved = client.put(f"/api/songs/{song['id']}/state", json=state)
        assert saved.status_code == 200
        reopened_state = client.get(f"/api/songs/{song['id']}").json()["state"]
        assert reopened_state["practice_route"] == "structured"
        assert reopened_state["completed_structured_step_ids"] == [
            "structured:u1:bar:1"
        ]
        assert (
            reopened_state["selected_structured_step_id"]
            == "structured:u1:connect:1-2"
        )
        assert reopened_state["metronome_enabled"] is True
        assert reopened_state["loop_delay_enabled"] is True
        assert reopened_state["loop_delay_beats"] == 3
        assert reopened_state["loop_timing_offset_ms"] == 80
        assert reopened_state["roll_horizontal_zoom"] == 1.7
        assert reopened_state["roll_horizontal_pan"] == 0.35

        edited = client.put(
            f"/api/songs/{song['id']}/context",
            json={"title": "Renamed piece", "context_text": "Use a light, grounded tango pulse."},
        )
        assert edited.status_code == 200
        reopened = client.get(f"/api/songs/{song['id']}").json()
        assert reopened["title"] == "Renamed piece"
        assert reopened["context_text"] == "Use a light, grounded tango pulse."


def test_valid_provider_fixture_saves_and_invalid_reference_does_not(tmp_path, monkeypatch):
    main = configure_app(tmp_path)
    with TestClient(main.app) as client:
        song = upload(client)
        fixture = valid_analysis()
        monkeypatch.setattr(main, "analyze_with_openai", lambda **_kwargs: main.PieceAnalysis.model_validate(fixture))
        saved = client.post(
            f"/api/songs/{song['id']}/analyze",
            json={"provider": "openai", "model": "fixture", "reasoning_effort": "low"},
        )
        assert saved.status_code == 200, saved.text
        loaded = client.get(f"/api/songs/{song['id']}").json()
        assert loaded["analysis"]["schema_version"] == "1.1"
        assert loaded["analysis"]["routes"][0]["id"] == "balanced"

        invalid = deepcopy(fixture)
        invalid["practice_units"][0]["cues"][0]["event_refs"] = ["n-999999"]
        monkeypatch.setattr(main, "analyze_with_openai", lambda **_kwargs: main.PieceAnalysis.model_validate(invalid))
        rejected = client.post(
            f"/api/songs/{song['id']}/analyze",
            json={"provider": "openai", "model": "fixture", "reasoning_effort": "low"},
        )
        assert rejected.status_code == 502
        with main.connect() as db:
            assert db.execute("SELECT COUNT(*) AS count FROM analyses WHERE song_id = ?", (song["id"],)).fetchone()["count"] == 1


def test_route_validation_and_legacy_adapter(tmp_path):
    from backend.schemas import PieceAnalysis

    fixture = valid_analysis()
    bad = deepcopy(fixture)
    bad["routes"][0]["unit_ids"] = ["u1", "u1"]
    with pytest.raises(ValueError):
        PieceAnalysis.model_validate(bad)

    bad = deepcopy(fixture)
    bad["routes"][0]["unit_ids"] = ["u2", "u1"]
    with pytest.raises(ValueError):
        PieceAnalysis.model_validate(bad)

    bad = deepcopy(fixture)
    bad["routes"][0]["unit_ids"] = ["u1"]
    with pytest.raises(ValueError):
        PieceAnalysis.model_validate(bad)

    bad = deepcopy(fixture)
    bad["routes"][0]["unit_ids"] = ["u1", "u2", "unknown"]
    with pytest.raises(ValueError):
        PieceAnalysis.model_validate(bad)

    main = configure_app(tmp_path)
    with TestClient(main.app) as client:
        song = upload(client)
        legacy = {
            "schema_version": "1.0",
            "title": "Old map",
            "overview": "A previously saved map that should remain readable.",
            "player_strategy": ["Keep the hands separate at first.", "Then recombine slowly."],
            "practice_order": ["old-unit"],
            "practice_units": [{
                "id": "old-unit",
                "title": "Opening",
                "timing": {"start_seconds": 0, "end_seconds": 1, "start_tick": 0, "end_tick": 960, "start_bar": 1, "end_bar": 1},
                "hands": ["both"],
                "difficulty": 2,
                "focus": "Keep the opening together.",
                "pattern_summary": "A simple opening shape.",
                "tips": ["Use the opening shape as a landmark."],
                "steps": [{"instruction": "Play the opening three times.", "hand_mode": "both", "tempo_percent": 55, "repetitions": 3}],
                "success_criteria": ["Three even repetitions."],
                "common_traps": [],
            }],
            "assumptions": [],
        }
        from backend import db
        now = "2026-01-01T00:00:00+00:00"
        with db.connect() as connection:
            connection.execute(
                "INSERT INTO analyses(id, song_id, schema_version, provider, model, input_fingerprint, analysis_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("legacy", song["id"], "1.0", "fixture", "old", "old-fingerprint", db.dumps(legacy), now, now),
            )
        loaded = client.get(f"/api/songs/{song['id']}").json()
        assert loaded["analysis"]["legacy_analysis"] is True
        assert loaded["analysis"]["routes"][0]["id"] == "balanced"
        assert loaded["analysis"]["practice_units"][0]["landmarks"] == []
        assert loaded["analysis_is_stale"] is True


def test_private_lan_origin_is_allowed_for_tablet_use(tmp_path):
    main = configure_app(tmp_path)
    with TestClient(main.app) as client:
        response = client.options(
            "/api/health",
            headers={
                "Origin": "http://192.168.1.25:3001",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert response.status_code == 200
        assert (
            response.headers["access-control-allow-origin"]
            == "http://192.168.1.25:3001"
        )


def test_storage_repairs_midi_paths_after_the_project_moves(tmp_path):
    main = configure_app(tmp_path)
    with TestClient(main.app) as client:
        song = upload(client)
        from backend import db

        with db.connect() as connection:
            connection.execute(
                "UPDATE songs SET midi_path = ? WHERE id = ?",
                (
                    "/previous/location/data/midi/" + song["id"] + ".mid",
                    song["id"],
                ),
            )

        db.ensure_storage()
        with db.connect() as connection:
            repaired = connection.execute(
                "SELECT midi_path FROM songs WHERE id = ?", (song["id"],)
            ).fetchone()
        assert repaired["midi_path"] == str(tmp_path / "midi" / f"{song['id']}.mid")
