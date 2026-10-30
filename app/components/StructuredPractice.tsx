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
  kind: "learn" | "handoff";
  description: string;
}

function formatBeatCount(value: number, beatsPerBar: number) {
  if (value === beatsPerBar) return "Full bar";
  if (value === 0.25) return "¼ beat";
  if (value === 0.5) return "½ beat";
  if (value === 0.75) return "¾ beat";
  return `${value} ${value === 1 ? "beat" : "beats"}`;
}

function buildBridgeLoop(
  unitId: string,
  beatsPerBar: number,
  previous: BarTiming,
  current: BarTiming,
  beforeBeats: number,
  afterBeats: number,
): StructuredStep {
  const previousBeat = Math.max(
    0.12,
    (previous.end_seconds - previous.start_seconds) / Math.max(1, beatsPerBar),
  );
  const currentBeat = Math.max(
    0.12,
    (current.end_seconds - current.start_seconds) / Math.max(1, beatsPerBar),
  );
  return {
    id: `structured:${unitId}:handoff:${previous.bar}-${current.bar}`,
    kind: "handoff",
    label: `Bridge ${previous.bar} → ${current.bar}`,
    description: `${formatBeatCount(beforeBeats, beatsPerBar)} before the bar line into ${formatBeatCount(afterBeats, beatsPerBar).toLowerCase()} after it.`,
    startSeconds: Math.max(
      previous.start_seconds,
      previous.end_seconds - previousBeat * beforeBeats,
    ),
    endSeconds: Math.min(
      current.end_seconds,
      current.start_seconds + currentBeat * afterBeats,
    ),
  };
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
  const [bridgeBeforeBeats, setBridgeBeforeBeats] = useState(1);
  const [bridgeAfterBeats, setBridgeAfterBeats] = useState(1);
  const [bridgeMirrored, setBridgeMirrored] = useState(true);

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
        result.push(
          buildBridgeLoop(
            unit.id,
            beatsPerBar,
            previous,
            bar,
            bridgeBeforeBeats,
            bridgeAfterBeats,
          ),
        );
      }
    });
    return result;
  }, [beatsPerBar, bridgeAfterBeats, bridgeBeforeBeats, sectionBars, unit.id]);

  const updateActiveBridge = (beforeBeats: number, afterBeats: number) => {
    const currentIndex = sectionBars.findIndex(
      (bar, index) =>
        index > 0 &&
        selectedStepId ===
          `structured:${unit.id}:handoff:${sectionBars[index - 1].bar}-${bar.bar}`,
    );
    if (currentIndex <= 0) return;
    onActivate(
      buildBridgeLoop(
        unit.id,
        beatsPerBar,
        sectionBars[currentIndex - 1],
        sectionBars[currentIndex],
        beforeBeats,
        afterBeats,
      ),
    );
  };

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
        <strong>Learn one bar. Then bridge into the next.</strong>
        <p>Shape the bridge around the bar line. Use the trouble-spot tool below for passages that do not follow bar boundaries.</p>
      </div>

      <div className="bridge-controls">
        <div className="bridge-controls-heading">
          <span>
            <strong>Bridge window</strong>
            <small>Applied to every bar-to-bar Bridge below</small>
          </span>
          <label className="bridge-mirror-toggle">
            <input
              type="checkbox"
              checked={bridgeMirrored}
              onChange={(event) => {
                const mirrored = event.target.checked;
                setBridgeMirrored(mirrored);
                if (mirrored) {
                  setBridgeAfterBeats(bridgeBeforeBeats);
                  updateActiveBridge(bridgeBeforeBeats, bridgeBeforeBeats);
                }
              }}
            />
            Same on both sides
          </label>
        </div>
        <label>
          <span>Before bar line <b>{formatBeatCount(bridgeBeforeBeats, beatsPerBar)}</b></span>
          <input
            aria-label="Beats before the bridge"
            type="range"
            min={0.25}
            max={Math.max(1, beatsPerBar)}
            step={0.25}
            value={bridgeBeforeBeats}
            onChange={(event) => {
              const before = Number(event.target.value);
              const after = bridgeMirrored ? before : bridgeAfterBeats;
              setBridgeBeforeBeats(before);
              if (bridgeMirrored) setBridgeAfterBeats(after);
              updateActiveBridge(before, after);
            }}
          />
        </label>
        <label>
          <span>After bar line <b>{formatBeatCount(bridgeAfterBeats, beatsPerBar)}</b></span>
          <input
            aria-label="Beats after the bridge"
            type="range"
            min={0.25}
            max={Math.max(1, beatsPerBar)}
            step={0.25}
            value={bridgeAfterBeats}
            onChange={(event) => {
              const after = Number(event.target.value);
              const before = bridgeMirrored ? after : bridgeBeforeBeats;
              setBridgeAfterBeats(after);
              if (bridgeMirrored) setBridgeBeforeBeats(before);
              updateActiveBridge(before, after);
            }}
          />
        </label>
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
                  {step.kind === "learn" ? <Play size={12} fill="currentColor" /> : <Link2 size={13} />}
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
            <strong>Hard passage anywhere?</strong>
            <small>Put Start and End around it. This loop can cross or ignore bar lines.</small>
          </span>
        </div>
        <label>
          <span>Start <b>{formatPreciseTime(customStart)}</b></span>
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
          <span>End <b>{formatPreciseTime(customEnd)}</b></span>
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
