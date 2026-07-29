"use client";

import { Check, Link2, Play, Scissors } from "lucide-react";
import { useMemo, useState } from "react";
import type { BarTiming, PracticeUnit } from "../lib/types";
import { formatTime } from "./Transport";

export interface StructuredLoop {
  id: string;
  label: string;
  startSeconds: number;
  endSeconds: number;
}

interface StructuredPracticeProps {
  unit: PracticeUnit;
  bars: BarTiming[];
  beatsPerBar: number;
  selectedStepId: string | null;
  completedStepIds: string[];
  currentLoopStart: number;
  currentLoopEnd: number;
  onActivate: (loop: StructuredLoop) => void;
  onToggleComplete: (stepId: string) => void;
}

interface StructuredStep extends StructuredLoop {
  kind: "learn" | "connect";
  description: string;
}

function formatPreciseTime(value: number) {
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  const tenths = Math.floor((value % 1) * 10);
  return `${minutes}:${seconds.toString().padStart(2, "0")}.${tenths}`;
}

function fallbackBars(unit: PracticeUnit): BarTiming[] {
  const count = Math.max(1, unit.timing.end_bar - unit.timing.start_bar + 1);
  const secondsPerBar =
    (unit.timing.end_seconds - unit.timing.start_seconds) / count;
  const ticksPerBar = (unit.timing.end_tick - unit.timing.start_tick) / count;
  return Array.from({ length: count }, (_, index) => ({
    bar: unit.timing.start_bar + index,
    start_seconds: unit.timing.start_seconds + secondsPerBar * index,
    end_seconds: unit.timing.start_seconds + secondsPerBar * (index + 1),
    start_tick: Math.round(unit.timing.start_tick + ticksPerBar * index),
    end_tick: Math.round(unit.timing.start_tick + ticksPerBar * (index + 1)),
  }));
}

function barsWithinUnit(unit: PracticeUnit, bars: BarTiming[]) {
  const matching = bars.filter(
    (bar) =>
      bar.bar >= unit.timing.start_bar && bar.bar <= unit.timing.end_bar,
  );
  const expected = unit.timing.end_bar - unit.timing.start_bar + 1;
  return matching.length === expected ? matching : fallbackBars(unit);
}

export function StructuredPractice({
  unit,
  bars,
  beatsPerBar,
  selectedStepId,
  completedStepIds,
  currentLoopStart,
  currentLoopEnd,
  onActivate,
  onToggleComplete,
}: StructuredPracticeProps) {
  const sectionBars = useMemo(() => barsWithinUnit(unit, bars), [bars, unit]);
  const completed = useMemo(() => new Set(completedStepIds), [completedStepIds]);
  const steps = useMemo<StructuredStep[]>(() => {
    const result: StructuredStep[] = [];
    sectionBars.forEach((bar, index) => {
      const nextBar = sectionBars[index + 1];
      result.push({
        id: `structured:${unit.id}:bar:${bar.bar}`,
        kind: "learn",
        label: `Learn bar ${bar.bar}`,
        description: nextBar
          ? `Find a comfortable fingering, and finish ready to land in bar ${nextBar.bar}.`
          : "Learn this bar cleanly without borrowing momentum from the beginning.",
        startSeconds: bar.start_seconds,
        endSeconds: bar.end_seconds,
      });

      if (index > 0) {
        const previous = sectionBars[index - 1];
        const previousBeat = Math.max(
          0.12,
          (previous.end_seconds - previous.start_seconds) / Math.max(1, beatsPerBar),
        );
        const currentBeat = Math.max(
          0.12,
          (bar.end_seconds - bar.start_seconds) / Math.max(1, beatsPerBar),
        );
        result.push({
          id: `structured:${unit.id}:connect:${previous.bar}-${bar.bar}`,
          kind: "connect",
          label: `Connect ${previous.bar} → ${bar.bar}`,
          description: `Loop only the handoff: the last beat of bar ${previous.bar} into the first beat of bar ${bar.bar}.`,
          startSeconds: Math.max(previous.start_seconds, previous.end_seconds - previousBeat),
          endSeconds: Math.min(bar.end_seconds, bar.start_seconds + currentBeat),
        });
      }
    });
    return result;
  }, [beatsPerBar, sectionBars, unit.id]);

  const combinations = useMemo<StructuredLoop[]>(() => {
    const loops: StructuredLoop[] = [
      {
        id: `structured:${unit.id}:section`,
        label:
          unit.timing.start_bar === unit.timing.end_bar
            ? `Whole bar ${unit.timing.start_bar}`
            : `Whole section ${unit.timing.start_bar}–${unit.timing.end_bar}`,
        startSeconds: unit.timing.start_seconds,
        endSeconds: unit.timing.end_seconds,
      },
    ];
    sectionBars.slice(1).forEach((bar, index) => {
      const previous = sectionBars[index];
      loops.push({
        id: `structured:${unit.id}:pair:${previous.bar}-${bar.bar}`,
        label: `Bars ${previous.bar}–${bar.bar}`,
        startSeconds: previous.start_seconds,
        endSeconds: bar.end_seconds,
      });
    });
    sectionBars.slice(2, -1).forEach((bar) => {
      loops.push({
        id: `structured:${unit.id}:build:${sectionBars[0].bar}-${bar.bar}`,
        label: `Build ${sectionBars[0].bar}–${bar.bar}`,
        startSeconds: sectionBars[0].start_seconds,
        endSeconds: bar.end_seconds,
      });
    });
    return loops;
  }, [sectionBars, unit]);

  const unitStart = unit.timing.start_seconds;
  const unitEnd = unit.timing.end_seconds;
  const initialStart =
    currentLoopStart >= unitStart && currentLoopStart < unitEnd
      ? currentLoopStart
      : unitStart;
  const initialEnd =
    currentLoopEnd > initialStart && currentLoopEnd <= unitEnd
      ? currentLoopEnd
      : Math.min(unitEnd, initialStart + Math.max(0.8, (unitEnd - unitStart) / 4));
  const [customStart, setCustomStart] = useState(initialStart);
  const [customEnd, setCustomEnd] = useState(
    Math.max(initialStart + 0.08, initialEnd),
  );

  return (
    <div className="structured-practice">
      <div className="structured-intro">
        <span className="card-kicker">Teacher&apos;s sequence</span>
        <strong>Learn one bar. Connect it. Then continue.</strong>
        <p>Three clean loops is enough to move on. If the same notes fail, shrink the loop.</p>
      </div>

      <ol className="structured-sequence">
        {steps.map((step, index) => {
          const isComplete = completed.has(step.id);
          const isSelected = selectedStepId === step.id;
          return (
            <li
              key={step.id}
              className={`${step.kind} ${isComplete ? "complete" : ""} ${isSelected ? "active" : ""}`}
            >
              <span className="structured-step-number">
                {index + 1}
              </span>
              <button
                type="button"
                className="structured-step-main"
                onClick={() => onActivate(step)}
              >
                <span className="structured-step-title">
                  {step.kind === "connect" ? <Link2 size={13} /> : <Play size={12} fill="currentColor" />}
                  <strong>{step.label}</strong>
                  <small>{formatTime(step.startSeconds)}–{formatTime(step.endSeconds)}</small>
                </span>
                <span>{step.description}</span>
              </button>
              <button
                type="button"
                className="structured-step-check"
                aria-label={isComplete ? `Mark ${step.label} unfinished` : `Mark ${step.label} complete`}
                aria-pressed={isComplete}
                title={isComplete ? "Mark unfinished" : "Mark done"}
                onClick={() => onToggleComplete(step.id)}
              >
                <Check size={13} />
              </button>
            </li>
          );
        })}
      </ol>

      <div className="structured-combinations">
        <span className="card-kicker">Longer loops</span>
        <p>Use these only after the individual bars and their handoffs feel reliable.</p>
        <div>
          {combinations.map((loop) => (
            <button
              type="button"
              key={loop.id}
              className={selectedStepId === loop.id ? "active" : ""}
              onClick={() => onActivate(loop)}
            >
              {loop.label}
            </button>
          ))}
        </div>
      </div>

      <div className="structured-trouble-spot">
        <div className="trouble-spot-heading">
          <Scissors size={15} />
          <span>
            <strong>Same mistake again?</strong>
            <small>Stop restarting. Put A and B around only the notes that fail.</small>
          </span>
        </div>
        <label>
          <span>A <b>{formatPreciseTime(customStart)}</b></span>
          <input
            aria-label="Custom trouble spot start"
            type="range"
            min={unitStart}
            max={Math.max(unitStart, unitEnd - 0.08)}
            step="0.01"
            value={customStart}
            onChange={(event) => {
              const value = Number(event.target.value);
              setCustomStart(value);
              if (customEnd < value + 0.08) setCustomEnd(Math.min(unitEnd, value + 0.08));
            }}
          />
        </label>
        <label>
          <span>B <b>{formatPreciseTime(customEnd)}</b></span>
          <input
            aria-label="Custom trouble spot end"
            type="range"
            min={Math.min(unitEnd, customStart + 0.08)}
            max={unitEnd}
            step="0.01"
            value={customEnd}
            onChange={(event) => setCustomEnd(Number(event.target.value))}
          />
        </label>
        <button
          type="button"
          className="structured-custom-action"
          onClick={() =>
            onActivate({
              id: `structured:${unit.id}:custom`,
              label: "Custom trouble spot",
              startSeconds: customStart,
              endSeconds: customEnd,
            })
          }
        >
          <Play size={13} fill="currentColor" /> Loop this spot
        </button>
      </div>
    </div>
  );
}
