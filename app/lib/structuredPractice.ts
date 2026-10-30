import type { BarTiming, PracticeUnit } from "./types";

export const STRUCTURED_BARS_PER_SECTION = 4;

/**
 * Build a useful practice map directly from the MIDI timeline. These units are
 * intentionally free of musical interpretation: the StructuredPractice UI
 * adds the bar-by-bar and connection exercises without requiring AI output.
 */
export function buildStructuredPracticeUnits(
  bars: BarTiming[],
): PracticeUnit[] {
  const chronological = [...bars].sort((a, b) => a.bar - b.bar);
  const units: PracticeUnit[] = [];

  for (
    let index = 0;
    index < chronological.length;
    index += STRUCTURED_BARS_PER_SECTION
  ) {
    const sectionBars = chronological.slice(
      index,
      index + STRUCTURED_BARS_PER_SECTION,
    );
    const first = sectionBars[0];
    const last = sectionBars.at(-1);
    if (!first || !last) continue;

    units.push({
      id: `midi-bars-${first.bar}-${last.bar}`,
      title:
        first.bar === last.bar
          ? `Bar ${first.bar}`
          : `${sectionBars.length}-bar block`,
      timing: {
        start_seconds: first.start_seconds,
        end_seconds: last.end_seconds,
        start_tick: first.start_tick,
        end_tick: last.end_tick,
        start_bar: first.bar,
        end_bar: last.bar,
      },
      hands: ["both"],
      difficulty: 1,
      challenge_reason: "This section comes directly from the MIDI timeline.",
      focus: "Learn each bar, then connect adjacent bars.",
      pattern_summary: "Chronological MIDI practice block",
      landmarks: [],
      cues: [],
      steps: [],
      success_criteria: [],
      common_traps: [],
    });
  }

  return units;
}
