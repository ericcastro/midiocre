from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Note(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    pitch: int = Field(ge=21, le=108)
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    instrument: str = Field(default="acoustic_piano", max_length=80)
    boundary: bool = False

    @model_validator(mode="after")
    def forward(self):
        if self.end <= self.start:
            raise ValueError("Note end must follow its start")
        return self


class Passage(StrictModel):
    start: float = Field(default=0, ge=0)
    end: float = Field(default=20, gt=0)

    @model_validator(mode="after")
    def forward(self):
        if self.end - self.start < 0.25:
            raise ValueError("Choose at least a quarter second")
        return self


class Inference(StrictModel):
    model: Literal["small", "medium", "large"] = "small"
    instruments: Literal["piano", "auto"] = "piano"
    beam_size: Literal[1, 2, 4] = 1


class Practice(StrictModel):
    bpm: float | None = Field(default=None, ge=20, le=400)
    beats_per_bar: int | None = Field(default=None, ge=1, le=12)
    first_downbeat: float | None = Field(default=None, ge=0)
    tempo_map: bool | None = None
    quantize: bool = False
    subdivision: Literal[1, 2, 3, 4, 6, 8] = 4
    strength: float = Field(default=1, ge=0, le=1)


class CreateReview(StrictModel):
    url: str = Field(max_length=2048)


class Revision(StrictModel):
    revision: int = Field(ge=0)


class Configure(Revision):
    passage: Passage
    settings: Inference
    practice: Practice


class Run(Revision):
    full: bool = False


class Accept(Revision):
    archive_corrections: bool = False


class Edit(Revision):
    notes: list[Note] = Field(max_length=100000)
    label: str = Field(default="Edit notes", max_length=100)

    @model_validator(mode="after")
    def unique_ids(self):
        if len({n.id for n in self.notes}) != len(self.notes):
            raise ValueError("Note IDs must be unique")
        return self


class Confirm(Revision):
    title: str = Field(min_length=1, max_length=160)
    reviewed: bool
