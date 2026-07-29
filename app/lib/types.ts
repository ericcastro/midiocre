export type HandMode = "left" | "right" | "both";
export type TrackAssignment = "left" | "right" | "split" | "ignore";
export type PracticeMode = "balanced" | "challenge" | "structured";

export interface TrackSummary {
  index: number;
  name: string;
  channel: number | null;
  note_count: number;
  min_pitch: number;
  max_pitch: number;
  median_pitch: number;
  suggested_assignment: TrackAssignment;
}

export interface SongMetadata {
  duration_seconds: number;
  note_count: number;
  track_count: number;
  ppq: number;
  tempo_bpm: number;
  time_signature: string;
  key_signature: string | null;
  bars: number;
  tracks: TrackSummary[];
}

export interface SavedLoop {
  id: string;
  label: string;
  start_seconds: number;
  end_seconds: number;
  hand_mode: HandMode;
  updated_at: string;
}

export interface SongState {
  position_seconds: number;
  speed: number;
  hand_mode: HandMode;
  loop_enabled: boolean;
  metronome_enabled: boolean;
  loop_delay_enabled: boolean;
  loop_delay_beats: number | null;
  loop_timing_offset_ms: number;
  loop_start_seconds: number;
  loop_end_seconds: number | null;
  active_loop_id: string | null;
  saved_loops: SavedLoop[];
  completed_unit_ids: string[];
  selected_unit_id: string | null;
  practice_route: PracticeMode;
  completed_structured_step_ids: string[];
  selected_structured_step_id: string | null;
  roll_zoom: number;
  roll_horizontal_zoom: number;
  roll_horizontal_pan: number;
  note_visibility: "accurate" | "enhanced";
  split_pitch: number;
  track_assignments: Record<string, TrackAssignment>;
  total_practice_seconds: number;
  last_opened_at: string;
}

export interface PracticeTiming {
  start_seconds: number;
  end_seconds: number;
  start_tick: number;
  end_tick: number;
  start_bar: number;
  end_bar: number;
}

export interface PracticeStep {
  instruction: string;
  hand_mode: HandMode;
  tempo_percent: number;
  repetitions: number;
  event_refs: string[];
}

export interface ReferencedCue {
  id: string;
  hand: HandMode;
  text: string;
  event_refs: string[];
}

export interface Landmark {
  id: string;
  label: string;
  hand: HandMode;
  text: string;
  event_refs: string[];
}

export interface PracticeUnit {
  id: string;
  title: string;
  timing: PracticeTiming;
  hands: HandMode[];
  difficulty: number;
  challenge_reason: string;
  focus: string;
  pattern_summary: string;
  landmarks: Landmark[];
  cues: ReferencedCue[];
  steps: PracticeStep[];
  success_criteria: string[];
  common_traps: string[];
}

export interface PracticeRoute {
  id: "balanced" | "challenge";
  title: string;
  rationale: string;
  unit_ids: string[];
}

export interface MusicalCharacter {
  summary: string;
  style_hint: string | null;
  confidence: "low" | "medium" | "high";
  basis: "midi" | "user-context" | "both";
  evidence: string[];
  practice_implications: string[];
}

export interface PieceAnalysis {
  schema_version: "1.0" | "1.1";
  title: string;
  overview: string;
  musical_character: MusicalCharacter;
  player_strategy: string[];
  routes: PracticeRoute[];
  practice_units: PracticeUnit[];
  assumptions: string[];
  legacy_analysis?: boolean;
}

export interface SongListItem {
  id: string;
  title: string;
  filename: string;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
  duration_seconds: number;
  note_count: number;
  progress: number;
  has_analysis: boolean;
}

export interface SongDetail extends SongListItem {
  midi_url: string;
  metadata: SongMetadata;
  state: SongState;
  context_text: string;
  analysis: PieceAnalysis | null;
  analysis_provider: string | null;
  analysis_model: string | null;
  analysis_updated_at: string | null;
  analysis_is_stale: boolean;
}

export interface MidiNote {
  id: string;
  midi: number;
  name: string;
  time: number;
  duration: number;
  velocity: number;
  trackIndex: number;
  hand: "left" | "right";
  startTick: number;
  endTick: number;
  bar: number;
  beatOffset: number;
}

export interface AiSettings {
  provider: "openai" | "ollama";
  model: string;
  apiKey: string;
  ollamaBaseUrl: string;
  reasoningEffort: "low" | "medium";
}

export interface MidiEventResponse {
  id: string;
  midi: number;
  name: string;
  time: number;
  duration: number;
  velocity: number;
  start_tick: number;
  end_tick: number;
  track_index: number;
  hand: "left" | "right";
  bar: number;
  beat_offset: number;
}

export interface BarTiming {
  bar: number;
  start_seconds: number;
  end_seconds: number;
  start_tick: number;
  end_tick: number;
}
