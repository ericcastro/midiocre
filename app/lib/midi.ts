import type { MidiEventResponse, MidiNote } from "./types";

type ChromaticPitchClasses = readonly [
  string, string, string, string, string, string,
  string, string, string, string, string, string,
];

const DISPLAY_NOTE_NAMES: ChromaticPitchClasses = [
  "C",
  "C♯",
  "D",
  "E♭",
  "E",
  "F",
  "F♯",
  "G",
  "A♭",
  "A",
  "B♭",
  "B",
];

const TONE_NOTE_NAMES: ChromaticPitchClasses = [
  "C",
  "C#",
  "D",
  "Eb",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "Bb",
  "B",
];

export function normalizedEventsToPlayerNotes(
  events: MidiEventResponse[],
): MidiNote[] {
  return events.map((event) => ({
    id: event.id,
    midi: event.midi,
    name: event.name,
    time: event.time,
    duration: Math.max(0.03, event.duration),
    velocity: event.velocity / 127,
    trackIndex: event.track_index,
    hand: event.hand,
    startTick: event.start_tick,
    endTick: event.end_tick,
    bar: event.bar,
    beatOffset: event.beat_offset,
  }));
}

export function midiNoteName(pitch: number): string {
  return `${DISPLAY_NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}

/** Tone.js expects ASCII accidentals, while the UI intentionally uses ♯ and ♭. */
export function toneNoteName(midi: number): string | null {
  if (!Number.isInteger(midi) || midi < 0 || midi > 127) return null;
  return `${TONE_NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}
