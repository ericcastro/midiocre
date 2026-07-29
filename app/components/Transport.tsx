"use client";

import {
  BookmarkPlus,
  Pause,
  Play,
  Repeat2,
  RotateCcw,
  SkipBack,
  Timer,
  Volume2,
} from "lucide-react";
import type { HandMode, SavedLoop } from "../lib/types";

interface TransportProps {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  speed: number;
  handMode: HandMode;
  loopEnabled: boolean;
  metronomeEnabled: boolean;
  loopDelayEnabled: boolean;
  loopDelayBeats: number | null;
  loopTimingOffsetMs: number;
  beatsPerBar: number;
  isLoopDelaying: boolean;
  loopStart: number;
  loopEnd: number;
  savedLoops: SavedLoop[];
  onToggle: () => void;
  onSeek: (value: number) => void;
  onSpeed: (value: number) => void;
  onHandMode: (value: HandMode) => void;
  onSetA: () => void;
  onSetB: () => void;
  onToggleLoop: () => void;
  onToggleMetronome: () => void;
  onToggleLoopDelay: () => void;
  onLoopDelayBeats: (value: number | null) => void;
  onLoopTimingOffset: (value: number) => void;
  onSaveLoop: () => void;
  onChooseLoop: (loop: SavedLoop) => void;
}

export function formatTime(value: number) {
  if (!Number.isFinite(value)) return "0:00";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function Transport({
  currentTime,
  duration,
  isPlaying,
  speed,
  handMode,
  loopEnabled,
  metronomeEnabled,
  loopDelayEnabled,
  loopDelayBeats,
  loopTimingOffsetMs,
  beatsPerBar,
  isLoopDelaying,
  loopStart,
  loopEnd,
  savedLoops,
  onToggle,
  onSeek,
  onSpeed,
  onHandMode,
  onSetA,
  onSetB,
  onToggleLoop,
  onToggleMetronome,
  onToggleLoopDelay,
  onLoopDelayBeats,
  onLoopTimingOffset,
  onSaveLoop,
  onChooseLoop,
}: TransportProps) {
  return (
    <div className="transport">
      <div className="seek-row">
        <span>{formatTime(currentTime)}</span>
        <input
          aria-label="Song position"
          type="range"
          min={0}
          max={Math.max(0.01, duration)}
          step={0.01}
          value={Math.min(currentTime, duration)}
          onChange={(event) => onSeek(Number(event.target.value))}
        />
        <span>{formatTime(duration)}</span>
      </div>

      <div className="transport-row">
        <div className="transport-cluster">
          <button
            className="icon-button"
            onClick={() => onSeek(0)}
            aria-label="Return to start"
          >
            <SkipBack size={17} />
          </button>
          <button className="play-button" onClick={onToggle} aria-label={isPlaying ? "Pause" : "Play"}>
            {isPlaying ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}
          </button>
          <button
            className="icon-button"
            onClick={() => onSeek(Math.max(0, currentTime - 5))}
            aria-label="Go back five seconds"
          >
            <RotateCcw size={16} />
          </button>
        </div>

        <div className="segmented" aria-label="Hand playback">
          {(["left", "both", "right"] as HandMode[]).map((mode) => (
            <button
              key={mode}
              className={handMode === mode ? "active" : ""}
              onClick={() => onHandMode(mode)}
            >
              {mode === "left" ? "Left" : mode === "right" ? "Right" : "Both"}
            </button>
          ))}
        </div>

        <label className="speed-control">
          <span>Tempo</span>
          <select value={speed} onChange={(event) => onSpeed(Number(event.target.value))}>
            {[0.5, 0.65, 0.8, 0.9, 1, 1.1].map((value) => (
              <option key={value} value={value}>
                {Math.round(value * 100)}%
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="transport-options-row">
        <div className="loop-tools">
          <button className="time-chip" onClick={onSetA} title="Set loop start to the playhead">
            A&nbsp; {formatTime(loopStart)}
          </button>
          <button className="time-chip" onClick={onSetB} title="Set loop end to the playhead">
            B&nbsp; {formatTime(loopEnd)}
          </button>
          <button
            className={`icon-button ${loopEnabled ? "active-loop" : ""}`}
            onClick={onToggleLoop}
            aria-label="Toggle loop"
          >
            <Repeat2 size={17} />
          </button>
          <button className="icon-button" onClick={onSaveLoop} aria-label="Save this loop">
            <BookmarkPlus size={17} />
          </button>
          {savedLoops.length > 0 && (
            <select
              className="loop-select"
              aria-label="Saved loops"
              defaultValue=""
              onChange={(event) => {
                const selected = savedLoops.find((loop) => loop.id === event.target.value);
                if (selected) onChooseLoop(selected);
                event.target.value = "";
              }}
            >
              <option value="" disabled>
                Saved loops
              </option>
              {savedLoops.map((loop) => (
                <option key={loop.id} value={loop.id}>
                  {loop.label}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="timing-tools">
          <button
            className={`timing-toggle ${metronomeEnabled ? "active" : ""}`}
            aria-pressed={metronomeEnabled}
            onClick={onToggleMetronome}
          >
            <Volume2 size={16} />
            Metronome
          </button>
          <button
            className={`timing-toggle ${loopDelayEnabled ? "active" : ""} ${
              isLoopDelaying ? "counting" : ""
            }`}
            aria-pressed={loopDelayEnabled}
            onClick={onToggleLoopDelay}
          >
            <Timer size={16} />
            {isLoopDelaying ? "Counting…" : "Loop delay"}
          </button>
          <select
            className="delay-select"
            aria-label="Loop restart delay"
            value={loopDelayBeats === null ? "bar" : String(loopDelayBeats)}
            disabled={!loopDelayEnabled}
            onChange={(event) =>
              onLoopDelayBeats(
                event.target.value === "bar" ? null : Number(event.target.value),
              )
            }
          >
            <option value="bar">Full count ({beatsPerBar} beats)</option>
            {[1, 2, 3, 4, 5, 6].map((beats) => (
              <option key={beats} value={beats}>
                {beats} {beats === 1 ? "beat" : "beats"}
              </option>
            ))}
          </select>
          <label
            className="offset-control"
            title="Move both loop boundaries together without changing the loop duration"
          >
            <span>Loop offset</span>
            <input
              aria-label="Loop timing offset"
              type="range"
              min={-300}
              max={300}
              step={10}
              value={loopTimingOffsetMs}
              onChange={(event) => onLoopTimingOffset(Number(event.target.value))}
            />
            <b>
              {loopTimingOffsetMs === 0
                ? "Off"
                : `${loopTimingOffsetMs > 0 ? "+" : "−"}${Math.abs(loopTimingOffsetMs)} ms`}
            </b>
          </label>
        </div>
      </div>
    </div>
  );
}
