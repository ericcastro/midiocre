"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toneNoteName } from "../lib/midi";
import type { HandMode, MidiNote } from "../lib/types";

type ToneModule = typeof import("tone");

interface PlayableInstrument {
  triggerAttackRelease(
    note: string,
    duration: number,
    time: number,
    velocity: number,
  ): unknown;
  releaseAll(): unknown;
  dispose(): unknown;
}

interface SamplerInstrument extends PlayableInstrument {
  loaded: boolean;
  volume: { value: number };
}

interface ClickInstrument {
  triggerAttackRelease(
    note: string,
    duration: number,
    time: number,
    velocity: number,
  ): unknown;
  dispose(): unknown;
}

interface PlayerOptions {
  resetKey?: string | null;
  notes: MidiNote[];
  duration: number;
  speed: number;
  handMode: HandMode;
  loopEnabled: boolean;
  metronomeEnabled: boolean;
  tempoBpm: number;
  beatsPerBar: number;
  beatUnit: number;
  loopDelayEnabled: boolean;
  loopDelayBeats: number | null;
  loopStart: number;
  loopEnd: number;
  initialTime?: number;
}

export function useMidiPlayer({
  resetKey,
  notes,
  duration,
  speed,
  handMode,
  loopEnabled,
  metronomeEnabled,
  tempoBpm,
  beatsPerBar,
  beatUnit,
  loopDelayEnabled,
  loopDelayBeats,
  loopStart,
  loopEnd,
  initialTime = 0,
}: PlayerOptions) {
  const [currentTime, setCurrentTimeState] = useState(initialTime);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoopDelaying, setIsLoopDelaying] = useState(false);
  const [loopDelayRemainingSeconds, setLoopDelayRemainingSeconds] =
    useState(0);
  const [instrumentReady, setInstrumentReady] = useState(false);
  const currentTimeRef = useRef(initialTime);
  const playingRef = useRef(false);
  const anchorTimeRef = useRef(initialTime);
  const anchorClockRef = useRef(0);
  const scheduledThroughRef = useRef(initialTime);
  const metronomeScheduledThroughRef = useRef(initialTime);
  const speedRef = useRef(speed);
  const toneRef = useRef<ToneModule | null>(null);
  const samplerRef = useRef<SamplerInstrument | null>(null);
  const fallbackRef = useRef<PlayableInstrument | null>(null);
  const metronomeRef = useRef<ClickInstrument | null>(null);
  const loopDelayActiveRef = useRef(false);
  const loopDelayStartClockRef = useRef(0);
  const loopDelayBeatDurationRef = useRef(0);
  const loopDelayBeatCountRef = useRef(0);
  const loopDelayNextBeatRef = useRef(0);
  const loopDelaySongSecondsRef = useRef(0);
  const loopDelaySpeedRef = useRef(speed);

  const audibleNotes = useMemo(
    () =>
      handMode === "both" ? notes : notes.filter((note) => note.hand === handMode),
    [notes, handMode],
  );
  const audibleNotesRef = useRef(audibleNotes);

  useEffect(() => {
    audibleNotesRef.current = audibleNotes;
    scheduledThroughRef.current = currentTimeRef.current;
    samplerRef.current?.releaseAll();
    fallbackRef.current?.releaseAll();
  }, [audibleNotes]);

  useEffect(() => {
    let disposed = false;
    void import("tone").then((Tone) => {
      if (disposed) return;
      toneRef.current = Tone;
      const fallback = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: "triangle8" },
        envelope: { attack: 0.006, decay: 0.7, sustain: 0.12, release: 1.4 },
        volume: -10,
      }).toDestination();
      fallback.maxPolyphony = 48;
      fallbackRef.current = fallback as unknown as PlayableInstrument;

      const metronome = new Tone.Synth({
        oscillator: { type: "sine" },
        envelope: { attack: 0.001, decay: 0.035, sustain: 0, release: 0.025 },
        volume: -11,
      }).toDestination();
      metronomeRef.current = metronome as unknown as ClickInstrument;

      const sampler = new Tone.Sampler({
        urls: {
          A0: "A0.mp3",
          C1: "C1.mp3",
          "D#1": "Ds1.mp3",
          "F#1": "Fs1.mp3",
          A1: "A1.mp3",
          C2: "C2.mp3",
          "D#2": "Ds2.mp3",
          "F#2": "Fs2.mp3",
          A2: "A2.mp3",
          C3: "C3.mp3",
          "D#3": "Ds3.mp3",
          "F#3": "Fs3.mp3",
          A3: "A3.mp3",
          C4: "C4.mp3",
          "D#4": "Ds4.mp3",
          "F#4": "Fs4.mp3",
          A4: "A4.mp3",
          C5: "C5.mp3",
          "D#5": "Ds5.mp3",
          "F#5": "Fs5.mp3",
          A5: "A5.mp3",
          C6: "C6.mp3",
          "D#6": "Ds6.mp3",
          "F#6": "Fs6.mp3",
          A6: "A6.mp3",
          C7: "C7.mp3",
          "D#7": "Ds7.mp3",
          "F#7": "Fs7.mp3",
          A7: "A7.mp3",
          C8: "C8.mp3",
        },
        release: 1.2,
        baseUrl: "https://tonejs.github.io/audio/salamander/",
        onload: () => setInstrumentReady(true),
        onerror: () => setInstrumentReady(false),
      }).toDestination();
      sampler.volume.value = -4;
      samplerRef.current = sampler as unknown as SamplerInstrument;
    });

    return () => {
      disposed = true;
      samplerRef.current?.dispose();
      fallbackRef.current?.dispose();
      metronomeRef.current?.dispose();
      samplerRef.current = null;
      fallbackRef.current = null;
      metronomeRef.current = null;
      toneRef.current = null;
    };
  }, []);

  const computeTime = useCallback(() => {
    if (!playingRef.current) return currentTimeRef.current;
    return (
      anchorTimeRef.current +
      ((performance.now() - anchorClockRef.current) / 1000) * speedRef.current
    );
  }, []);

  const reanchor = useCallback(
    (time: number) => {
      currentTimeRef.current = time;
      anchorTimeRef.current = time;
      anchorClockRef.current = performance.now();
      scheduledThroughRef.current = time;
      metronomeScheduledThroughRef.current = time - 0.001;
      setCurrentTimeState(time);
    },
    [],
  );

  const releaseAll = useCallback(() => {
    samplerRef.current?.releaseAll();
    fallbackRef.current?.releaseAll();
  }, []);

  const clearLoopDelay = useCallback(() => {
    loopDelayActiveRef.current = false;
    loopDelayStartClockRef.current = 0;
    loopDelayBeatDurationRef.current = 0;
    loopDelayBeatCountRef.current = 0;
    loopDelayNextBeatRef.current = 0;
    loopDelaySongSecondsRef.current = 0;
    setLoopDelayRemainingSeconds(0);
    setIsLoopDelaying(false);
  }, []);

  const startLoopDelay = useCallback(
    (time: number) => {
      const safeTempo = Math.max(1, tempoBpm);
      const safeBeatUnit = Math.max(1, beatUnit);
      const beatDurationInSong = (60 / safeTempo) * (4 / safeBeatUnit);
      const count = Math.max(1, loopDelayBeats ?? beatsPerBar);

      releaseAll();
      currentTimeRef.current = time;
      anchorTimeRef.current = time;
      anchorClockRef.current = performance.now();
      scheduledThroughRef.current = time;
      metronomeScheduledThroughRef.current = time;
      setCurrentTimeState(time);

      loopDelayStartClockRef.current = performance.now();
      loopDelayBeatDurationRef.current =
        beatDurationInSong / Math.max(0.01, speedRef.current);
      loopDelayBeatCountRef.current = count;
      loopDelayNextBeatRef.current = 0;
      loopDelaySongSecondsRef.current = beatDurationInSong * count;
      loopDelaySpeedRef.current = speedRef.current;
      loopDelayActiveRef.current = true;
      setLoopDelayRemainingSeconds(beatDurationInSong * count);
      setIsLoopDelaying(true);
    },
    [beatUnit, beatsPerBar, loopDelayBeats, releaseAll, tempoBpm],
  );

  const pause = useCallback(() => {
    const time = loopDelayActiveRef.current
      ? currentTimeRef.current
      : Math.min(duration, computeTime());
    playingRef.current = false;
    setIsPlaying(false);
    clearLoopDelay();
    releaseAll();
    reanchor(time);
  }, [clearLoopDelay, computeTime, duration, reanchor, releaseAll]);

  const seek = useCallback(
    (time: number) => {
      clearLoopDelay();
      releaseAll();
      reanchor(Math.max(0, Math.min(duration, time)));
    },
    [clearLoopDelay, duration, reanchor, releaseAll],
  );

  const play = useCallback(async () => {
    const Tone = toneRef.current;
    if (!Tone) return;
    await Tone.start();
    if (currentTimeRef.current >= duration - 0.02) reanchor(0);
    playingRef.current = true;
    anchorTimeRef.current = currentTimeRef.current;
    anchorClockRef.current = performance.now();
    scheduledThroughRef.current = currentTimeRef.current;
    metronomeScheduledThroughRef.current = currentTimeRef.current - 0.001;
    setIsPlaying(true);
  }, [duration, reanchor]);

  const toggle = useCallback(() => {
    if (playingRef.current) pause();
    else void play();
  }, [pause, play]);

  useEffect(() => {
    if (playingRef.current && !loopDelayActiveRef.current) {
      const now = computeTime();
      speedRef.current = speed;
      reanchor(now);
    } else {
      speedRef.current = speed;
    }
  }, [speed, computeTime, reanchor]);

  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    const render = () => {
      const effectiveEnd = loopEnabled ? Math.min(duration, loopEnd) : duration;
      if (loopDelayActiveRef.current) {
        const elapsed =
          (performance.now() - loopDelayStartClockRef.current) / 1000;
        const delayDuration =
          loopDelayBeatDurationRef.current * loopDelayBeatCountRef.current;
        if (elapsed >= delayDuration) {
          clearLoopDelay();
          reanchor(loopStart);
        } else {
          setLoopDelayRemainingSeconds(
            Math.max(
              0,
              loopDelaySongSecondsRef.current -
                elapsed * loopDelaySpeedRef.current,
            ),
          );
          currentTimeRef.current = effectiveEnd;
          setCurrentTimeState(effectiveEnd);
        }
        frame = requestAnimationFrame(render);
        return;
      }

      const time = computeTime();
      if (time >= effectiveEnd) {
        if (loopEnabled && loopEnd - loopStart > 0.08) {
          if (loopDelayEnabled) {
            startLoopDelay(effectiveEnd);
          } else {
            releaseAll();
            reanchor(loopStart);
          }
        } else {
          playingRef.current = false;
          setIsPlaying(false);
          releaseAll();
          reanchor(duration);
          return;
        }
      } else {
        currentTimeRef.current = time;
        setCurrentTimeState(time);
      }
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [
    computeTime,
    clearLoopDelay,
    duration,
    isPlaying,
    loopDelayEnabled,
    loopEnabled,
    loopEnd,
    loopStart,
    reanchor,
    releaseAll,
    startLoopDelay,
  ]);

  useEffect(() => {
    if (!isPlaying) return;
    const timer = window.setInterval(() => {
      const Tone = toneRef.current;
      const metronome = metronomeRef.current;
      if (!Tone) return;

      if (loopDelayActiveRef.current) {
        const elapsed =
          (performance.now() - loopDelayStartClockRef.current) / 1000;
        const lookAhead = 0.1;
        while (
          loopDelayNextBeatRef.current < loopDelayBeatCountRef.current
        ) {
          const beatAt =
            loopDelayNextBeatRef.current * loopDelayBeatDurationRef.current;
          if (beatAt > elapsed + lookAhead) break;
          if (metronome) {
            metronome.triggerAttackRelease(
              "C4",
              0.04,
              Tone.now() + Math.max(0, beatAt - elapsed),
              0.18,
            );
          }
          loopDelayNextBeatRef.current += 1;
        }
        return;
      }

      const songNow = computeTime();
      const horizon = songNow + 0.14 * speed;
      const scheduledFrom = Math.max(scheduledThroughRef.current, songNow - 0.01);
      const instrument =
        samplerRef.current?.loaded === true
          ? samplerRef.current
          : fallbackRef.current;

      if (instrument) {
        for (const note of audibleNotesRef.current) {
          if (
            !Number.isFinite(note.time) ||
            !Number.isFinite(note.duration) ||
            !Number.isFinite(note.velocity)
          ) {
            continue;
          }
          if (note.time < scheduledFrom) continue;
          if (note.time >= horizon) break;
          if (loopEnabled && note.time >= loopEnd) break;
          const toneNote = toneNoteName(note.midi);
          if (!toneNote) continue;
          const delay = Math.max(0, (note.time - songNow) / speed);
          const noteDuration = Math.max(0.04, note.duration / speed);
          instrument.triggerAttackRelease(
            toneNote,
            noteDuration,
            Tone.now() + delay,
            Math.min(1, Math.max(0.08, note.velocity)),
          );
        }
      }
      scheduledThroughRef.current = horizon;

      if (metronomeEnabled && metronome) {
        const safeTempo = Math.max(1, tempoBpm);
        const safeBeatUnit = Math.max(1, beatUnit);
        const beatDurationInSong = (60 / safeTempo) * (4 / safeBeatUnit);
        const metronomeFrom = Math.max(
          metronomeScheduledThroughRef.current,
          songNow - 0.01,
        );
        const scheduleEnd = loopEnabled
          ? Math.min(horizon, loopEnd)
          : horizon;
        let beatIndex = Math.ceil(
          (metronomeFrom - 0.0001) / beatDurationInSong,
        );
        while (beatIndex * beatDurationInSong < scheduleEnd - 0.0001) {
          const beatTime = beatIndex * beatDurationInSong;
          if (beatTime >= songNow - 0.01) {
            const downbeat = beatIndex % Math.max(1, beatsPerBar) === 0;
            metronome.triggerAttackRelease(
              downbeat ? "C7" : "G6",
              0.025,
              Tone.now() + Math.max(0, (beatTime - songNow) / speed),
              downbeat ? 0.55 : 0.34,
            );
          }
          beatIndex += 1;
        }
        metronomeScheduledThroughRef.current = scheduleEnd;
      } else {
        metronomeScheduledThroughRef.current = horizon;
      }
    }, 28);
    return () => window.clearInterval(timer);
  }, [
    beatUnit,
    beatsPerBar,
    computeTime,
    isPlaying,
    loopEnabled,
    loopEnd,
    metronomeEnabled,
    speed,
    tempoBpm,
  ]);

  useEffect(() => {
    if (!loopDelayActiveRef.current) return;
    if (loopEnabled && loopDelayEnabled) return;
    const frame = requestAnimationFrame(() => {
      clearLoopDelay();
      reanchor(loopEnabled ? loopStart : Math.min(duration, loopEnd));
    });
    return () => cancelAnimationFrame(frame);
  }, [
    clearLoopDelay,
    duration,
    loopDelayEnabled,
    loopEnabled,
    loopEnd,
    loopStart,
    reanchor,
  ]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      clearLoopDelay();
      releaseAll();
      reanchor(initialTime);
      playingRef.current = false;
      setIsPlaying(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [clearLoopDelay, initialTime, resetKey, reanchor, releaseAll]);

  return {
    currentTime,
    isPlaying,
    isLoopDelaying,
    loopDelayRemainingSeconds,
    instrumentReady,
    play,
    pause,
    toggle,
    seek,
  };
}
