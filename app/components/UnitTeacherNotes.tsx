"use client";

import type { MidiNote, PracticeUnit } from "../lib/types";
import { PracticeCue } from "./PracticeCue";

interface UnitTeacherNotesProps {
  unit: PracticeUnit;
  eventMap: Map<string, MidiNote>;
  transientCueId: string | null;
  pinnedCueIds: Set<string>;
  onHighlight: (id: string, ids: string[]) => void;
  onClear: () => void;
  onPreview: (ids: string[]) => void;
  onPin: (id: string, ids: string[]) => void;
}

export function UnitTeacherNotes({
  unit,
  eventMap,
  transientCueId,
  pinnedCueIds,
  onHighlight,
  onClear,
  onPreview,
  onPin,
}: UnitTeacherNotesProps) {
  return (
    <>
      <p className="unit-focus">{unit.focus}</p>
      <p className="pattern-note">{unit.pattern_summary}</p>
      <div className="challenge-reason">
        <strong>Challenge {unit.difficulty}/5 · Why this matters:</strong>{" "}
        {unit.challenge_reason}
      </div>
      {unit.landmarks.length > 0 && (
        <div className="landmark-list">
          <span className="card-kicker">Landmarks</span>
          {unit.landmarks.map((landmark) => (
            <PracticeCue
              key={landmark.id}
              cue={{ ...landmark, text: landmark.text }}
              eventMap={eventMap}
              highlighted={
                transientCueId === landmark.id || pinnedCueIds.has(landmark.id)
              }
              pinned={pinnedCueIds.has(landmark.id)}
              onHighlight={onHighlight}
              onClear={onClear}
              onPreview={onPreview}
              onPin={onPin}
            />
          ))}
        </div>
      )}
      <div className="tip-list">
        {unit.cues.map((cue) => (
          <PracticeCue
            key={cue.id}
            cue={cue}
            eventMap={eventMap}
            highlighted={transientCueId === cue.id || pinnedCueIds.has(cue.id)}
            pinned={pinnedCueIds.has(cue.id)}
            onHighlight={onHighlight}
            onClear={onClear}
            onPreview={onPreview}
            onPin={onPin}
          />
        ))}
      </div>
      <div className="practice-steps">
        <span className="card-kicker">Practice recipe</span>
        {unit.steps.map((step, index) => {
          const cueId = `step:${unit.id}:${index}`;
          return (
            <div className="practice-step" key={`${unit.id}-${index}`}>
              <span>{index + 1}</span>
              <PracticeCue
                cue={{
                  id: cueId,
                  hand: step.hand_mode,
                  text: step.instruction,
                  event_refs: step.event_refs,
                }}
                eventMap={eventMap}
                highlighted={
                  transientCueId === cueId || pinnedCueIds.has(cueId)
                }
                pinned={pinnedCueIds.has(cueId)}
                onHighlight={onHighlight}
                onClear={onClear}
                onPreview={onPreview}
                onPin={onPin}
              />
              <small>
                {step.hand_mode} · {step.tempo_percent}% · {step.repetitions}×
              </small>
            </div>
          );
        })}
      </div>
      <div className="success-box">
        <span>Ready to move on when</span>
        {unit.success_criteria.map((criterion) => (
          <p key={criterion}>✓ {criterion}</p>
        ))}
      </div>
    </>
  );
}
