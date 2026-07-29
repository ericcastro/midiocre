"use client";

import { Pin } from "lucide-react";
import type { HandMode, MidiNote } from "../lib/types";

interface CueLike {
  id: string;
  hand: HandMode;
  text: string;
  event_refs: string[];
  label?: string;
}

interface PracticeCueProps {
  cue: CueLike;
  eventMap: Map<string, MidiNote>;
  highlighted: boolean;
  pinned: boolean;
  onHighlight: (id: string, ids: string[]) => void;
  onClear: () => void;
  onPreview: (ids: string[]) => void;
  onPin: (id: string, ids: string[]) => void;
}

function formatNoteGroups(cue: CueLike, eventMap: Map<string, MidiNote>) {
  const events = cue.event_refs
    .map((id) => eventMap.get(id))
    .filter((event): event is MidiNote => Boolean(event));
  if (!events.length) return null;
  const groups: MidiNote[][] = [];
  for (const event of events) {
    const current = groups[groups.length - 1];
    if (current && Math.abs(current[0].time - event.time) < 0.01) current.push(event);
    else groups.push([event]);
  }
  const labels = groups.map((group) => group.map((event) => event.name).join(" + "));
  const full = labels.join(" → ");
  const visible = labels.length > 4
    ? `${labels.slice(0, 4).join(" → ")} +${labels.length - 4}`
    : full;
  return { visible, full };
}

export function PracticeCue({
  cue,
  eventMap,
  highlighted,
  pinned,
  onHighlight,
  onClear,
  onPreview,
  onPin,
}: PracticeCueProps) {
  const noteSummary = formatNoteGroups(cue, eventMap);
  const handLabel = cue.hand === "both" ? "Both hands" : cue.hand === "left" ? "Left hand" : "Right hand";
  return (
    <div
      className={`practice-cue ${highlighted ? "highlighted" : ""} ${pinned ? "pinned" : ""}`}
      onMouseEnter={() => onHighlight(cue.id, cue.event_refs)}
      onMouseLeave={onClear}
      onFocusCapture={() => onHighlight(cue.id, cue.event_refs)}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget;
        if (!nextTarget || !event.currentTarget.contains(nextTarget as Node)) onClear();
      }}
      role="group"
      aria-label={`${handLabel} cue${cue.label ? `: ${cue.label}` : ""}`}
    >
      <button
        type="button"
        className="cue-preview"
        onClick={() => onPreview(cue.event_refs)}
        title={noteSummary ? `Seek to ${noteSummary.full}` : "Preview this cue's moment"}
      >
        <span className={`cue-hand cue-hand-${cue.hand}`}>{handLabel}</span>
        {cue.label && <strong>{cue.label}</strong>}
        <span className="cue-text">{cue.text}</span>
        {noteSummary && <code className="cue-notes" aria-label={`Referenced notes: ${noteSummary.full}`}>{noteSummary.visible}</code>}
      </button>
      <button
        type="button"
        className={`cue-pin ${pinned ? "active" : ""}`}
        aria-pressed={pinned}
        aria-label={pinned ? "Unpin cue" : "Pin cue"}
        title={pinned ? "Unpin cue" : "Pin cue"}
        onClick={(event) => {
          event.stopPropagation();
          onPin(cue.id, cue.event_refs);
        }}
      >
        <Pin size={13} strokeWidth={2.2} fill={pinned ? "currentColor" : "none"} />
      </button>
    </div>
  );
}
