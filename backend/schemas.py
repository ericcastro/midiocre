from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


HandMode = Literal["left", "right", "both"]
TrackAssignment = Literal["left", "right", "split", "ignore"]
CueHand = Literal["left", "right", "both"]
PracticeRouteId = Literal["balanced", "challenge"]
PracticeMode = Literal["balanced", "challenge", "structured"]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class TrackSummary(BaseModel):
    index: int
    name: str
    instrument_id: str = ""
    instrument_name: str = ""
    is_piano: bool = False
    default_selected: bool = True
    channel: int | None = None
    note_count: int
    min_pitch: int
    max_pitch: int
    median_pitch: float
    suggested_assignment: TrackAssignment


class SongMetadata(BaseModel):
    duration_seconds: float
    note_count: int
    track_count: int
    ppq: int
    tempo_bpm: float
    time_signature: str
    key_signature: str | None = None
    bars: int
    tracks: list[TrackSummary]


class MidiEvent(BaseModel):
    id: str
    midi: int = Field(ge=21, le=108)
    name: str
    time: float = Field(ge=0)
    duration: float = Field(gt=0)
    velocity: int = Field(ge=1, le=127)
    start_tick: int = Field(ge=0)
    end_tick: int = Field(gt=0)
    track_index: int = Field(ge=0)
    hand: Literal["left", "right"]
    bar: int = Field(ge=1)
    beat_offset: float = Field(ge=0)


class BarTiming(BaseModel):
    bar: int = Field(ge=1)
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)
    start_tick: int = Field(ge=0)
    end_tick: int = Field(gt=0)

    @model_validator(mode="after")
    def timing_is_forward(self) -> "BarTiming":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("Bar end_seconds must be after start_seconds")
        if self.end_tick <= self.start_tick:
            raise ValueError("Bar end_tick must be after start_tick")
        return self


class SavedLoop(BaseModel):
    id: str
    label: str
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)
    hand_mode: HandMode = "both"
    updated_at: str = Field(default_factory=utc_now_iso)

    @model_validator(mode="after")
    def end_after_start(self) -> "SavedLoop":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("Loop end must be after loop start")
        return self


class SongState(BaseModel):
    position_seconds: float = Field(default=0, ge=0)
    speed: float = Field(default=1, ge=0.25, le=1.5)
    hand_mode: HandMode = "both"
    loop_enabled: bool = False
    metronome_enabled: bool = False
    loop_delay_enabled: bool = False
    loop_delay_beats: int | None = Field(default=None, ge=1, le=6)
    loop_timing_offset_ms: int = Field(default=0, ge=-300, le=300)
    loop_start_seconds: float = Field(default=0, ge=0)
    loop_end_seconds: float | None = Field(default=None, gt=0)
    active_loop_id: str | None = None
    saved_loops: list[SavedLoop] = Field(default_factory=list)
    completed_unit_ids: list[str] = Field(default_factory=list)
    selected_unit_id: str | None = None
    practice_route: PracticeMode = "balanced"
    completed_structured_step_ids: list[str] = Field(default_factory=list)
    selected_structured_step_id: str | None = None
    roll_zoom: float = Field(default=1.0, ge=0.6, le=3.0)
    roll_horizontal_zoom: float = Field(default=1.0, ge=1.0, le=3.0)
    roll_horizontal_pan: float = Field(default=0.5, ge=0.0, le=1.0)
    note_visibility: Literal["accurate", "enhanced"] = "enhanced"
    split_pitch: int = Field(default=60, ge=21, le=108)
    track_assignments: dict[str, TrackAssignment] = Field(default_factory=dict)
    total_practice_seconds: float = Field(default=0, ge=0)
    last_opened_at: str = Field(default_factory=utc_now_iso)

    @model_validator(mode="before")
    @classmethod
    def migrate_legacy_loop_end_trim(cls, data: object) -> object:
        """Keep existing saved loops usable after replacing end trim with offset."""
        if not isinstance(data, dict) or "loop_timing_offset_ms" in data:
            return data
        legacy_trim = data.get("loop_end_trim_ms")
        if isinstance(legacy_trim, (int, float)):
            return {
                **data,
                "loop_timing_offset_ms": -min(300, max(0, round(legacy_trim))),
            }
        return data


class SongListItem(BaseModel):
    id: str
    title: str
    filename: str
    created_at: str
    updated_at: str
    last_opened_at: str | None = None
    duration_seconds: float
    note_count: int
    progress: float = Field(default=0, ge=0, le=1)
    has_analysis: bool = False


class SongDetail(SongListItem):
    midi_url: str
    metadata: SongMetadata
    state: SongState
    context_text: str = ""
    analysis: "PieceAnalysisView | None" = None
    analysis_provider: str | None = None
    analysis_model: str | None = None
    analysis_updated_at: str | None = None
    analysis_is_stale: bool = False


class PracticeTiming(BaseModel):
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)
    start_tick: int = Field(ge=0)
    end_tick: int = Field(gt=0)
    start_bar: int = Field(ge=1)
    end_bar: int = Field(ge=1)

    @model_validator(mode="after")
    def timing_is_forward(self) -> "PracticeTiming":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("Practice unit end_seconds must be after start_seconds")
        if self.end_tick <= self.start_tick:
            raise ValueError("Practice unit end_tick must be after start_tick")
        if self.end_bar < self.start_bar:
            raise ValueError("Practice unit end_bar must not precede start_bar")
        return self


class ReferencedCue(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,48}$")
    hand: CueHand
    text: str = Field(min_length=8, max_length=280)
    event_refs: list[str] = Field(default_factory=list, max_length=12)


class Landmark(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,48}$")
    label: str = Field(min_length=3, max_length=70)
    hand: CueHand
    text: str = Field(min_length=8, max_length=240)
    event_refs: list[str] = Field(min_length=1, max_length=12)


class PracticeStep(BaseModel):
    instruction: str = Field(min_length=4, max_length=280)
    hand_mode: HandMode
    tempo_percent: int = Field(ge=30, le=110)
    repetitions: int = Field(ge=1, le=20)
    event_refs: list[str] = Field(default_factory=list, max_length=12)


class PracticeUnit(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,48}$")
    title: str = Field(min_length=3, max_length=80)
    timing: PracticeTiming
    hands: list[CueHand] = Field(min_length=1)
    difficulty: int = Field(ge=1, le=5)
    challenge_reason: str = Field(min_length=8, max_length=260)
    focus: str = Field(min_length=8, max_length=220)
    pattern_summary: str = Field(min_length=8, max_length=420)
    landmarks: list[Landmark] = Field(min_length=1, max_length=4)
    cues: list[ReferencedCue] = Field(min_length=2, max_length=6)
    steps: list[PracticeStep] = Field(min_length=2, max_length=6)
    success_criteria: list[str] = Field(min_length=1, max_length=4)
    common_traps: list[str] = Field(default_factory=list, max_length=4)


class PracticeRoute(BaseModel):
    id: PracticeRouteId
    title: str = Field(min_length=3, max_length=80)
    rationale: str = Field(min_length=12, max_length=300)
    unit_ids: list[str] = Field(min_length=1)


class MusicalCharacter(BaseModel):
    summary: str = Field(min_length=20, max_length=500)
    style_hint: str | None = Field(default=None, max_length=100)
    confidence: Literal["low", "medium", "high"]
    basis: Literal["midi", "user-context", "both"]
    evidence: list[str] = Field(min_length=1, max_length=4)
    practice_implications: list[str] = Field(min_length=1, max_length=4)


class PieceAnalysis(BaseModel):
    """Strict v1.1 provider output and persisted analysis model."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["1.1"] = "1.1"
    title: str = Field(min_length=1, max_length=140)
    overview: str = Field(min_length=20, max_length=1200)
    musical_character: MusicalCharacter
    player_strategy: list[str] = Field(min_length=2, max_length=8)
    routes: list[PracticeRoute] = Field(min_length=2, max_length=2)
    practice_units: list[PracticeUnit] = Field(min_length=1, max_length=24)
    assumptions: list[str] = Field(default_factory=list, max_length=8)

    @field_validator("player_strategy", "assumptions")
    @classmethod
    def strip_list_items(cls, value: list[str]) -> list[str]:
        return [item.strip() for item in value if item.strip()]

    @model_validator(mode="after")
    def validate_routes_and_units(self) -> "PieceAnalysis":
        unit_ids = [unit.id for unit in self.practice_units]
        if len(unit_ids) != len(set(unit_ids)):
            raise ValueError("Practice unit ids must be unique")
        route_ids = [route.id for route in self.routes]
        if set(route_ids) != {"balanced", "challenge"} or len(route_ids) != 2:
            raise ValueError("Analysis must contain exactly balanced and challenge routes")
        for route in self.routes:
            if len(route.unit_ids) != len(set(route.unit_ids)):
                raise ValueError(f"Route {route.id} contains duplicate unit ids")
            if set(route.unit_ids) != set(unit_ids):
                raise ValueError(f"Route {route.id} must reference every practice unit exactly once")
        balanced = next(route for route in self.routes if route.id == "balanced")
        earliest = min(self.practice_units, key=lambda unit: (unit.timing.start_bar, unit.timing.end_bar))
        if balanced.unit_ids[0] != earliest.id:
            raise ValueError("Balanced route must begin with the earliest practice unit")
        return self


class LegacyPracticeStep(BaseModel):
    instruction: str = Field(min_length=4, max_length=280)
    hand_mode: HandMode
    tempo_percent: int = Field(ge=30, le=110)
    repetitions: int = Field(ge=1, le=20)


class LegacyPracticeUnit(BaseModel):
    id: str
    title: str
    timing: PracticeTiming
    hands: list[CueHand]
    difficulty: int
    focus: str
    pattern_summary: str
    tips: list[str]
    steps: list[LegacyPracticeStep]
    success_criteria: list[str]
    common_traps: list[str]


class LegacyPieceAnalysis(BaseModel):
    model_config = ConfigDict(extra="ignore")

    schema_version: Literal["1.0"] = "1.0"
    title: str
    overview: str
    player_strategy: list[str]
    practice_order: list[str]
    practice_units: list[LegacyPracticeUnit]
    assumptions: list[str] = Field(default_factory=list)


class PieceAnalysisView(BaseModel):
    """Loose response shape used to display both v1.1 and adapted v1.0 rows."""

    model_config = ConfigDict(extra="ignore")

    schema_version: Literal["1.0", "1.1"]
    title: str
    overview: str
    musical_character: MusicalCharacter
    player_strategy: list[str]
    routes: list[PracticeRoute]
    practice_units: list[PracticeUnitView]
    assumptions: list[str] = Field(default_factory=list)
    legacy_analysis: bool = False


class PracticeUnitView(BaseModel):
    id: str
    title: str
    timing: PracticeTiming
    hands: list[CueHand]
    difficulty: int
    challenge_reason: str = "Regenerate this unit for a detailed challenge explanation."
    focus: str
    pattern_summary: str
    landmarks: list[Landmark] = Field(default_factory=list)
    cues: list[ReferencedCue] = Field(default_factory=list)
    steps: list[PracticeStep]
    success_criteria: list[str]
    common_traps: list[str]


class SongContextUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    context_text: str = Field(default="", max_length=4000)

    @field_validator("title")
    @classmethod
    def title_is_not_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Title must not be blank")
        return value


class AnalysisRequest(BaseModel):
    provider: Literal["openai", "ollama"]
    model: str = Field(min_length=1, max_length=120)
    api_key: str | None = Field(default=None, max_length=300)
    ollama_base_url: str = Field(default="http://127.0.0.1:11434", max_length=220)
    reasoning_effort: Literal["low", "medium"] = "low"


class AnalysisEnvelope(BaseModel):
    analysis: PieceAnalysis
    provider: str
    model: str
    updated_at: str
    input_fingerprint: str


# Public names matching the handoff terminology while keeping the shorter names
# used by the existing API implementation.
PieceAnalysisV11 = PieceAnalysis
LegacyPieceAnalysisV10 = LegacyPieceAnalysis
