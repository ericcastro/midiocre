"use client";

import { useEffect, useRef, useState } from "react";
import type { HandMode, MidiNote, PracticeUnit } from "../lib/types";

interface PianoRollProps {
  notes: MidiNote[];
  currentTime: number;
  duration: number;
  handMode: HandMode;
  loopStart: number;
  loopEnd: number;
  loopEnabled: boolean;
  loopDelayGapSeconds: number;
  loopDelayRemainingSeconds: number;
  isLoopDelaying: boolean;
  selectedUnit: PracticeUnit | null;
  rollZoom: number;
  horizontalZoom: number;
  horizontalPan: number;
  noteVisibility: "accurate" | "enhanced";
  highlightedEventIds: Set<string>;
  onSeek: (time: number) => void;
  onRollZoom: (zoom: number) => void;
  onHorizontalZoom: (zoom: number) => void;
  onHorizontalPan: (pan: number) => void;
}

const BLACK_CLASSES = new Set([1, 3, 6, 8, 10]);

function rgba(hex: string, alpha: number) {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function keyGeometry(width: number, zoom: number, pan: number) {
  const whiteKeys: number[] = [];
  for (let pitch = 21; pitch <= 108; pitch += 1) {
    if (!BLACK_CLASSES.has(pitch % 12)) whiteKeys.push(pitch);
  }
  const totalWidth = width * zoom;
  const whiteWidth = totalWidth / whiteKeys.length;
  const offset = Math.max(0, totalWidth - width) * pan;
  const geometry = new Map<number, { x: number; width: number; black: boolean }>();
  let whiteIndex = 0;
  for (let pitch = 21; pitch <= 108; pitch += 1) {
    const black = BLACK_CLASSES.has(pitch % 12);
    if (black) {
      geometry.set(pitch, {
        x: whiteIndex * whiteWidth - whiteWidth * 0.32 - offset,
        width: whiteWidth * 0.64,
        black,
      });
    } else {
      geometry.set(pitch, {
        x: whiteIndex * whiteWidth - offset,
        width: whiteWidth,
        black,
      });
      whiteIndex += 1;
    }
  }
  return { geometry, whiteWidth };
}

export function PianoRoll({
  notes,
  currentTime,
  duration,
  handMode,
  loopStart,
  loopEnd,
  loopEnabled,
  loopDelayGapSeconds,
  loopDelayRemainingSeconds,
  isLoopDelaying,
  selectedUnit,
  rollZoom,
  horizontalZoom,
  horizontalPan,
  noteVisibility,
  highlightedEventIds,
  onSeek,
  onRollZoom,
  onHorizontalZoom,
  onHorizontalPan,
}: PianoRollProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const currentTimeRef = useRef(currentTime);
  const pixelsPerSecondRef = useRef(52);
  const wheelDeltaRef = useRef(0);
  const wheelFrameRef = useRef<number | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startTime: number;
    moved: boolean;
  } | null>(null);
  const pinchRef = useRef<{
    startDistance: number;
    startCentroidX: number;
    startRollZoom: number;
    startHorizontalZoom: number;
    startHorizontalPan: number;
  } | null>(null);
  const [sizeVersion, setSizeVersion] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!parent || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setSizeVersion((value) => value + 1);
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey) {
        event.preventDefault();
        const factor = Math.exp(-event.deltaY * 0.0025);
        onRollZoom(clamp(rollZoom * factor, 0.6, 3));
        onHorizontalZoom(clamp(horizontalZoom * factor, 1, 3));
        return;
      }
      event.preventDefault();
      if (
        Math.abs(event.deltaX) > Math.abs(event.deltaY) &&
        horizontalZoom > 1
      ) {
        const span = Math.max(1, canvas.clientWidth * (horizontalZoom - 1));
        onHorizontalPan(clamp(horizontalPan + event.deltaX / span, 0, 1));
        return;
      }
      const dominantDelta =
        Math.abs(event.deltaY) >= Math.abs(event.deltaX)
          ? event.deltaY
          : event.deltaX;
      const normalizedDelta =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? dominantDelta * 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? dominantDelta * canvas.clientHeight
            : dominantDelta;
      wheelDeltaRef.current += normalizedDelta;
      if (wheelFrameRef.current !== null) return;
      wheelFrameRef.current = window.requestAnimationFrame(() => {
        const next = Math.max(
          0,
          Math.min(
            duration,
            currentTimeRef.current -
              wheelDeltaRef.current / Math.max(1, pixelsPerSecondRef.current),
          ),
        );
        wheelDeltaRef.current = 0;
        wheelFrameRef.current = null;
        currentTimeRef.current = next;
        onSeek(next);
      });
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", handleWheel);
      if (wheelFrameRef.current !== null) {
        window.cancelAnimationFrame(wheelFrameRef.current);
        wheelFrameRef.current = null;
      }
    };
  }, [
    duration,
    horizontalPan,
    horizontalZoom,
    onHorizontalPan,
    onHorizontalZoom,
    onRollZoom,
    onSeek,
    rollZoom,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const width = parent.clientWidth;
    const height = parent.clientHeight;
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const keyboardHeight = Math.min(112, height * 0.2);
    const keyboardY = height - keyboardHeight;
    const rollHeight = keyboardY;
    const baseSecondsVisible = Math.max(7, Math.min(13, rollHeight / 52));
    const secondsVisible = Math.max(2.5, Math.min(16, baseSecondsVisible / rollZoom));
    const pixelsPerSecond = rollHeight / secondsVisible;
    pixelsPerSecondRef.current = pixelsPerSecond;
    const { geometry, whiteWidth } = keyGeometry(
      width,
      horizontalZoom,
      horizontalPan,
    );
    const validLoop = loopEnabled && loopEnd - loopStart > 0.08;
    const loopLength = Math.max(0.08, loopEnd - loopStart);
    const delayGap = validLoop ? Math.max(0, loopDelayGapSeconds) : 0;
    const currentPassEndDelta = isLoopDelaying
      ? 0
      : Math.max(0, loopEnd - currentTime);
    const nextLoopStartDelta = isLoopDelaying
      ? Math.max(0, loopDelayRemainingSeconds)
      : currentPassEndDelta + delayGap;
    const cycleLength = loopLength + delayGap;

    const gradient = ctx.createLinearGradient(0, 0, 0, keyboardY);
    gradient.addColorStop(0, "#171923");
    gradient.addColorStop(1, "#0b0d13");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, keyboardY);

    const fillTimelineBand = (
      startDelta: number,
      endDelta: number,
      color: string,
      label?: string,
    ) => {
      if (endDelta <= 0 || startDelta >= secondsVisible) return;
      const visibleStart = Math.max(0, startDelta);
      const visibleEnd = Math.min(secondsVisible, endDelta);
      const top = keyboardY - visibleEnd * pixelsPerSecond;
      const bottom = keyboardY - visibleStart * pixelsPerSecond;
      ctx.fillStyle = color;
      ctx.fillRect(0, top, width, bottom - top);
      if (label && bottom - top > 28) {
        ctx.fillStyle = "rgba(220,230,196,.56)";
        ctx.font = "700 9px system-ui";
        ctx.fillText(label, 10, Math.max(14, top + 16));
      }
    };

    if (validLoop) {
      if (!isLoopDelaying && currentPassEndDelta > 0) {
        fillTimelineBand(
          0,
          currentPassEndDelta,
          "rgba(183,215,105,.035)",
          "CURRENT LOOP",
        );
      }
      if (nextLoopStartDelta > currentPassEndDelta + 0.01) {
        fillTimelineBand(
          currentPassEndDelta,
          nextLoopStartDelta,
          "rgba(167,177,147,.085)",
          "COUNT-IN SPACE",
        );
      }
      for (
        let cycleStart = nextLoopStartDelta, cycle = 0;
        cycleStart < secondsVisible;
        cycleStart += cycleLength, cycle += 1
      ) {
        fillTimelineBand(
          cycleStart,
          cycleStart + loopLength,
          cycle === 0
            ? "rgba(210,255,102,.085)"
            : "rgba(210,255,102,.045)",
          cycle === 0 ? "NEXT LOOP" : undefined,
        );
        if (delayGap > 0) {
          fillTimelineBand(
            cycleStart + loopLength,
            cycleStart + cycleLength,
            "rgba(167,177,147,.065)",
          );
        }
      }
    }

    ctx.strokeStyle = "rgba(255,255,255,.035)";
    ctx.lineWidth = 1;
    for (let pitch = 21; pitch <= 108; pitch += 1) {
      const geo = geometry.get(pitch);
      if (geo && !geo.black && geo.x + geo.width >= 0 && geo.x <= width) {
        ctx.beginPath();
        ctx.moveTo(geo.x, 0);
        ctx.lineTo(geo.x, keyboardY);
        ctx.stroke();
      }
    }

    const firstGridLine = validLoop ? 1 : Math.ceil(currentTime);
    const lastGridLine = validLoop
      ? Math.ceil(secondsVisible)
      : currentTime + secondsVisible;
    for (let second = firstGridLine; second <= lastGridLine; second += 1) {
      const delta = validLoop ? second : second - currentTime;
      const y = keyboardY - delta * pixelsPerSecond;
      ctx.strokeStyle =
        second % 4 === 0 ? "rgba(255,255,255,.14)" : "rgba(255,255,255,.055)";
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    if (selectedUnit && !validLoop) {
      const unitStart = selectedUnit.timing.start_seconds;
      const unitEnd = selectedUnit.timing.end_seconds;
      const top = keyboardY - (unitEnd - currentTime) * pixelsPerSecond;
      const bottom = keyboardY - (unitStart - currentTime) * pixelsPerSecond;
      ctx.fillStyle = "rgba(210,255,102,.045)";
      ctx.fillRect(0, Math.max(0, top), width, Math.min(keyboardY, bottom) - Math.max(0, top));
    }

    if (validLoop) {
      const markers: Array<{ delta: number; label: string; muted?: boolean }> = [];
      if (delayGap > 0 || isLoopDelaying) {
        markers.push({ delta: currentPassEndDelta, label: "B" });
        markers.push({
          delta: nextLoopStartDelta,
          label: "A · NEXT LOOP",
          muted: isLoopDelaying,
        });
      } else {
        markers.push({
          delta: nextLoopStartDelta,
          label: "B → A · LOOP",
        });
      }
      markers.push({
        delta: nextLoopStartDelta + loopLength,
        label: "B",
      });
      for (const marker of markers) {
        const y = keyboardY - marker.delta * pixelsPerSecond;
        if (y >= 0 && y <= keyboardY) {
          ctx.strokeStyle = marker.muted
            ? "rgba(210,255,102,.58)"
            : "#d2ff66";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(width, y);
          ctx.stroke();
          ctx.fillStyle = marker.muted
            ? "rgba(210,255,102,.72)"
            : "#d2ff66";
          ctx.font = "700 11px system-ui";
          ctx.fillText(marker.label, 8, Math.max(13, y - 5));
        }
      }
    }

    const activePitches = new Map<number, string>();
    const highlightedPitches = new Set<number>();
    for (const note of notes) {
      if (highlightedEventIds.has(note.id)) highlightedPitches.add(note.midi);
    }
    const occurrences: Array<{ note: MidiNote; delta: number }> = [];
    if (validLoop) {
      if (!isLoopDelaying) {
        const passStart = currentTime < loopStart ? 0 : loopStart;
        for (const note of notes) {
          if (note.time >= loopEnd) break;
          if (note.time < passStart) continue;
          if (note.time + note.duration < currentTime - 0.25) continue;
          occurrences.push({ note, delta: note.time - currentTime });
        }
      }
      const loopNotes = notes.filter(
        (note) => note.time >= loopStart && note.time < loopEnd,
      );
      for (
        let cycleStart = nextLoopStartDelta;
        cycleStart < secondsVisible + 0.25;
        cycleStart += cycleLength
      ) {
        for (const note of loopNotes) {
          occurrences.push({
            note,
            delta: cycleStart + (note.time - loopStart),
          });
        }
      }
    } else {
      for (const note of notes) {
        if (note.time > currentTime + secondsVisible) break;
        if (note.time + note.duration < currentTime - 0.25) continue;
        occurrences.push({ note, delta: note.time - currentTime });
      }
    }

    for (const { note, delta } of occurrences) {
      if (delta > secondsVisible || delta + note.duration < -0.25) continue;
      const geo = geometry.get(note.midi);
      if (!geo || geo.x + geo.width < 0 || geo.x > width) continue;
      const isMuted = handMode !== "both" && note.hand !== handMode;
      const color = note.hand === "left" ? "#7e9dff" : "#ffaf68";
      const trueHeight = note.duration * pixelsPerSecond;
      const minimumHeight = noteVisibility === "enhanced" ? 7 : 2;
      const noteHeight = Math.max(minimumHeight, trueHeight);
      const y = keyboardY - delta * pixelsPerSecond - noteHeight;
      const radius = Math.min(4, geo.width * 0.2);
      ctx.fillStyle = isMuted ? rgba(color, 0.13) : rgba(color, 0.9);
      ctx.beginPath();
      ctx.roundRect(
        geo.x + 1,
        y,
        Math.max(2, geo.width - 2),
        noteHeight,
        radius,
      );
      ctx.fill();
      if (highlightedEventIds.has(note.id)) {
        ctx.strokeStyle = "#d2ff66";
        ctx.lineWidth = 2;
        ctx.stroke();
        if (noteVisibility === "enhanced" && trueHeight < minimumHeight) {
          ctx.fillStyle = "rgba(255,255,255,.9)";
          ctx.fillRect(
            geo.x + 2,
            keyboardY - delta * pixelsPerSecond - 1,
            Math.max(2, geo.width - 4),
            2,
          );
        }
      }
      if (!isMuted && delta <= 0 && delta + note.duration >= 0) {
        activePitches.set(note.midi, color);
      }
    }

    ctx.fillStyle = "#f5f2eb";
    ctx.fillRect(0, keyboardY, width, keyboardHeight);
    ctx.strokeStyle = "rgba(14,16,22,.28)";
    ctx.lineWidth = 1;
    for (let pitch = 21; pitch <= 108; pitch += 1) {
      const geo = geometry.get(pitch);
      if (!geo || geo.black) continue;
      const activeColor = activePitches.get(pitch);
      if (activeColor) {
        ctx.fillStyle = activeColor;
        ctx.fillRect(geo.x + 1, keyboardY, whiteWidth - 2, keyboardHeight);
      }
      ctx.strokeStyle = "rgba(14,16,22,.28)";
      ctx.lineWidth = 1;
      ctx.strokeRect(geo.x, keyboardY, whiteWidth, keyboardHeight);
      if (highlightedPitches.has(pitch)) {
        ctx.strokeStyle = "#baf45b";
        ctx.lineWidth = 3;
        ctx.strokeRect(geo.x + 2, keyboardY + 2, whiteWidth - 4, keyboardHeight - 4);
      }
    }

    for (let pitch = 21; pitch <= 108; pitch += 1) {
      const geo = geometry.get(pitch);
      if (!geo || !geo.black) continue;
      ctx.fillStyle = activePitches.get(pitch) ?? "#171922";
      ctx.beginPath();
      ctx.roundRect(geo.x, keyboardY, geo.width, keyboardHeight * 0.62, [0, 0, 3, 3]);
      ctx.fill();
      if (highlightedPitches.has(pitch)) {
        ctx.strokeStyle = "#baf45b";
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }

    ctx.fillStyle = "rgba(210,255,102,.9)";
    ctx.fillRect(0, keyboardY - 2, width * (duration ? currentTime / duration : 0), 2);
  }, [
    currentTime,
    duration,
    handMode,
    horizontalPan,
    horizontalZoom,
    isLoopDelaying,
    loopDelayGapSeconds,
    loopDelayRemainingSeconds,
    loopEnabled,
    loopEnd,
    loopStart,
    notes,
    selectedUnit,
    sizeVersion,
    rollZoom,
    noteVisibility,
    highlightedEventIds,
  ]);

  const finishGesture = (pointerId: number) => {
    const canvas = canvasRef.current;
    if (canvas?.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    pointersRef.current.delete(pointerId);
    pinchRef.current = null;
    const remaining = [...pointersRef.current.entries()];
    if (remaining.length === 1) {
      const [nextPointerId, point] = remaining[0];
      dragRef.current = {
        pointerId: nextPointerId,
        startY: point.y,
        startTime: currentTimeRef.current,
        moved: false,
      };
      return;
    }
    dragRef.current = null;
    setIsScrubbing(false);
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        className={isScrubbing ? "scrubbing" : ""}
        aria-label="Animated piano roll and 88-key piano. Drag to seek, pinch to zoom, or use two fingers to move the keyboard."
        role="slider"
        tabIndex={0}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, duration)}
        aria-valuenow={Math.round(currentTime * 10) / 10}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" && event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          pointersRef.current.set(event.pointerId, {
            x: event.clientX,
            y: event.clientY,
          });
          const points = [...pointersRef.current.values()];
          if (points.length >= 2) {
            const [first, second] = points;
            pinchRef.current = {
              startDistance: Math.max(
                12,
                Math.hypot(second.x - first.x, second.y - first.y),
              ),
              startCentroidX: (first.x + second.x) / 2,
              startRollZoom: rollZoom,
              startHorizontalZoom: horizontalZoom,
              startHorizontalPan: horizontalPan,
            };
            dragRef.current = null;
          } else {
            dragRef.current = {
              pointerId: event.pointerId,
              startY: event.clientY,
              startTime: currentTimeRef.current,
              moved: false,
            };
          }
          setIsScrubbing(true);
        }}
        onPointerMove={(event) => {
          if (!pointersRef.current.has(event.pointerId)) return;
          pointersRef.current.set(event.pointerId, {
            x: event.clientX,
            y: event.clientY,
          });
          const points = [...pointersRef.current.values()];
          const pinch = pinchRef.current;
          if (points.length >= 2 && pinch) {
            const [first, second] = points;
            const distance = Math.max(
              12,
              Math.hypot(second.x - first.x, second.y - first.y),
            );
            const factor = distance / pinch.startDistance;
            const nextRollZoom = clamp(
              pinch.startRollZoom * factor,
              0.6,
              3,
            );
            const nextHorizontalZoom = clamp(
              pinch.startHorizontalZoom * factor,
              1,
              3,
            );
            onRollZoom(nextRollZoom);
            onHorizontalZoom(nextHorizontalZoom);

            const centroidX = (first.x + second.x) / 2;
            const panSpan = Math.max(
              1,
              event.currentTarget.clientWidth *
                Math.max(0.1, nextHorizontalZoom - 1),
            );
            onHorizontalPan(
              clamp(
                pinch.startHorizontalPan -
                  (centroidX - pinch.startCentroidX) / panSpan,
                0,
                1,
              ),
            );
            return;
          }
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const deltaY = event.clientY - drag.startY;
          if (!drag.moved && Math.abs(deltaY) < 4) return;
          drag.moved = true;
          const next = Math.max(
            0,
            Math.min(
              duration,
              drag.startTime + deltaY / Math.max(1, pixelsPerSecondRef.current),
            ),
          );
          currentTimeRef.current = next;
          onSeek(next);
        }}
        onPointerUp={(event) => finishGesture(event.pointerId)}
        onPointerCancel={(event) => finishGesture(event.pointerId)}
      />
      <span className="roll-scrub-hint" aria-hidden="true">
        Drag to seek · pinch to zoom
      </span>
    </>
  );
}
