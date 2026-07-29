"use client";

import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FilePenLine,
  FolderOpen,
  LoaderCircle,
  Moon,
  Music2,
  Play,
  Plus,
  Settings2,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  analyzeSong,
  API_BASE,
  deleteSong,
  getSong,
  getSongBars,
  getSongEvents,
  listSongs,
  saveSongState,
  updateSongContext,
  uploadSong,
} from "../lib/api";
import { normalizedEventsToPlayerNotes } from "../lib/midi";
import type {
  AiSettings,
  BarTiming,
  HandMode,
  MidiNote,
  PracticeMode,
  PracticeUnit,
  SavedLoop,
  SongDetail,
  SongListItem,
  SongState,
  TrackAssignment,
} from "../lib/types";
import { useMidiPlayer } from "../hooks/useMidiPlayer";
import { ImportSongDialog } from "./ImportSongDialog";
import { PianoRoll } from "./PianoRoll";
import { SongLibraryDialog } from "./SongLibraryDialog";
import {
  StructuredPractice,
  type StructuredLoop,
} from "./StructuredPractice";
import { formatTime, Transport } from "./Transport";
import { UnitTeacherNotes } from "./UnitTeacherNotes";

const AI_SETTINGS_KEY = "cadence.ai-settings.v1";
const THEME_KEY = "cadence.theme.v1";
type AppTheme = "light" | "dark";

const EMPTY_STATE: SongState = {
  position_seconds: 0,
  speed: 1,
  hand_mode: "both",
  loop_enabled: false,
  metronome_enabled: false,
  loop_delay_enabled: false,
  loop_delay_beats: null,
  loop_timing_offset_ms: 0,
  loop_start_seconds: 0,
  loop_end_seconds: 1,
  active_loop_id: null,
  saved_loops: [],
  completed_unit_ids: [],
  selected_unit_id: null,
  practice_route: "balanced",
  completed_structured_step_ids: [],
  selected_structured_step_id: null,
  roll_zoom: 1,
  roll_horizontal_zoom: 1,
  roll_horizontal_pan: 0.5,
  note_visibility: "enhanced",
  split_pitch: 60,
  track_assignments: {},
  total_practice_seconds: 0,
  last_opened_at: new Date().toISOString(),
};

const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: "openai",
  model: "gpt-5.6-sol",
  apiKey: "",
  ollamaBaseUrl: "http://127.0.0.1:11434",
  reasoningEffort: "low",
};

function stateFromSong(song: SongDetail): SongState {
  return {
    ...song.state,
    loop_end_seconds:
      song.state.loop_end_seconds ?? song.metadata.duration_seconds,
  };
}

export function AppShell() {
  const [songs, setSongs] = useState<SongListItem[]>([]);
  const [activeSong, setActiveSong] = useState<SongDetail | null>(null);
  const [songState, setSongState] = useState<SongState>(EMPTY_STATE);
  const [notes, setNotes] = useState<MidiNote[]>([]);
  const [barTimings, setBarTimings] = useState<BarTiming[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [songLoading, setSongLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisStartedAt, setAnalysisStartedAt] = useState<number | null>(null);
  const [analysisElapsed, setAnalysisElapsed] = useState(0);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [appError, setAppError] = useState<string | null>(null);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [handSetupOpen, setHandSetupOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextDraft, setContextDraft] = useState({ title: "", context_text: "" });
  const [contextSaving, setContextSaving] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [expandedUnit, setExpandedUnit] = useState<string | null>(null);
  const [transientCueId, setTransientCueId] = useState<string | null>(null);
  const [transientEventIds, setTransientEventIds] = useState<Set<string>>(new Set());
  const [pinnedCueRefs, setPinnedCueRefs] = useState<Record<string, string[]>>({});
  // The first client render must match SSR. The saved preference is applied just
  // after hydration, rather than being read during render.
  const [theme, setTheme] = useState<AppTheme>("light");
  const [aiSettings, setAiSettings] =
    useState<AiSettings>(DEFAULT_AI_SETTINGS);
  const stateRef = useRef(songState);
  const activeSongRef = useRef(activeSong);
  const lastPlayingRef = useRef(false);
  const playerTimeRef = useRef(0);

  useEffect(() => {
    const stored = window.localStorage.getItem(AI_SETTINGS_KEY);
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as Partial<AiSettings>;
      const timer = window.setTimeout(() => {
        setAiSettings({
          ...DEFAULT_AI_SETTINGS,
          ...parsed,
          apiKey: "",
        });
      }, 0);
      return () => window.clearTimeout(timer);
    } catch {
      window.localStorage.removeItem(AI_SETTINGS_KEY);
    }
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_KEY);
    const savedTheme: AppTheme = stored === "dark" || stored === "light"
      ? stored
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";

    const timer = window.setTimeout(() => {
      setTheme(savedTheme);
      document.documentElement.dataset.theme = savedTheme;
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((currentTheme) => {
      const nextTheme: AppTheme = currentTheme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = nextTheme;
      window.localStorage.setItem(THEME_KEY, nextTheme);
      return nextTheme;
    });
  }, []);

  const persistAiPreferences = useCallback((next: AiSettings) => {
    setAiSettings(next);
    window.localStorage.setItem(
      AI_SETTINGS_KEY,
      JSON.stringify({
        provider: next.provider,
        model: next.model,
        ollamaBaseUrl: next.ollamaBaseUrl,
        reasoningEffort: next.reasoningEffort,
      }),
    );
  }, []);

  useEffect(() => {
    if (!analysisStartedAt) return;
    const updateElapsed = () => setAnalysisElapsed(Math.floor((Date.now() - analysisStartedAt) / 1000));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [analysisStartedAt]);

  const refreshLibrary = useCallback(async () => {
    try {
      const result = await listSongs();
      setSongs(result);
      setBackendOnline(true);
      return result;
    } catch (error) {
      setBackendOnline(false);
      setAppError(error instanceof Error ? error.message : "Could not load songs.");
      return [];
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  const openSong = useCallback(async (songId: string) => {
    setSongLoading(true);
    setAppError(null);
    try {
      const song = await getSong(songId);
      setNotes([]);
      setBarTimings([]);
      setPinnedCueRefs({});
      setTransientCueId(null);
      setTransientEventIds(new Set());
      setActiveSong(song);
      setSongState(stateFromSong(song));
      setExpandedUnit(song.state.selected_unit_id);
      setLibraryOpen(false);
      setBackendOnline(true);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "Could not open song.");
    } finally {
      setSongLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshLibrary().then((result) => {
        if (result[0]) void openSong(result[0].id);
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [openSong, refreshLibrary]);

  const activeSongId = activeSong?.id;

  const loadEvents = useCallback(async (songId: string) => {
    try {
      const [events, bars] = await Promise.all([
        getSongEvents(songId),
        getSongBars(songId),
      ]);
      setNotes(normalizedEventsToPlayerNotes(events));
      setBarTimings(bars);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "Could not parse MIDI.");
    }
  }, []);

  useEffect(() => {
    if (!activeSongId) return;
    const timer = window.setTimeout(() => void loadEvents(activeSongId), 0);
    return () => window.clearTimeout(timer);
  }, [activeSongId, loadEvents]);

  const duration = activeSong?.metadata.duration_seconds ?? 0;
  const rawLoopEnd = Math.min(
    duration || 1,
    songState.loop_end_seconds ?? (duration || 1),
  );
  const rawLoopStart = songState.loop_start_seconds;
  const requestedLoopOffsetSeconds = songState.loop_timing_offset_ms / 1000;
  const loopOffsetSeconds = Math.max(
    -rawLoopStart,
    Math.min((duration || 1) - rawLoopEnd, requestedLoopOffsetSeconds),
  );
  const loopStart = rawLoopStart + loopOffsetSeconds;
  const loopEnd = rawLoopEnd + loopOffsetSeconds;
  const [timeSignatureBeats, timeSignatureUnit] = (
    activeSong?.metadata.time_signature ?? "4/4"
  )
    .split("/")
    .map(Number);
  const beatsPerBar =
    Number.isFinite(timeSignatureBeats) && timeSignatureBeats > 0
      ? Math.round(timeSignatureBeats)
      : 4;
  const beatUnit =
    Number.isFinite(timeSignatureUnit) && timeSignatureUnit > 0
      ? Math.round(timeSignatureUnit)
      : 4;
  const beatDurationSeconds =
    (60 / Math.max(1, activeSong?.metadata.tempo_bpm ?? 120)) *
    (4 / beatUnit);
  const loopDelayGapSeconds = songState.loop_delay_enabled
    ? beatDurationSeconds *
      Math.max(1, songState.loop_delay_beats ?? beatsPerBar)
    : 0;

  const player = useMidiPlayer({
    resetKey: activeSong?.id,
    notes,
    duration,
    speed: songState.speed,
    handMode: songState.hand_mode,
    loopEnabled: songState.loop_enabled,
    metronomeEnabled: songState.metronome_enabled,
    tempoBpm: activeSong?.metadata.tempo_bpm ?? 120,
    beatsPerBar,
    beatUnit,
    loopDelayEnabled: songState.loop_delay_enabled,
    loopDelayBeats: songState.loop_delay_beats,
    loopStart,
    loopEnd,
    initialTime: activeSong?.state.position_seconds ?? 0,
  });

  useEffect(() => {
    playerTimeRef.current = player.currentTime;
  }, [player.currentTime]);

  useEffect(() => {
    stateRef.current = songState;
    activeSongRef.current = activeSong;
  }, [activeSong, songState]);

  const reflectLibraryState = useCallback(
    (songId: string, state: SongState, position: number) => {
      setSongs((current) =>
        current
          .map((song) =>
            song.id === songId
              ? {
                  ...song,
                  updated_at: new Date().toISOString(),
                  last_opened_at: new Date().toISOString(),
                  progress: song.duration_seconds
                    ? Math.min(1, position / song.duration_seconds)
                    : 0,
                }
              : song,
          )
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
      );
    },
    [],
  );

  const persistCurrentState = useCallback(
    async (practiceIncrement = 0) => {
      const song = activeSongRef.current;
      if (!song) return;
      const latest = stateRef.current;
      const next: SongState = {
        ...latest,
        position_seconds: playerTimeRef.current,
        total_practice_seconds:
          latest.total_practice_seconds + practiceIncrement,
        last_opened_at: new Date().toISOString(),
      };
      stateRef.current = next;
      if (practiceIncrement) setSongState(next);
      try {
        await saveSongState(song.id, next);
        reflectLibraryState(song.id, next, playerTimeRef.current);
      } catch {
        // A later autosave will retry without interrupting practice.
      }
    },
    [reflectLibraryState],
  );

  useEffect(() => {
    if (!activeSong) return;
    const timer = window.setInterval(() => {
      void persistCurrentState(player.isPlaying ? 3 : 0);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [activeSong, persistCurrentState, player.isPlaying]);

  useEffect(() => {
    if (lastPlayingRef.current && !player.isPlaying) {
      void persistCurrentState();
    }
    lastPlayingRef.current = player.isPlaying;
  }, [persistCurrentState, player.isPlaying]);

  useEffect(() => {
    if (!activeSong) return;
    const handler = () => {
      const next: SongState = {
        ...stateRef.current,
        position_seconds: playerTimeRef.current,
        last_opened_at: new Date().toISOString(),
      };
      void fetch(`${API_BASE}/api/songs/${activeSong.id}/state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
        keepalive: true,
      });
    };
    window.addEventListener("pagehide", handler);
    return () => window.removeEventListener("pagehide", handler);
  }, [activeSong]);

  const updateState = useCallback((patch: Partial<SongState>) => {
    setSongState((current) => {
      const next = { ...current, ...patch };
      stateRef.current = next;
      return next;
    });
  }, []);

  const seekPlayback = player.seek;
  const togglePlayback = player.toggle;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "SELECT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (typing || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;

      if (event.key === "Escape") {
        setSettingsOpen(false);
        setHandSetupOpen(false);
        setImportOpen(false);
        setContextOpen(false);
        setLibraryOpen(false);
        setPinnedCueRefs({});
        setTransientCueId(null);
        setTransientEventIds(new Set());
        return;
      }
      if (settingsOpen || handSetupOpen || !activeSong) return;

      const key = event.key.toLowerCase();
      if (event.code === "Space") {
        event.preventDefault();
        togglePlayback();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekPlayback(Math.max(0, playerTimeRef.current - 2));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        seekPlayback(Math.min(duration, playerTimeRef.current + 2));
      } else if (key === "a") {
        updateState({
          loop_start_seconds: Math.max(
            0,
            Math.min(
              playerTimeRef.current - loopOffsetSeconds,
              rawLoopEnd - 0.08,
            ),
          ),
          active_loop_id: null,
        });
      } else if (key === "b") {
        updateState({
          loop_end_seconds: Math.max(
            stateRef.current.loop_start_seconds + 0.08,
            Math.min(
              duration,
              playerTimeRef.current - loopOffsetSeconds,
            ),
          ),
          active_loop_id: null,
        });
      } else if (key === "l") {
        updateState({ loop_enabled: !stateRef.current.loop_enabled });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeSong,
    duration,
    handSetupOpen,
    loopEnd,
    loopOffsetSeconds,
    rawLoopEnd,
    seekPlayback,
    settingsOpen,
    togglePlayback,
    updateState,
  ]);

  const handleUpload = useCallback(
    async (file: File, title: string, contextText: string) => {
      setUploading(true);
      setAppError(null);
      try {
        const song = await uploadSong(file, title, contextText);
        setSongs((current) => [song, ...current.filter((item) => item.id !== song.id)]);
        setNotes([]);
        setBarTimings([]);
        setPinnedCueRefs({});
        setTransientCueId(null);
        setTransientEventIds(new Set());
        setActiveSong(song);
        setSongState(stateFromSong(song));
        setBackendOnline(true);
        setImportOpen(false);
      } catch (error) {
        setAppError(error instanceof Error ? error.message : "Upload failed.");
      } finally {
        setUploading(false);
      }
    },
    [],
  );

  const handleDelete = useCallback(
    async (song: SongListItem) => {
      if (!window.confirm(`Remove “${song.title}” and its saved practice data?`)) return;
      try {
        await deleteSong(song.id);
        const remaining = songs.filter((item) => item.id !== song.id);
        setSongs(remaining);
        if (activeSong?.id === song.id) {
          setActiveSong(null);
          setSongState(EMPTY_STATE);
          setNotes([]);
          setBarTimings([]);
          if (remaining[0]) void openSong(remaining[0].id);
        }
      } catch (error) {
        setAppError(error instanceof Error ? error.message : "Could not remove song.");
      }
    },
    [activeSong, openSong, songs],
  );

  const handleAnalyze = useCallback(async () => {
    if (!activeSong) return;
    setAnalyzing(true);
    setAnalysisStartedAt(Date.now());
    setAnalysisElapsed(0);
    setAnalysisError(null);
    try {
      const result = await analyzeSong(activeSong.id, aiSettings);
      setActiveSong((current) =>
        current
          ? {
              ...current,
              analysis: result.analysis,
              analysis_provider: result.provider,
              analysis_model: result.model,
              analysis_updated_at: result.updated_at,
              analysis_is_stale: false,
              has_analysis: true,
            }
          : current,
      );
      setSongs((current) =>
        current.map((song) =>
          song.id === activeSong.id ? { ...song, has_analysis: true } : song,
        ),
      );
      const balancedRoute = result.analysis.routes.find((route) => route.id === "balanced");
      const firstId = balancedRoute?.unit_ids[0] ?? null;
      setExpandedUnit(firstId);
      updateState({ selected_unit_id: firstId, practice_route: "balanced" });
    } catch (error) {
      setAnalysisError(
        error instanceof Error ? error.message : "Analysis could not be completed.",
      );
    } finally {
      setAnalyzing(false);
      setAnalysisStartedAt(null);
    }
  }, [activeSong, aiSettings, updateState]);

  const saveContext = useCallback(async () => {
    if (!activeSong) return;
    setContextSaving(true);
    try {
      const updated = await updateSongContext(activeSong.id, contextDraft);
      setActiveSong(updated);
      setSongs((current) => current.map((song) =>
        song.id === updated.id ? { ...song, title: updated.title, updated_at: updated.updated_at } : song,
      ));
      setContextOpen(false);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "Could not save piece context.");
    } finally {
      setContextSaving(false);
    }
  }, [activeSong, contextDraft]);

  const selectedUnit = useMemo(() => {
    if (!activeSong?.analysis || !songState.selected_unit_id) return null;
    return (
      activeSong.analysis.practice_units.find(
        (unit) => unit.id === songState.selected_unit_id,
      ) ?? null
    );
  }, [activeSong, songState.selected_unit_id]);

  const selectedRoute = useMemo(() => {
    if (!activeSong?.analysis || songState.practice_route === "structured") return null;
    return activeSong.analysis.routes.find((route) => route.id === songState.practice_route)
      ?? activeSong.analysis.routes[0]
      ?? null;
  }, [activeSong, songState.practice_route]);

  const orderedUnits = useMemo(() => {
    if (!activeSong?.analysis) return [];
    if (songState.practice_route === "structured") {
      return [...activeSong.analysis.practice_units].sort(
        (a, b) =>
          a.timing.start_bar - b.timing.start_bar ||
          a.timing.end_bar - b.timing.end_bar,
      );
    }
    if (!selectedRoute) return [];
    const unitMap = new Map(activeSong.analysis.practice_units.map((unit) => [unit.id, unit]));
    return selectedRoute.unit_ids
      .map((unitId) => unitMap.get(unitId))
      .filter((unit): unit is PracticeUnit => Boolean(unit));
  }, [activeSong, selectedRoute, songState.practice_route]);

  const routeRationale =
    songState.practice_route === "structured"
      ? "Work from the opening: learn one bar, connect it to the next, then isolate only the notes that keep failing."
      : selectedRoute?.rationale;

  const selectPracticeMode = useCallback(
    (mode: PracticeMode) => {
      if (mode !== "structured" || !activeSong?.analysis) {
        updateState({ practice_route: mode });
        return;
      }
      const chronological = [...activeSong.analysis.practice_units].sort(
        (a, b) =>
          a.timing.start_bar - b.timing.start_bar ||
          a.timing.end_bar - b.timing.end_bar,
      );
      const savedUnitId = songState.selected_structured_step_id?.split(":")[1];
      const resumeUnit =
        chronological.find((unit) => unit.id === savedUnitId) ??
        chronological.find(
          (unit) => !songState.completed_unit_ids.includes(unit.id),
        ) ??
        chronological[0];
      setExpandedUnit(resumeUnit?.id ?? null);
      updateState({
        practice_route: mode,
        selected_unit_id: resumeUnit?.id ?? null,
      });
    },
    [
      activeSong,
      songState.completed_unit_ids,
      songState.selected_structured_step_id,
      updateState,
    ],
  );

  const eventMap = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes]);

  const pinnedCueIds = useMemo(() => new Set(Object.keys(pinnedCueRefs)), [pinnedCueRefs]);

  const highlightedEventIds = useMemo(
    () => new Set([...Object.values(pinnedCueRefs).flat(), ...transientEventIds]),
    [pinnedCueRefs, transientEventIds],
  );

  const previewCue = useCallback((ids: string[]) => {
    const referenced = ids
      .map((id) => eventMap.get(id))
      .filter((note): note is MidiNote => Boolean(note));
    if (!referenced.length) return;
    const firstTime = Math.min(...referenced.map((note) => note.time));
    const unitStart = selectedUnit?.timing.start_seconds ?? 0;
    seekPlayback(Math.max(unitStart, firstTime - 0.75));
  }, [eventMap, seekPlayback, selectedUnit]);

  const highlightCue = useCallback((id: string, ids: string[]) => {
    setTransientCueId(id);
    setTransientEventIds(new Set(ids));
  }, []);

  const clearHighlight = useCallback(() => {
    setTransientCueId(null);
    setTransientEventIds(new Set());
  }, []);

  const pinCue = useCallback((id: string, ids: string[]) => {
    setPinnedCueRefs((current) => {
      const next = { ...current };
      if (next[id]) delete next[id];
      else next[id] = ids;
      return next;
    });
  }, []);

  const activateStructuredLoop = useCallback(
    (loop: StructuredLoop) => {
      updateState({
        loop_start_seconds: loop.startSeconds,
        loop_end_seconds: loop.endSeconds,
        loop_enabled: true,
        active_loop_id: null,
        selected_structured_step_id: loop.id,
      });
      player.seek(loop.startSeconds + loopOffsetSeconds);
    },
    [loopOffsetSeconds, player, updateState],
  );

  const toggleStructuredStep = useCallback(
    (stepId: string) => {
      const isComplete =
        songState.completed_structured_step_ids.includes(stepId);
      updateState({
        completed_structured_step_ids: isComplete
          ? songState.completed_structured_step_ids.filter((id) => id !== stepId)
          : [...songState.completed_structured_step_ids, stepId],
      });
    },
    [songState.completed_structured_step_ids, updateState],
  );

  const practiceUnit = useCallback(
    (unit: PracticeUnit) => {
      updateState({
        selected_unit_id: unit.id,
        loop_start_seconds: unit.timing.start_seconds,
        loop_end_seconds: unit.timing.end_seconds,
        loop_enabled: true,
        active_loop_id: null,
      });
      setExpandedUnit(unit.id);
      player.seek(unit.timing.start_seconds + loopOffsetSeconds);
    },
    [loopOffsetSeconds, player, updateState],
  );

  const toggleUnitComplete = useCallback(
    (unitId: string) => {
      const complete = songState.completed_unit_ids.includes(unitId);
      updateState({
        completed_unit_ids: complete
          ? songState.completed_unit_ids.filter((id) => id !== unitId)
          : [...songState.completed_unit_ids, unitId],
      });
    },
    [songState.completed_unit_ids, updateState],
  );

  const saveLoop = useCallback(() => {
    if (rawLoopEnd - rawLoopStart < 0.08) {
      setAppError("Set B after A before saving this loop.");
      return;
    }
    const label =
      selectedUnit?.title ??
      `Loop ${formatTime(loopStart)}–${formatTime(loopEnd)}`;
    const saved: SavedLoop = {
      id: crypto.randomUUID(),
      label,
      start_seconds: songState.loop_start_seconds,
      end_seconds: rawLoopEnd,
      hand_mode: songState.hand_mode,
      updated_at: new Date().toISOString(),
    };
    updateState({
      saved_loops: [
        saved,
        ...songState.saved_loops.filter(
          (loop) =>
            Math.abs(loop.start_seconds - saved.start_seconds) > 0.02 ||
            Math.abs(loop.end_seconds - saved.end_seconds) > 0.02,
        ),
      ].slice(0, 20),
      active_loop_id: saved.id,
      loop_enabled: true,
    });
  }, [
    loopEnd,
    loopStart,
    rawLoopEnd,
    rawLoopStart,
    selectedUnit,
    songState.hand_mode,
    songState.loop_start_seconds,
    songState.saved_loops,
    updateState,
  ]);

  const chooseLoop = useCallback(
    (loop: SavedLoop) => {
      updateState({
        loop_start_seconds: loop.start_seconds,
        loop_end_seconds: loop.end_seconds,
        loop_enabled: true,
        active_loop_id: loop.id,
        hand_mode: loop.hand_mode,
      });
      player.seek(loop.start_seconds + loopOffsetSeconds);
    },
    [loopOffsetSeconds, player, updateState],
  );

  const assignTrack = useCallback(
    (trackIndex: number, assignment: TrackAssignment) => {
      const nextAssignments = {
        ...songState.track_assignments,
        [String(trackIndex)]: assignment,
      };
      updateState({
        track_assignments: nextAssignments,
      });
      setActiveSong((current) =>
        current?.analysis ? { ...current, analysis_is_stale: true } : current,
      );
      if (activeSong) {
        const nextState = { ...songState, track_assignments: nextAssignments };
        void saveSongState(activeSong.id, nextState)
          .then(() => loadEvents(activeSong.id))
          .catch(() => setAppError("Could not save the hand mapping."));
      }
    },
    [activeSong, loadEvents, songState, updateState],
  );

  const updateSplitPitch = useCallback((splitPitch: number) => {
    updateState({ split_pitch: splitPitch });
    setActiveSong((current) =>
      current?.analysis ? { ...current, analysis_is_stale: true } : current,
    );
    if (activeSong) {
      const nextState = { ...songState, split_pitch: splitPitch };
      void saveSongState(activeSong.id, nextState)
        .then(() => loadEvents(activeSong.id))
        .catch(() => setAppError("Could not save the split point."));
    }
  }, [activeSong, loadEvents, songState, updateState]);

  const completedCount = activeSong?.analysis
    ? activeSong.analysis.practice_units.filter((unit) =>
        songState.completed_unit_ids.includes(unit.id),
      ).length
    : 0;

  return (
    <main className="app-shell">
      <section className="practice-stage">
        <div className="workspace-topbar">
          <div className="workspace-brand">
            <span className="brand-mark">
              {/* eslint-disable-next-line @next/next/no-img-element -- direct local asset avoids the unsupported image optimizer in the LAN runtime. */}
              <img src="/midiocre-logo.png" alt="MIDIocre logo" />
            </span>
            <span>
              <strong>MIDIocre</strong>
              <small>Piano Tutor</small>
            </span>
          </div>
          <div className="workspace-actions">
            <button className="secondary-action" onClick={() => setLibraryOpen(true)}>
              <FolderOpen size={17} /> Library
              <span className="library-count">{songs.length}</span>
            </button>
            <button
              className="secondary-action"
              disabled={uploading || backendOnline === false}
              onClick={() => setImportOpen(true)}
            >
              {uploading ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
              {uploading ? "Importing…" : "Import MIDI"}
            </button>
            <button
              className="secondary-action theme-toggle"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
              {theme === "dark" ? "Light" : "Dark"}
            </button>
          </div>
        </div>
        {appError && (
          <div className="app-alert">
            <CircleAlert size={16} />
            <span>{appError}</span>
            <button onClick={() => setAppError(null)} aria-label="Dismiss"><X size={15} /></button>
          </div>
        )}

        {!activeSong ? (
          <div className="empty-workspace">
            <div className="empty-orbit"><Music2 size={27} /></div>
            <span className="eyebrow">Start with a clean MIDI</span>
            <h1>Turn a piece into a practice plan.</h1>
            <p>
              Import a piano MIDI to hear each hand, set loops, and ask your AI
              tutor to find the shortcuts hidden in the pattern.
            </p>
            <button
              className="primary-action"
              disabled={backendOnline === false}
              onClick={() => setImportOpen(true)}
            >
              <Plus size={18} /> Import your first piece
            </button>
            {backendOnline === false && (
              <p className="backend-help">
                Start the Python backend at <code>127.0.0.1:8000</code>, then refresh.
              </p>
            )}
          </div>
        ) : (
          <>
            <header className="piece-header">
              <div>
                <span className="eyebrow">
                  {activeSong.metadata.bars} bars · {activeSong.metadata.time_signature} ·{" "}
                  {Math.round(activeSong.metadata.tempo_bpm)} BPM
                </span>
                <h1>{activeSong.title}</h1>
              </div>
              <div className="piece-header-actions">
                <div className="resume-badge">
                  <span>Resume</span>
                  <strong>{formatTime(player.currentTime)}</strong>
                </div>
                <button
                  className="secondary-action"
                  onClick={() => {
                    setContextDraft({ title: activeSong.title, context_text: activeSong.context_text });
                    setContextOpen(true);
                  }}
                >
                  <FilePenLine size={16} /> Piece context
                </button>
                <button className="secondary-action" onClick={() => setHandSetupOpen(true)}>
                  <Settings2 size={16} /> Hand setup
                </button>
              </div>
            </header>

            <div className="roll-card">
              {songLoading && <div className="roll-loading"><LoaderCircle className="spin" /> Opening piece</div>}
              <div className="roll-toolbar">
                <div className="hand-legend">
                  <span><i className="left-dot" /> Left hand</span>
                  <span><i className="right-dot" /> Right hand</span>
                </div>
                <span className="keyboard-hint">
                  Drag roll to seek · pinch to zoom · two-finger drag to move keys
                </span>
                <div className="roll-controls">
                  <label title="More vertical space shows fewer seconds">
                    <span>Time</span>
                    <input
                      aria-label="Falling-note vertical zoom"
                      type="range"
                      min="0.6"
                      max="3"
                      step="0.1"
                      value={songState.roll_zoom}
                      onChange={(event) => updateState({ roll_zoom: Number(event.target.value) })}
                    />
                    <b>{songState.roll_zoom.toFixed(1)}×</b>
                  </label>
                  <label title="Stretch the keyboard and note lanes horizontally">
                    <span>Keys</span>
                    <input
                      aria-label="Keyboard horizontal zoom"
                      type="range"
                      min="1"
                      max="3"
                      step="0.1"
                      value={songState.roll_horizontal_zoom}
                      onChange={(event) =>
                        updateState({
                          roll_horizontal_zoom: Number(event.target.value),
                        })
                      }
                    />
                    <b>{songState.roll_horizontal_zoom.toFixed(1)}×</b>
                  </label>
                  <button
                    className={`visibility-toggle ${songState.note_visibility === "enhanced" ? "active" : ""}`}
                    onClick={() => updateState({ note_visibility: songState.note_visibility === "enhanced" ? "accurate" : "enhanced" })}
                    title="Make very short notes easier to see"
                  >
                    {songState.note_visibility === "enhanced" ? "Enhanced notes" : "Exact notes"}
                  </button>
                </div>
                <div className="instrument-label">
                  <span className={player.instrumentReady ? "ready" : ""} />
                  {player.instrumentReady ? "Sampled grand" : "Piano synth"}
                </div>
              </div>
              <div className="piano-roll-wrap">
                <PianoRoll
                  notes={notes}
                  currentTime={player.currentTime}
                  duration={duration}
                  handMode={songState.hand_mode}
                  loopStart={loopStart}
                  loopEnd={loopEnd}
                  loopEnabled={songState.loop_enabled}
                  loopDelayGapSeconds={loopDelayGapSeconds}
                  loopDelayRemainingSeconds={player.loopDelayRemainingSeconds}
                  isLoopDelaying={player.isLoopDelaying}
                  selectedUnit={selectedUnit}
                  rollZoom={songState.roll_zoom}
                  horizontalZoom={songState.roll_horizontal_zoom}
                  horizontalPan={songState.roll_horizontal_pan}
                  noteVisibility={songState.note_visibility}
                  highlightedEventIds={highlightedEventIds}
                  onSeek={player.seek}
                  onRollZoom={(roll_zoom) => updateState({ roll_zoom })}
                  onHorizontalZoom={(roll_horizontal_zoom) =>
                    updateState({ roll_horizontal_zoom })
                  }
                  onHorizontalPan={(roll_horizontal_pan) =>
                    updateState({ roll_horizontal_pan })
                  }
                />
              </div>
              <Transport
                currentTime={player.currentTime}
                duration={duration}
                isPlaying={player.isPlaying}
                speed={songState.speed}
                handMode={songState.hand_mode}
                loopEnabled={songState.loop_enabled}
                metronomeEnabled={songState.metronome_enabled}
                loopDelayEnabled={songState.loop_delay_enabled}
                loopDelayBeats={songState.loop_delay_beats}
                loopTimingOffsetMs={songState.loop_timing_offset_ms}
                beatsPerBar={beatsPerBar}
                isLoopDelaying={player.isLoopDelaying}
                loopStart={loopStart}
                loopEnd={loopEnd}
                savedLoops={songState.saved_loops}
                onToggle={player.toggle}
                onSeek={player.seek}
                onSpeed={(speed) => updateState({ speed })}
                onHandMode={(hand_mode: HandMode) => updateState({ hand_mode })}
                onSetA={() =>
                  updateState({
                    loop_start_seconds: Math.min(
                      Math.max(0, player.currentTime - loopOffsetSeconds),
                      rawLoopEnd - 0.08,
                    ),
                    active_loop_id: null,
                  })
                }
                onSetB={() =>
                  updateState({
                    loop_end_seconds: Math.max(
                      songState.loop_start_seconds + 0.08,
                      Math.min(
                        duration,
                        player.currentTime - loopOffsetSeconds,
                      ),
                    ),
                    active_loop_id: null,
                  })
                }
                onToggleLoop={() => updateState({ loop_enabled: !songState.loop_enabled })}
                onToggleMetronome={() =>
                  updateState({ metronome_enabled: !songState.metronome_enabled })
                }
                onToggleLoopDelay={() =>
                  updateState({ loop_delay_enabled: !songState.loop_delay_enabled })
                }
                onLoopDelayBeats={(loop_delay_beats) =>
                  updateState({ loop_delay_beats })
                }
                onLoopTimingOffset={(loop_timing_offset_ms) =>
                  updateState({ loop_timing_offset_ms })
                }
                onSaveLoop={saveLoop}
                onChooseLoop={chooseLoop}
              />
            </div>
          </>
        )}
      </section>

      <aside className="tutor-panel">
        <div className="tutor-header">
          <div>
            <span className="eyebrow">Your tutor</span>
            <h2>Practice map</h2>
          </div>
          <button className="quiet-icon" onClick={() => setSettingsOpen(true)} aria-label="AI settings">
            <Settings2 size={18} />
          </button>
        </div>

        {!activeSong ? (
          <div className="tutor-placeholder">
            <Sparkles size={22} />
            <p>The tutor will turn your piece into small, concrete things to solve.</p>
          </div>
        ) : !activeSong.analysis ? (
          <div className="analysis-start">
            <div className="analysis-glyph"><Sparkles size={23} /></div>
            <h3>Find the shortcuts</h3>
            <p>
              Analyze the hands, repeated shapes, coordination points, and likely
              bottlenecks. Your MIDI stays local; only a compact symbolic summary
              is sent to the selected model.
            </p>
            <div className="provider-pill">
              <span>{aiSettings.provider === "openai" ? "OpenAI" : "Ollama"}</span>
              <strong>{aiSettings.model}</strong>
            </div>
            <button className="primary-action full" onClick={() => void handleAnalyze()} disabled={analyzing}>
              {analyzing ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}
              {analyzing ? `Studying the piece… ${analysisElapsed}s` : "Analyze this piece"}
            </button>
            {analysisError && <div className="analysis-error">{analysisError}</div>}
            <button className="text-button" onClick={() => setSettingsOpen(true)}>
              Configure AI provider
            </button>
          </div>
        ) : (
          <div className="analysis-content">
            {activeSong.analysis_is_stale && (
              <div className="stale-analysis">
                <CircleAlert size={15} />
                <span>Hand mapping changed. This practice map may be out of date.</span>
                <button onClick={() => void handleAnalyze()}>Regenerate</button>
              </div>
            )}
            {activeSong.analysis.legacy_analysis && (
              <div className="legacy-analysis-note">
                <Sparkles size={14} />
                <span>Regenerate this map to add musical context and interactive note landmarks.</span>
              </div>
            )}
            <div className="route-picker">
              <span className="card-kicker">Practice route</span>
              <div className="segmented route-segmented" aria-label="Practice route">
                {(["structured", "balanced", "challenge"] as const).map((routeId) => {
                  return (
                    <button
                      key={routeId}
                      className={songState.practice_route === routeId ? "active" : ""}
                      onClick={() => selectPracticeMode(routeId)}
                    >
                      {routeId === "structured"
                        ? "Structured"
                        : routeId === "balanced"
                          ? "Balanced"
                          : "Challenge"}
                    </button>
                  );
                })}
              </div>
              <p>{routeRationale}</p>
            </div>

            {songState.practice_route === "structured" ? (
              <div className="structured-route-summary">
                <strong>Chronological, concrete, and quiet.</strong>
                <span>The detailed AI commentary stays folded unless you ask for it.</span>
                <div className="unit-progress">
                  <span>{completedCount} of {activeSong.analysis.practice_units.length} sections complete</span>
                  <i>
                    <b
                      style={{
                        width: `${(completedCount / activeSong.analysis.practice_units.length) * 100}%`,
                      }}
                    />
                  </i>
                </div>
              </div>
            ) : (
              <>
                <div className="analysis-overview">
                  <div className="analysis-meta">
                    <span>{activeSong.analysis_provider}</span>
                    <span>{activeSong.analysis_model}</span>
                  </div>
                  <p>{activeSong.analysis.overview}</p>
                  <div className="character-card">
                    <div>
                      <span className="card-kicker">Musical character</span>
                      <strong>{activeSong.analysis.musical_character.style_hint ?? "Piece-specific shape"}</strong>
                    </div>
                    <p>{activeSong.analysis.musical_character.summary}</p>
                    <small>{activeSong.analysis.musical_character.confidence} confidence · based on {activeSong.analysis.musical_character.basis}</small>
                  </div>
                  <div className="unit-progress">
                    <span>{completedCount} of {activeSong.analysis.practice_units.length} units complete</span>
                    <i>
                      <b
                        style={{
                          width: `${(completedCount / activeSong.analysis.practice_units.length) * 100}%`,
                        }}
                      />
                    </i>
                  </div>
                </div>

                <div className="strategy-card">
                  <span className="card-kicker">Whole-piece strategy</span>
                  <ol>
                    {activeSong.analysis.player_strategy.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ol>
                </div>

                <p className="cue-hint">Hover or focus a cue to see its notes. Click the cue text to seek there; use the pin button to keep multiple cues highlighted.</p>
              </>
            )}

            <div className="unit-list">
              {orderedUnits.map((unit, orderIndex) => {
                const expanded = expandedUnit === unit.id;
                const complete = songState.completed_unit_ids.includes(unit.id);
                return (
                  <article
                    className={`practice-unit ${songState.practice_route === "structured" ? "structured-unit" : ""} ${expanded ? "expanded" : ""} ${complete ? "complete" : ""}`}
                    key={unit.id}
                  >
                    <button
                      className={`unit-summary ${songState.practice_route === "structured" ? "structured-summary" : ""}`}
                      onClick={() => {
                        setPinnedCueRefs({});
                        setTransientCueId(null);
                        setTransientEventIds(new Set());
                        setExpandedUnit(expanded ? null : unit.id);
                        updateState({ selected_unit_id: unit.id });
                      }}
                    >
                      <span className="unit-index">{complete ? <Check size={14} /> : orderIndex + 1}</span>
                      <span className="unit-heading">
                        <strong>
                          {songState.practice_route === "structured"
                            ? `Section ${orderIndex + 1} · Bars ${unit.timing.start_bar}–${unit.timing.end_bar}`
                            : unit.title}
                        </strong>
                        <span>
                          {songState.practice_route === "structured" && `${unit.title} · `}
                          {formatTime(unit.timing.start_seconds)}–{formatTime(unit.timing.end_seconds)}
                        </span>
                      </span>
                      {songState.practice_route !== "structured" && (
                        <span className={`difficulty difficulty-${unit.difficulty}`} aria-label={`Challenge ${unit.difficulty} of 5`} title={`Challenge ${unit.difficulty} of 5`}>
                          {Array.from({ length: 5 }).map((_, index) => <i key={index} />)}
                        </span>
                      )}
                      {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </button>
                    {expanded && (
                      <div className={`unit-details ${songState.practice_route === "structured" ? "structured-unit-details" : ""}`}>
                        {songState.practice_route === "structured" ? (
                          <>
                            <StructuredPractice
                              unit={unit}
                              bars={barTimings}
                              beatsPerBar={Number(activeSong.metadata.time_signature.split("/")[0]) || 4}
                              selectedStepId={songState.selected_structured_step_id}
                              completedStepIds={songState.completed_structured_step_ids}
                              currentLoopStart={songState.loop_start_seconds}
                              currentLoopEnd={rawLoopEnd}
                              onActivate={activateStructuredLoop}
                              onToggleComplete={toggleStructuredStep}
                            />
                            <details className={`structured-teacher-notes ${unit.difficulty >= 4 ? "recommended" : ""}`}>
                              <summary>
                                <span>
                                  {unit.difficulty >= 4
                                    ? "Difficult section — show teacher notes"
                                    : "Need help? Show teacher notes"}
                                </span>
                                <small>AI detail stays out of the way until you need it.</small>
                              </summary>
                              <div className="structured-teacher-notes-body">
                                <p className="cue-hint">Hover or focus a cue to see its notes. Click its text to seek; use the pin to keep it visible.</p>
                                <UnitTeacherNotes
                                  unit={unit}
                                  eventMap={eventMap}
                                  transientCueId={transientCueId}
                                  pinnedCueIds={pinnedCueIds}
                                  onHighlight={highlightCue}
                                  onClear={clearHighlight}
                                  onPreview={previewCue}
                                  onPin={pinCue}
                                />
                              </div>
                            </details>
                          </>
                        ) : (
                          <UnitTeacherNotes
                            unit={unit}
                            eventMap={eventMap}
                            transientCueId={transientCueId}
                            pinnedCueIds={pinnedCueIds}
                            onHighlight={highlightCue}
                            onClear={clearHighlight}
                            onPreview={previewCue}
                            onPin={pinCue}
                          />
                        )}
                        <div className="unit-actions">
                          {songState.practice_route !== "structured" && (
                            <button className="primary-action small" onClick={() => practiceUnit(unit)}>
                              <Play size={14} fill="currentColor" /> Practice this loop
                            </button>
                          )}
                          <button
                            className={`secondary-action small ${complete ? "complete-action" : ""}`}
                            onClick={() => toggleUnitComplete(unit.id)}
                          >
                            <Check size={14} /> {complete ? "Completed" : "Mark complete"}
                          </button>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>

            <button className="regenerate-button" onClick={() => void handleAnalyze()} disabled={analyzing}>
              {analyzing ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
              Regenerate practice map
            </button>
            {analysisError && <div className="analysis-error">{analysisError}</div>}
          </div>
        )}
      </aside>

      {libraryOpen && (
        <SongLibraryDialog
          songs={songs}
          activeSongId={activeSong?.id ?? null}
          loading={libraryLoading}
          importing={uploading}
          backendOnline={backendOnline}
          onClose={() => setLibraryOpen(false)}
          onOpen={(songId) => void openSong(songId)}
          onDelete={(song) => void handleDelete(song)}
          onImport={() => {
            setLibraryOpen(false);
            setImportOpen(true);
          }}
        />
      )}

      {settingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <section className="settings-modal" role="dialog" aria-modal="true" aria-label="AI settings" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <span className="eyebrow">Analysis layer</span>
                <h2>AI tutor settings</h2>
              </div>
              <button className="quiet-icon" onClick={() => setSettingsOpen(false)}><X size={18} /></button>
            </div>
            <div className="provider-tabs">
              {(["openai", "ollama"] as const).map((provider) => (
                <button
                  key={provider}
                  className={aiSettings.provider === provider ? "active" : ""}
                  onClick={() =>
                    persistAiPreferences({
                      ...aiSettings,
                      provider,
                      model: provider === "openai" ? "gpt-5.6-sol" : "qwen3:8b",
                    })
                  }
                >
                  {provider === "openai" ? "OpenAI API" : "Local Ollama"}
                </button>
              ))}
            </div>

            {aiSettings.provider === "openai" ? (
              <>
                <label className="field">
                  <span>Model</span>
                  <select
                    value={aiSettings.model}
                    onChange={(event) => persistAiPreferences({ ...aiSettings, model: event.target.value })}
                  >
                    <option value="gpt-5.6-sol">GPT-5.6 Sol · deepest analysis</option>
                    <option value="gpt-5.6-terra">GPT-5.6 Terra · balanced</option>
                    <option value="gpt-5.6-luna">GPT-5.6 Luna · economical</option>
                  </select>
                </label>
                <label className="field">
                  <span>Reasoning depth</span>
                  <select
                    value={aiSettings.reasoningEffort}
                    onChange={(event) => persistAiPreferences({ ...aiSettings, reasoningEffort: event.target.value as "low" | "medium" })}
                  >
                    <option value="low">Faster · focused tutor map</option>
                    <option value="medium">Deeper · more deliberation</option>
                  </select>
                  <small>Use Deeper when a piece has unusual structure or the first map needs another pass.</small>
                </label>
                <label className="field">
                  <span>API key</span>
                  <input
                    type="password"
                    value={aiSettings.apiKey}
                    placeholder="Uses OPENAI_API_KEY when left blank"
                    onChange={(event) => setAiSettings({ ...aiSettings, apiKey: event.target.value })}
                    autoComplete="off"
                  />
                  <small>A pasted key stays in this browser tab and is never stored with a song.</small>
                </label>
              </>
            ) : (
              <>
                <label className="field">
                  <span>Installed model name</span>
                  <input
                    value={aiSettings.model}
                    onChange={(event) => persistAiPreferences({ ...aiSettings, model: event.target.value })}
                    placeholder="qwen3:8b"
                  />
                </label>
                <label className="field">
                  <span>Ollama URL</span>
                  <input
                    value={aiSettings.ollamaBaseUrl}
                    onChange={(event) =>
                      persistAiPreferences({ ...aiSettings, ollamaBaseUrl: event.target.value })
                    }
                  />
                  <small>Only localhost and loopback addresses are accepted.</small>
                </label>
              </>
            )}
            <div className="privacy-note">
              <Sparkles size={16} />
              <p>
                The model receives bar-by-bar note events, hand labels, timing, and the
                context you provide—not the original MIDI file. Every response must match
                analysis schema v1.1
                before it can be saved.
              </p>
            </div>
            <button className="primary-action full" onClick={() => setSettingsOpen(false)}>Done</button>
          </section>
        </div>
      )}

      {handSetupOpen && activeSong && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setHandSetupOpen(false)}>
          <section className="settings-modal hand-modal" role="dialog" aria-modal="true" aria-label="Hand setup" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <span className="eyebrow">Non-destructive mapping</span>
                <h2>Which track plays which hand?</h2>
              </div>
              <button className="quiet-icon" onClick={() => setHandSetupOpen(false)}><X size={18} /></button>
            </div>
            <p className="modal-intro">
              The original MIDI is never changed. This mapping controls playback and
              what the tutor sees.
            </p>
            <div className="track-list">
              {activeSong.metadata.tracks.map((track) => (
                <label className="track-row" key={track.index}>
                  <span>
                    <strong>{track.name}</strong>
                    <small>{track.note_count} notes · range {track.min_pitch}–{track.max_pitch}</small>
                  </span>
                  <select
                    value={songState.track_assignments[String(track.index)] ?? track.suggested_assignment}
                    onChange={(event) => assignTrack(track.index, event.target.value as TrackAssignment)}
                  >
                    <option value="left">Left hand</option>
                    <option value="right">Right hand</option>
                    <option value="split">Split by pitch</option>
                    <option value="ignore">Ignore track</option>
                  </select>
                </label>
              ))}
            </div>
            <label className="split-field">
              <span>
                <strong>Split point</strong>
                <small>Used only for tracks set to “Split by pitch”</small>
              </span>
              <input
                type="range"
                min={40}
                max={76}
                value={songState.split_pitch}
                onChange={(event) => updateSplitPitch(Number(event.target.value))}
              />
              <b>{songState.split_pitch}</b>
            </label>
            {activeSong.analysis && (
              <div className="mapping-warning">
                <CircleAlert size={16} />
                Regenerate the practice map after changing hand assignments.
              </div>
            )}
            <button className="primary-action full" onClick={() => setHandSetupOpen(false)}>Use this mapping</button>
          </section>
        </div>
      )}

      {importOpen && (
        <ImportSongDialog
          busy={uploading}
          onClose={() => !uploading && setImportOpen(false)}
          onSubmit={(file, title, contextText) => void handleUpload(file, title, contextText)}
        />
      )}

      {contextOpen && activeSong && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => !contextSaving && setContextOpen(false)}>
          <section className="settings-modal context-modal" role="dialog" aria-modal="true" aria-label="Piece context" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <span className="eyebrow">Tutor context</span>
                <h2>What should the tutor know?</h2>
              </div>
              <button className="quiet-icon" onClick={() => setContextOpen(false)} aria-label="Close piece context"><X size={18} /></button>
            </div>
            <label className="field">
              <span>Piece title</span>
              <input value={contextDraft.title} onChange={(event) => setContextDraft({ ...contextDraft, title: event.target.value })} maxLength={160} />
            </label>
            <label className="field">
              <span>Piece context for your tutor</span>
              <textarea value={contextDraft.context_text} onChange={(event) => setContextDraft({ ...contextDraft, context_text: event.target.value })} maxLength={4000} rows={8} />
              <small>{contextDraft.context_text.length}/4000 · Saving this makes the current analysis stale so it can use the new information.</small>
            </label>
            <div className="modal-actions">
              <button className="secondary-action" onClick={() => setContextOpen(false)} disabled={contextSaving}>Cancel</button>
              <button className="primary-action" onClick={() => void saveContext()} disabled={!contextDraft.title.trim() || contextSaving}>
                {contextSaving ? <LoaderCircle className="spin" size={16} /> : <FilePenLine size={16} />}
                {contextSaving ? "Saving…" : "Save context"}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
