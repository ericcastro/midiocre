export interface ReviewNote { id: string; pitch: number; start: number; end: number; instrument: string; boundary: boolean }
export interface Passage { start: number; end: number }
export interface InferenceSettings { model: "small" | "medium" | "large"; instruments: "piano" | "auto"; beam_size: 1 | 2 | 4 }
export interface PracticeSettings { bpm: number | null; beats_per_bar: number | null; first_downbeat: number | null; tempo_map: boolean | null; quantize: boolean; subdivision: 1 | 2 | 3 | 4 | 6 | 8; strength: number }
export interface BeatGrid { bpm: number; beats_per_bar: number | null; first_downbeat: number; beats: number[] | null; steady: boolean; onset_delay: number | null }
export interface ReviewVersion { id: string; notes: ReviewNote[]; grid: BeatGrid | null; full: boolean; passage: Passage; context: number[]; settings: InferenceSettings; identity: { code: string; package: string; model: string; weights_revision: string }; cached: boolean; processing_seconds: number; excluded: number }
export interface ReviewSession {
  id: string; revision: number; video_id: string;
  source: null | { title: string; url: string; duration: number; sample_rate: number; uploader: string; format: string };
  passage: Passage; settings: InferenceSettings; practice: PracticeSettings;
  versions: Record<string, ReviewVersion>; baseline: string | null; candidate: string | null;
  edits: { label: string; notes: ReviewNote[] }[]; edit_cursor: number;
  archives: { baseline: string; edits: { label: string; notes: ReviewNote[] }[]; edit_cursor: number }[];
  job: null | { id: string; kind: string; status: string; phase: string; elapsed: number; completed?: number; total?: number; error?: string };
  prepared: null | { id: string; notes: ReviewNote[]; source_offset: number; bars: { bar: number; start_seconds: number; end_seconds: number }[]; practice: PracticeSettings };
  imported_song_id?: string;
}
export function reviewedNotes(s: ReviewSession): ReviewNote[] { return s.edits.length ? s.edits[s.edit_cursor].notes : s.baseline ? s.versions[s.baseline].notes : []; }
export function hasCorrections(s: ReviewSession) { return !!s.baseline && JSON.stringify(reviewedNotes(s)) !== JSON.stringify(s.versions[s.baseline].notes); }
export type NoteMatch = { before?: ReviewNote; after?: ReviewNote; kind: "same" | "added" | "removed" | "timing" | "pitch" | "ambiguous" };

/** Mutual nearest matching, with an ambiguity margin. No forced chord/repeated-note pairings. */
export function matchNotes(before: ReviewNote[], after: ReviewNote[]): NoteMatch[] {
  const candidates: { a: number; b: number; cost: number }[] = [];
  const sorted = after.map((n, i) => ({ n, i })).sort((a, b) => a.n.start - b.n.start);
  for (let a = 0; a < before.length; a++) {
    const n = before[a];
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid].n.start < n.start - .25) lo = mid + 1; else hi = mid; }
    for (let k = lo; k < sorted.length && sorted[k].n.start <= n.start + .25; k++) {
      const { n: m, i: b } = sorted[k];
      const pitch = Math.abs(n.pitch - m.pitch), onset = Math.abs(n.start - m.start);
      if (n.instrument !== m.instrument || pitch > 2 || (pitch > 0 && onset > .08)) continue;
      candidates.push({ a, b, cost: onset * 4 + Math.min(.4, Math.abs(n.end - m.end)) + pitch * .25 });
    }
  }
  const byA = new Map<number, typeof candidates>(), byB = new Map<number, typeof candidates>();
  for (const c of candidates) { byA.set(c.a, [...(byA.get(c.a) || []), c]); byB.set(c.b, [...(byB.get(c.b) || []), c]); }
  for (const entries of [...byA.values(), ...byB.values()]) entries.sort((a, b) => a.cost - b.cost);
  const used = new Set<number>();
  const result: NoteMatch[] = before.map((n, a) => {
    const options = byA.get(a) || [], best = options[0];
    if (!best) return { before: n, kind: "removed" };
    const reverse = byB.get(best.b)!;
    const ambiguous = (options[1] && options[1].cost - best.cost < .06) || (reverse[1] && reverse[1].cost - reverse[0].cost < .06);
    if (reverse[0].a !== a || ambiguous) return { before: n, kind: "ambiguous" };
    used.add(best.b);
    const m = after[best.b];
    return { before: n, after: m, kind: n.pitch !== m.pitch ? "pitch" : Math.abs(n.start-m.start) > .025 || Math.abs(n.end-m.end) > .04 ? "timing" : "same" };
  });
  after.forEach((n, b) => { if (!used.has(b)) result.push({ after: n, kind: byB.has(b) ? "ambiguous" : "added" }); });
  return result;
}

export function mergeNotes(notes: ReviewNote[], selected: Set<string>): ReviewNote[] {
  const group = notes.filter(n => selected.has(n.id)).sort((a,b) => a.start-b.start);
  if (group.length < 2 || group.some(n => n.pitch !== group[0].pitch || n.instrument !== group[0].instrument)) throw new Error("Select at least two notes of the same pitch and instrument.");
  // Deliberately only on explicit Merge; never infer that repeated attacks are duplicates.
  const merged = { ...group[0], end: Math.max(...group.map(n => n.end)), boundary: group.some(n => n.boundary) };
  return [...notes.filter(n => !selected.has(n.id)), merged].sort((a,b) => a.start-b.start);
}

export function transportPosition(origin: number, elapsed: number, loop: Passage | null, duration: number) {
  const value = origin + Math.max(0, elapsed);
  if (!loop) return Math.min(duration, value);
  return value < loop.end ? value : loop.start + (value - loop.end) % (loop.end - loop.start);
}

/** Schedule in audio-clock seconds, including sustained notes at seeks and loop entry. */
export function auditionEvents(notes: ReviewNote[], origin: number, from: number, to: number, loop: Passage | null, duration: number) {
  const events: { pitch: number; at: number; duration: number }[] = [];
  const firstEnd = (loop?.end ?? duration) - origin;
  const length = loop ? loop.end-loop.start : 0;
  const firstCycle = !loop || from < firstEnd ? 0 : 1 + Math.floor((from-firstEnd)/length);
  const lastCycle = !loop || to < firstEnd ? 0 : 1 + Math.floor((to-firstEnd)/length);
  for (let cycle = firstCycle; cycle <= lastCycle; cycle++) {
    const base = cycle === 0 ? 0 : firstEnd + (cycle-1)*length;
    const start = cycle === 0 ? origin : loop!.start, end = loop?.end ?? duration;
    for (const n of notes) {
      if (n.end <= start || n.start >= end) continue;
      const at = base + Math.max(n.start, start)-start;
      if (at >= from && at < to) events.push({ pitch: n.pitch, at, duration: Math.min(n.end,end)-Math.max(n.start,start) });
    }
  }
  return events;
}
