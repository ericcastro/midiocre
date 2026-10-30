from __future__ import annotations

import hashlib
import json
import math
import re
import statistics
from collections import defaultdict
from dataclasses import dataclass
from io import BytesIO
from typing import Any

import mido

from .schemas import BarTiming, MidiEvent, SongMetadata, TrackSummary


NOTE_NAMES = ("C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B")


def _clean_track_name(name: str, fallback: str) -> str:
    return name.replace("\x00", "").strip() or fallback


def _instrument_identity(track_name: str, programs: list[int]) -> tuple[str, str, bool]:
    """Group staves that belong to the same playable part.

    MuseScore commonly exports a grand staff as two same-named MIDI tracks. The
    track name is more useful than the General MIDI program for arrangements
    whose sound choice is decorative (the supplied "Vocals" staff uses program
    66, for example), so names take precedence here.
    """
    lowered = track_name.lower()
    if re.search(r"\b(piano|keyboard|grand|rh|lh|right hand|left hand)\b", lowered):
        return "piano", "Piano", True
    if re.search(r"\b(vocal|vocals|voice|choir|singer)\b", lowered):
        return "vocals", "Vocals", False

    if programs and programs[0] in range(0, 8):
        return "piano", "Piano", True

    base_name = re.sub(
        r"\b(left|right|lh|rh|treble|bass|staff|part)\b",
        " ",
        track_name,
        flags=re.IGNORECASE,
    )
    base_name = re.sub(r"\s+", " ", base_name).strip(" -_()") or track_name
    instrument_id = re.sub(r"[^a-z0-9]+", "-", base_name.lower()).strip("-")
    return instrument_id or "instrument", base_name, False


@dataclass
class ParsedNote:
    pitch: int
    velocity: int
    start_tick: int
    end_tick: int
    start_seconds: float
    end_seconds: float
    track_index: int
    channel: int

    @property
    def duration_seconds(self) -> float:
        return max(0.01, self.end_seconds - self.start_seconds)


def pitch_name(pitch: int) -> str:
    return f"{NOTE_NAMES[pitch % 12]}{pitch // 12 - 1}"


def _tempo_events(midi: mido.MidiFile) -> list[tuple[int, int]]:
    absolute_tick = 0
    events: list[tuple[int, int]] = [(0, 500_000)]
    for message in mido.merge_tracks(midi.tracks):
        absolute_tick += message.time
        if message.type == "set_tempo":
            events.append((absolute_tick, message.tempo))
    events.sort(key=lambda item: item[0])
    deduped: list[tuple[int, int]] = []
    for tick, tempo in events:
        if deduped and deduped[-1][0] == tick:
            deduped[-1] = (tick, tempo)
        else:
            deduped.append((tick, tempo))
    return deduped


def _tick_converter(ppq: int, tempo_events: list[tuple[int, int]]):
    cumulative: list[tuple[int, float, int]] = []
    elapsed = 0.0
    previous_tick = tempo_events[0][0]
    previous_tempo = tempo_events[0][1]
    cumulative.append((previous_tick, elapsed, previous_tempo))
    for tick, tempo in tempo_events[1:]:
        elapsed += mido.tick2second(tick - previous_tick, ppq, previous_tempo)
        cumulative.append((tick, elapsed, tempo))
        previous_tick = tick
        previous_tempo = tempo

    def to_seconds(tick: int) -> float:
        selected = cumulative[0]
        for item in cumulative:
            if item[0] > tick:
                break
            selected = item
        start_tick, start_seconds, tempo = selected
        return start_seconds + mido.tick2second(tick - start_tick, ppq, tempo)

    return to_seconds


def parse_midi(data: bytes) -> tuple[mido.MidiFile, list[ParsedNote], SongMetadata]:
    try:
        midi = mido.MidiFile(file=BytesIO(data))
    except Exception as exc:
        raise ValueError("This file is not a readable Standard MIDI File.") from exc

    tempos = _tempo_events(midi)
    to_seconds = _tick_converter(midi.ticks_per_beat, tempos)
    notes: list[ParsedNote] = []
    track_summaries: list[TrackSummary] = []
    time_signature = (4, 4)
    key_signature: str | None = None

    for track_index, track in enumerate(midi.tracks):
        absolute_tick = 0
        track_name = _clean_track_name(track.name, f"Track {track_index + 1}")
        active: dict[tuple[int, int], list[tuple[int, int]]] = defaultdict(list)
        pitches: list[int] = []
        channels: list[int] = []
        programs: list[int] = []
        track_notes: list[ParsedNote] = []

        for message in track:
            absolute_tick += message.time
            if message.type == "time_signature" and track_index == 0:
                time_signature = (message.numerator, message.denominator)
            elif message.type == "key_signature" and key_signature is None:
                key_signature = message.key
            elif message.type == "program_change":
                programs.append(message.program)
            elif message.type == "note_on" and message.velocity > 0:
                active[(message.channel, message.note)].append((absolute_tick, message.velocity))
                pitches.append(message.note)
                channels.append(message.channel)
            elif message.type in {"note_off", "note_on"}:
                key = (message.channel, message.note)
                if active[key]:
                    start_tick, velocity = active[key].pop(0)
                    end_tick = max(absolute_tick, start_tick + 1)
                    track_notes.append(
                        ParsedNote(
                            pitch=message.note,
                            velocity=velocity,
                            start_tick=start_tick,
                            end_tick=end_tick,
                            start_seconds=to_seconds(start_tick),
                            end_seconds=to_seconds(end_tick),
                            track_index=track_index,
                            channel=message.channel,
                        )
                    )

        if not track_notes:
            continue
        notes.extend(track_notes)
        median_pitch = statistics.median(pitches)
        lowered_name = track_name.lower()
        if re.search(r"\b(lh|left|bass)\b", lowered_name):
            suggested = "left"
        elif re.search(r"\b(rh|right|melody|treble)\b", lowered_name):
            suggested = "right"
        else:
            suggested = "split"
        instrument_id, instrument_name, is_piano = _instrument_identity(
            track_name, programs
        )
        track_summaries.append(
            TrackSummary(
                index=track_index,
                name=track_name,
                instrument_id=instrument_id,
                instrument_name=instrument_name,
                is_piano=is_piano,
                channel=statistics.mode(channels) if channels else None,
                note_count=len(track_notes),
                min_pitch=min(pitches),
                max_pitch=max(pitches),
                median_pitch=float(median_pitch),
                suggested_assignment=suggested,
            )
        )

    if not notes:
        raise ValueError("The MIDI contains no playable notes.")

    instrument_groups: dict[str, list[TrackSummary]] = defaultdict(list)
    for track in track_summaries:
        instrument_groups[track.instrument_id].append(track)

    for group in instrument_groups.values():
        unassigned = [track for track in group if track.suggested_assignment == "split"]
        if len(group) == 2 and len(unassigned) == 2:
            ordered = sorted(group, key=lambda track: track.median_pitch)
            ordered[0].suggested_assignment = "left"
            ordered[1].suggested_assignment = "right"
        elif len(group) == 1 and not group[0].is_piano:
            group[0].suggested_assignment = "right"

    has_piano = any(track.is_piano for track in track_summaries)
    multiple_instruments = len(instrument_groups) > 1
    for track in track_summaries:
        track.default_selected = not (
            multiple_instruments and has_piano and not track.is_piano
        )

    notes.sort(
        key=lambda note: (
            note.start_tick,
            note.pitch,
            note.end_tick,
            note.track_index,
            note.channel,
        )
    )
    last_tick = max(note.end_tick for note in notes)
    numerator, denominator = time_signature
    ticks_per_bar = midi.ticks_per_beat * numerator * (4 / denominator)
    bars = max(1, math.ceil(last_tick / ticks_per_bar))
    duration = max(midi.length, max(note.end_seconds for note in notes))
    first_tempo = tempos[0][1]

    metadata = SongMetadata(
        duration_seconds=round(duration, 3),
        note_count=len(notes),
        track_count=len(track_summaries),
        ppq=midi.ticks_per_beat,
        tempo_bpm=round(mido.tempo2bpm(first_tempo), 2),
        time_signature=f"{numerator}/{denominator}",
        key_signature=key_signature,
        bars=bars,
        tracks=track_summaries,
    )
    return midi, notes, metadata


def resolve_midi_events(
    data: bytes,
    assignments: dict[str, str] | None = None,
    split_pitch: int = 60,
) -> tuple[list[MidiEvent], SongMetadata]:
    _midi, notes, metadata = parse_midi(data)
    numerator, denominator = (int(part) for part in metadata.time_signature.split("/"))
    ticks_per_bar = metadata.ppq * numerator * (4 / denominator)
    assignments = assignments or {
        str(track.index): track.suggested_assignment for track in metadata.tracks
    }

    def resolve_hand(note: ParsedNote, assignment: str) -> str:
        if assignment in {"left", "right"}:
            return assignment
        return "left" if note.pitch < split_pitch else "right"

    events: list[MidiEvent] = []
    for index, note in enumerate(notes, start=1):
        assignment = assignments.get(str(note.track_index), "split")
        if assignment == "ignore":
            continue
        events.append(
            MidiEvent(
                id=f"n-{index:06d}",
                midi=note.pitch,
                name=pitch_name(note.pitch),
                time=round(note.start_seconds, 6),
                duration=round(note.duration_seconds, 6),
                velocity=note.velocity,
                start_tick=note.start_tick,
                end_tick=note.end_tick,
                track_index=note.track_index,
                hand=resolve_hand(note, assignment),
                bar=int(note.start_tick // ticks_per_bar) + 1,
                beat_offset=round((note.start_tick % ticks_per_bar) / metadata.ppq, 3),
            )
        )
    return events, metadata


def resolve_bar_timings(data: bytes) -> list[BarTiming]:
    midi, _notes, metadata = parse_midi(data)
    numerator, denominator = (int(part) for part in metadata.time_signature.split("/"))
    ticks_per_bar = midi.ticks_per_beat * numerator * (4 / denominator)
    to_seconds = _tick_converter(midi.ticks_per_beat, _tempo_events(midi))
    timings: list[BarTiming] = []

    for bar_number in range(1, metadata.bars + 1):
        start_tick = round((bar_number - 1) * ticks_per_bar)
        end_tick = round(bar_number * ticks_per_bar)
        start_seconds = to_seconds(start_tick)
        nominal_end = to_seconds(end_tick)
        end_seconds = min(metadata.duration_seconds, nominal_end)
        if end_seconds <= start_seconds:
            end_seconds = min(
                metadata.duration_seconds,
                start_seconds + max(0.01, nominal_end - start_seconds),
            )
        timings.append(
            BarTiming(
                bar=bar_number,
                start_seconds=round(start_seconds, 6),
                end_seconds=round(end_seconds, 6),
                start_tick=start_tick,
                end_tick=end_tick,
            )
        )
    return timings


def build_symbolic_digest(
    data: bytes,
    assignments: dict[str, str] | None = None,
    split_pitch: int = 60,
) -> dict[str, Any]:
    events, metadata = resolve_midi_events(
        data,
        assignments=assignments,
        split_pitch=split_pitch,
    )
    numerator, denominator = (int(part) for part in metadata.time_signature.split("/"))
    ticks_per_bar = metadata.ppq * numerator * (4 / denominator)
    bars: dict[int, dict[str, Any]] = {}

    for event in events:
        bar_number = event.bar
        if bar_number not in bars:
            bars[bar_number] = {
                "bar": bar_number,
                "start_tick": int((bar_number - 1) * ticks_per_bar),
                "end_tick": int(bar_number * ticks_per_bar),
                "start_seconds": event.time,
                "end_seconds": round(event.time + event.duration, 3),
                "notes": [],
            }
        bar = bars[bar_number]
        bar["start_seconds"] = min(bar["start_seconds"], event.time)
        bar["end_seconds"] = max(bar["end_seconds"], round(event.time + event.duration, 3))
        bar["notes"].append(
            [
                event.id,
                event.beat_offset,
                event.name,
                event.duration,
                event.hand[0].upper(),
                event.velocity,
            ]
        )

    compact_bars: list[dict[str, Any]] = []
    fingerprints: dict[str, list[int]] = defaultdict(list)
    for bar_number, bar in sorted(bars.items()):
        bar_notes = bar.pop("notes")
        pitches = [item[2] for item in bar_notes]
        hands = [item[4] for item in bar_notes]
        fingerprint_raw = "|".join(
            f"{item[1]}:{re.sub(r'-?\d+$', '', item[2])}:{round(item[3], 1)}:{item[4]}"
            for item in bar_notes
        )
        fingerprint = hashlib.sha1(fingerprint_raw.encode()).hexdigest()[:8]
        fingerprints[fingerprint].append(bar_number)
        compact_bars.append(
            {
                **bar,
                "note_count": len(bar_notes),
                "hands": sorted(set(hands)),
                "lowest": min(pitches, key=lambda name: _pitch_from_name(name)),
                "highest": max(pitches, key=lambda name: _pitch_from_name(name)),
                "events": bar_notes,
                "fingerprint": fingerprint,
            }
        )

    repeats = [
        {"bars": positions, "fingerprint": fingerprint}
        for fingerprint, positions in fingerprints.items()
        if len(positions) > 1
    ]

    return {
        "metadata": metadata.model_dump(mode="json"),
        "event_format": [
            "event_id",
            "beat_offset",
            "pitch_name",
            "duration_seconds",
            "hand_initial",
            "velocity",
        ],
        "bars": compact_bars,
        "repeated_bar_patterns": repeats,
        "analysis_constraints": {
            "max_practice_units": 16,
            "preferred_unit_bars": "2-8",
            "event_reference_rule": (
                "Use event_id values exactly as supplied; never invent ids or pitch events."
            ),
            "hand_label_rule": (
                "In every event tuple, the fifth value is authoritative: L means left hand and R means right hand. "
                "Do not infer hand from pitch height. A left/right cue may reference only matching labels; mixed labels require hand=both."
            ),
            "player_profile": (
                "Adult self-taught player with good dexterity and hand independence, "
                "learns from a piano roll rather than notation, and wants concrete "
                "pattern-based instructions with minimal theory vocabulary."
            ),
        },
    }


def analysis_input_fingerprint(
    data: bytes,
    assignments: dict[str, str],
    split_pitch: int,
    song_title: str = "",
    context_text: str = "",
) -> str:
    mapping = json.dumps(
        {
            "assignments": assignments,
            "split_pitch": split_pitch,
            "digest_version": "1.1",
            "song_title": song_title,
            "context_text": context_text,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(data + b"\0" + mapping).hexdigest()[:20]


def _pitch_from_name(name: str) -> int:
    normalized = name.replace("♯", "#").replace("♭", "b")
    match = re.match(r"([A-G])([#b]?)(-?\d+)$", normalized)
    if not match:
        return 0
    note, accidental, octave = match.groups()
    base = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[note]
    base += {"#": 1, "b": -1, "": 0}[accidental]
    return (int(octave) + 1) * 12 + base
