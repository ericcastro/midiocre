# MIDIocre next iteration: implementation handoff

Status: product decisions are made. Implement this specification without reopening
the UX questions unless the current code makes a requirement impossible.

## Post-handoff product decision: Structured mode

The practice UI now offers a third, deterministic **Structured** mode alongside
the AI-provided Balanced and Challenge routes. Structured mode:

- sorts the existing AI phrase/section units chronologically;
- generates bar loops, adjacent-bar handoff loops, longer combinations, and a
  custom trouble-spot loop from backend MIDI bar timings;
- keeps detailed AI commentary folded unless the learner asks for it;
- persists the selected structured step and completed structured steps.

This does not change the v1.1 AI response contract: the model still returns exactly
Balanced and Challenge routes. Structured mode is generated locally and consumes no
additional AI tokens.

## One-line objective

Turn the current note-heavy practice map into a visual, low-cognitive-load tutor:
the learner chooses a balanced or challenge route, supplies musical context, and
can hover or focus any concrete teaching cue to see the exact referenced notes
highlighted on the on-screen piano.

## User profile to optimize for

- Adult, self-taught piano player.
- Good dexterity and hand independence.
- Learns from falling notes and keyboard shapes, not notation.
- Does not know note names on the keyboard by heart.
- Wants physical, visual, pattern-based shortcuts.
- Exact pitch names are useful only when they are paired with an immediate visual
  indication of the relevant keys.
- Motivation matters: beginning every piece with the hardest passage is not the
  default.

## Fixed product decisions

1. Offer two practice routes:
   - **Balanced** is the default. It starts with the earliest unit, establishes the
     piece, and alternates demanding material with more approachable or rewarding
     material.
   - **Challenge** prioritizes the most consequential coordination and movement
     bottlenecks.
2. MIDI import becomes a small dialog containing the file, editable title, and a
   generous free-form piece-context field.
3. AI advice uses concise natural language and explicit hand labels.
4. Every concrete landmark or cue may reference exact MIDI events.
5. Hovering or keyboard-focusing a referenced cue highlights its notes on the
   on-screen piano. Clicking pins/unpins the highlight for touch use.
6. The falling-note view gets vertical time zoom and improved visibility for very
   short notes.
7. Existing songs, loops, progress, and schema-v1.0 analyses must continue to load.
8. Keep the application local-first: Python/FastAPI, local SQLite, and local MIDI
   files. Do not migrate this iteration to browser storage, D1, R2, authentication,
   or a hosted backend.

## Explicit non-goals

- No MIDI keyboard input.
- No microphone or WAV/audio analysis.
- No correction of malformed AnthemScore MIDI.
- No web lookup or automatic song identification.
- No fingering engine.
- No mobile redesign beyond making hover interactions work via focus/click.
- No production deployment in this pass.

## Architecture rule that must not be compromised

AI prose must never be parsed to discover which notes it means.

The backend assigns deterministic IDs to parsed MIDI note events. Those IDs are
included in the symbolic evidence sent to the model. The model returns IDs in
structured `event_refs` arrays. The backend validates every reference before saving
the analysis. The frontend receives the same normalized event list and uses those
IDs for highlighting.

This gives the UI an exact bridge:

`AI cue -> validated event_refs -> normalized MIDI events -> piano key highlight`

## Current architecture and files

- `backend/schemas.py`: persisted/API Pydantic models and analysis schema v1.0.
- `backend/midi_analysis.py`: MIDI parsing, hand resolution, compact bar digest,
  and analysis fingerprint.
- `backend/prompts.py`: tutor system prompt and user payload.
- `backend/ai.py`: OpenAI structured output and Ollama JSON-schema calls.
- `backend/db.py`: idempotent SQLite initialization.
- `backend/main.py`: song, state, MIDI, and analysis endpoints.
- `app/lib/types.ts`: frontend mirrors of backend contracts.
- `app/lib/api.ts`: API client.
- `app/lib/midi.ts`: currently reparses MIDI in the browser.
- `app/components/AppShell.tsx`: import, persistence, tutor panel, and transient UI.
- `app/components/PianoRoll.tsx`: falling-note canvas and on-screen piano.
- `app/components/Transport.tsx`: transport, hand isolation, loop, and tempo.
- `backend/tests/test_api.py` and `tests/rendered-html.test.mjs`: current tests.

`AppShell.tsx` is already large. Add focused components/helpers rather than placing
all new markup and behavior in that file.

Suggested new files:

- `app/components/ImportSongDialog.tsx`
- `app/components/PracticeCue.tsx`
- `app/lib/practice.ts`

Names may vary, but preserve the separation.

---

## 1. Deterministic normalized MIDI events

### Backend event model

Add a response model equivalent to:

```python
class MidiEvent(BaseModel):
    id: str
    midi: int
    name: str
    time: float
    duration: float
    velocity: int
    start_tick: int
    end_tick: int
    track_index: int
    hand: Literal["left", "right"]
    bar: int
    beat_offset: float
```

### Event ID algorithm

1. Parse all notes using the existing backend parser.
2. Sort deterministically by:
   `(start_tick, pitch, end_tick, track_index, channel)`.
3. Assign IDs from that stable order: `n-000001`, `n-000002`, and so on.
4. IDs must not depend on the left/right mapping so that changing the split point
   changes only `hand`, not note identity.
5. Duplicate notes at the same pitch and tick remain distinct because each sorted
   occurrence receives its own ID.

Create one backend helper that returns normalized/resolved events. Both the API
endpoint and `build_symbolic_digest()` must call that helper. Do not duplicate the
ID logic.

### Events endpoint

Add:

```text
GET /api/songs/{song_id}/events
```

It reads the current saved hand assignments and split pitch, then returns the
normalized `MidiEvent[]`.

The frontend should use this endpoint for playback and rendering. Once it does,
remove the browser-side `@tonejs/midi` parsing path and remove that dependency if
nothing else uses it. Keep the MIDI download URL/API for the saved original file.

Frontend playback velocity should be normalized from the API's `0..127` integer to
Tone's `0..1` value.

### Symbolic digest event format

Keep the digest reasonably compact. Each bar event should include at least:

```text
[event_id, beat_offset, pitch_name, duration_seconds, hand_initial, velocity]
```

Update the declared `event_format` to match. The model does not need a second copy
of the full event object.

---

## 2. Piece context at import and later editing

### Persistence

Add this idempotent migration in `ensure_storage()`:

```sql
ALTER TABLE songs ADD COLUMN context_text TEXT NOT NULL DEFAULT ''
```

Only execute it when `PRAGMA table_info(songs)` shows that the column is missing,
following the existing `input_fingerprint` migration pattern.

Expose `context_text` on `SongDetail`. It does not need to appear on every
`SongListItem`.

### Import UI

Replace immediate upload after file selection with a dialog:

- MIDI file picker/drop target.
- Editable title, prefilled from the filename.
- Free-form textarea labelled **Piece context for your tutor**.
- Helpful placeholder:
  `Title/composer, genre, what you hear, what feels difficult, the performance or arrangement this MIDI follows, and anything else the tutor should know.`
- Suggested maximum: 4,000 characters.
- Primary action: **Import and open**.
- Cancel leaves the library unchanged.

The import API remains multipart and accepts:

- `file` — required.
- `title` — optional; fallback to filename-derived title.
- `context_text` — optional.

### Later editing

Add:

```text
PUT /api/songs/{song_id}/context
```

Request model:

```python
class SongContextUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    context_text: str = Field(default="", max_length=4000)
```

Expose **Piece context** from the piece header so it can be edited after import.
Changing title or context updates `songs.updated_at`.

Title and context must be part of the analysis input fingerprint. Editing either
therefore marks the current analysis stale without deleting it.

The prompt must clearly distinguish:

- user-supplied context, which may be used directly;
- inferences from MIDI, which must be labelled with confidence;
- song identity, which must not be guessed from melody alone.

---

## 3. Analysis schema v1.1

The canonical endpoint remains:

```text
GET /api/analysis/schema
```

It must return schema v1.1 after this implementation.

### Musical character

Add:

```python
class MusicalCharacter(BaseModel):
    summary: str = Field(min_length=20, max_length=500)
    style_hint: str | None = Field(default=None, max_length=100)
    confidence: Literal["low", "medium", "high"]
    basis: Literal["midi", "user-context", "both"]
    evidence: list[str] = Field(min_length=1, max_length=4)
    practice_implications: list[str] = Field(min_length=1, max_length=4)
```

`style_hint` may say `tango-like` when MIDI evidence supports it. It must not claim
to have identified a specific composition unless that identity came from the
user-supplied context or MIDI metadata.

### Practice routes

Add:

```python
class PracticeRoute(BaseModel):
    id: Literal["balanced", "challenge"]
    title: str
    rationale: str = Field(min_length=12, max_length=300)
    unit_ids: list[str] = Field(min_length=1)
```

The analysis must contain exactly one route of each ID. Both routes must contain
every practice-unit ID exactly once and no unknown IDs.

Additional balanced-route validation:

- The first unit must be the chronologically earliest unit.
- If multiple units share the earliest starting bar, use the one with the earliest
  ending bar.

Prompt requirements for routes:

- Balanced begins with orientation and musical familiarity.
- Balanced alternates demanding and approachable material where possible.
- Balanced should avoid consecutive difficulty-5 units unless no alternative
  remains.
- Challenge orders units by likely practice payoff, not merely raw note count.
- Each route rationale explains why that order suits its goal.

### Referenced teaching objects

Use structured landmarks and cues rather than `list[str]` tips:

```python
class ReferencedCue(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,48}$")
    hand: HandMode
    text: str = Field(min_length=8, max_length=280)
    event_refs: list[str] = Field(default_factory=list, max_length=12)


class Landmark(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,48}$")
    label: str = Field(min_length=3, max_length=70)
    hand: HandMode
    text: str = Field(min_length=8, max_length=240)
    event_refs: list[str] = Field(min_length=1, max_length=12)
```

Extend `PracticeStep` with:

```python
event_refs: list[str] = Field(default_factory=list, max_length=12)
```

Update `PracticeUnit`:

- Keep `id`, `title`, `timing`, `hands`, `difficulty`, `focus`,
  `pattern_summary`, `steps`, `success_criteria`, and `common_traps`.
- Add `challenge_reason: str`.
- Add `landmarks: list[Landmark]`, minimum 1, maximum 4.
- Replace `tips: list[str]` with `cues: list[ReferencedCue]`, minimum 2,
  maximum 6.

Update `PieceAnalysis`:

```python
schema_version: Literal["1.1"] = "1.1"
musical_character: MusicalCharacter
routes: list[PracticeRoute]
```

Remove `practice_order` from new model output. Route order owns sequencing.

### Backend reference validation

After a provider returns validated v1.1 output and before saving:

1. Build a map of valid digest event IDs.
2. Every `event_ref` must exist.
3. A landmark must contain at least one reference.
4. Referenced events must fall inside that practice unit's tick range.
5. When cue/landmark hand is `left` or `right`, all referenced events must match
   that hand. `both` may mix hands.
6. Reject duplicate cue/landmark IDs within a unit.
7. On any failure, return a useful 502 and save nothing.

Do not silently remove invalid references because that would make the model appear
more precise than it was.

### Strict provider output versus API view

Do not force one Pydantic model to serve two conflicting purposes.

- `PieceAnalysisV11` is the strict canonical provider-output/persistence model. It
  requires both routes, at least one landmark per unit, and schema version `1.1`.
- `LegacyPieceAnalysisV10` validates historical rows exactly as they were stored.
- `PieceAnalysisView` is the normalized API/UI response shape. It may contain empty
  landmark/reference arrays when its source is legacy and includes a boolean such
  as `legacy_analysis`.

`GET /api/analysis/schema` and both provider format mechanisms use the strict
`PieceAnalysisV11` schema. `SongDetail.analysis` uses `PieceAnalysisView`.

### Legacy v1.0 compatibility

Existing analyses must not break song loading.

Create a dedicated loader/adapter:

1. Detect `schema_version`.
2. Validate v1.0 with a retained legacy model.
3. Normalize it into `PieceAnalysisView`:
   - Balanced route: units sorted by `(start_bar, end_bar)`.
   - Challenge route: legacy `practice_order`.
   - Convert each legacy string tip into a `ReferencedCue` with no refs.
   - Use the unit's sole hand when unambiguous; otherwise use `both`.
   - Create no fake landmarks or fake event references. Empty landmarks are allowed
     only in the normalized legacy view, never in new v1.1 provider output.
   - Add a low-confidence musical-character placeholder explaining that
     regeneration is needed for interactive landmarks.
4. The old fingerprint will differ from digest version 1.1, so display it as stale.

Show a concise UI note on normalized legacy analysis:
`Regenerate this map to add musical context and interactive note landmarks.`

Do not mutate the historical database row in place.

---

## 4. Prompt behavior

The prompt should still sound like a practical teacher, but it needs stricter
translation rules.

Required additions:

- Address the supplied learner profile directly.
- Begin every cue with a clear hand assignment through the structured `hand`
  field; do not waste text repeating it unless needed.
- Prefer physical/visual language:
  - low, middle, or high keyboard area;
  - groups of two or three black keys;
  - repeated hand shapes;
  - same shape moved;
  - stepwise direction;
  - jump size in visually understandable terms;
  - first landing after a rest;
  - one hand holding while the other moves.
- Avoid long pitch-name sequences in prose. The interface will derive exact pitch
  labels from `event_refs`.
- A landmark is a stable visual or physical anchor, not merely a named note.
- Use references for the exact examples supporting a landmark or cue.
- Keep advice short enough to scan while practicing.
- Explain challenge ratings through `challenge_reason`.
- Use user context to discuss musical character, phrasing, and genre conventions.
- When context is absent, genre/style language is explicitly probabilistic.

Remove `required_schema` from `build_messages()`. The schema is already supplied
through OpenAI `text_format` and Ollama `format`; embedding it in the user message
duplicates input and increases latency.

Update the digest version to `1.1`.

---

## 5. Practice-route UI and persistence

Add to `SongState`:

```python
practice_route: Literal["balanced", "challenge"] = "balanced"
roll_zoom: float = Field(default=1.0, ge=0.6, le=3.0)
note_visibility: Literal["accurate", "enhanced"] = "enhanced"
```

Pydantic defaults must allow old saved `state_json` documents to load.

In the tutor panel:

- Add a two-option segmented control: **Balanced** and **Challenge**.
- Place it above the unit list.
- Display the selected route's rationale directly below it.
- Render units from the selected route's `unit_ids`.
- Balanced is the default for new songs and migrated state.
- Switching route does not reset completion or loops.
- Keep the currently selected unit if it exists in the new route.
- After new analysis, expand/select the first Balanced unit.

Difficulty bars:

- Keep the five-bar visual.
- Give it `aria-label="Challenge X of 5"` and a tooltip/title.
- In expanded content, show `Challenge X/5` with `challenge_reason`.
- Do not present it as a formal grade or objective player-level rating.

---

## 6. Interactive landmarks and cues

### Frontend data

The frontend `MidiNote` gains:

```ts
id: string;
startTick: number;
endTick: number;
bar: number;
```

It is populated from `/events`, not inferred by matching timestamps.

### Cue rendering

Render `Landmark`, `ReferencedCue`, and step references through a shared interactive
component.

Each referenced row displays:

- hand badge: **Left**, **Right**, or **Both**;
- concise natural-language text;
- a compact exact-note chip derived from the referenced frontend events.

Format the chip by time:

- simultaneous pitches joined with `+`;
- successive groups joined with `→`;
- preserve the backend event order;
- if the chip becomes long, show the first few groups plus `+N`, with the complete
  sequence in an accessible label/title.

Example:

```text
LEFT  Reuse this three-key shape one step lower.
      [A3+C4+E4 → G3+B3+D4]
```

The model must not provide the chip text; derive it from validated events.

### Interaction behavior

- `mouseenter` and keyboard `focus` activate a transient highlight.
- `mouseleave` and `blur` clear it unless pinned.
- Click toggles a pinned highlight for touch and deliberate inspection.
- Escape clears the pinned highlight before it closes other UI.
- Use buttons or another naturally focusable element; do not make this
  mouse-only.
- Add a short first-use hint:
  `Hover a teaching cue—or focus it with the keyboard—to see its notes.`

Highlight state is transient and must not be autosaved.

### Canvas behavior

Add `highlightedEventIds: Set<string>` (or a serializable equivalent) to
`PianoRoll`.

- Referenced falling-note blocks receive a bright outline/glow.
- Referenced piano keys remain highlighted even when their falling-note blocks are
  outside the current time window.
- Preserve left/right color identity; use lime/white as an outline rather than
  replacing the hand color.
- Active playback and teaching highlights may coexist.
- A muted hand may still be shown as a teaching highlight because the user asked
  what the cue means, not what is currently audible.

Do not automatically seek or interrupt playback on hover. The existing
**Practice this loop** action remains the explicit navigation action.

---

## 7. Falling-note zoom and short-note visibility

Add controls to the roll toolbar:

- vertical zoom decrease/increase, with a visible value such as `1.0×`;
- note visibility toggle: **Exact** / **Enhanced**.

Zoom:

- Replace the current fixed `secondsVisible` calculation with the same base value
  divided by `roll_zoom`.
- Clamp to a sensible visible range, approximately 2.5–16 seconds.
- More zoom means fewer visible seconds and greater timing separation.

Short-note rendering:

- Exact mode uses true duration with only a minimal 2px visibility floor.
- Enhanced mode keeps the true attack position but gives sub-6px notes a visible
  6–8px capsule or outline.
- Do not shift the attack line. If a minimum-height capsule exaggerates duration,
  add a fine marker at the exact attack position.

Persist zoom and visibility in `SongState`.

---

## 8. AI request latency cleanup

This is part of the iteration because users will regenerate analyses to obtain the
new event references.

- Remove the duplicated JSON schema from the prompt as described above.
- Add OpenAI reasoning effort to `AiSettings` and `AnalysisRequest`:
  `low | medium`, default `low`.
- UI labels: **Faster** (`low`) and **Deeper** (`medium`).
- Pass the selected effort explicitly to the OpenAI Responses call.
- Ollama ignores this setting.
- While analysis runs, show elapsed seconds alongside `Studying the piece…`.
- Do not add job queues, streaming partial schemas, or cancellation in this pass.

---

## 9. API and TypeScript changes

Required API client operations:

```ts
uploadSong(file, title, contextText)
updateSongContext(songId, { title, context_text })
getSongEvents(songId)
analyzeSong(songId, settings)
```

Mirror every v1.1 backend model in `app/lib/types.ts`.

Avoid a second hand-resolution implementation in TypeScript. The normalized event
endpoint is authoritative.

When hand mapping changes:

- save state as today;
- refetch normalized events;
- mark analysis stale;
- regenerated analysis references the same event IDs with updated hand labels.

---

## 10. Validation and tests

### Backend automated tests

Extend `backend/tests/test_api.py` or add focused test modules covering:

1. Import title/context persistence.
2. Context update and retrieval.
3. Context included in fingerprint.
4. Event IDs are unique and deterministic across repeated endpoint calls.
5. Event IDs remain unchanged after a hand-mapping change.
6. Event hand labels do change after a hand-mapping change.
7. Digest event IDs equal IDs returned by `/events`.
8. Schema v1.1 contains routes, landmarks/cues, and event refs.
9. Route validation rejects missing, duplicate, and unknown unit IDs.
10. Balanced validation rejects a route that does not start chronologically.
11. Invalid or out-of-unit event references cause 502 and save no analysis.
12. Valid provider fixture saves and reloads.
13. Existing schema-v1.0 analysis loads through the adapter and is marked stale.
14. Old `SongState` JSON without the three new fields receives defaults.

Monkeypatch the provider functions; tests must not spend API credits or require
Ollama.

### Frontend/build validation

Run:

```text
npx tsc --noEmit
npm run lint
npm test
```

`npm test` already includes the production build and backend tests. Fix genuine
failures and rerun.

### Interaction acceptance checklist

These are the required behaviors. If the user explicitly authorizes browser UI
testing during the implementation pass, verify them with one small test MIDI;
otherwise cover what is practical with automated/component tests and report the
remaining manual checks:

1. Import dialog accepts title and context.
2. Reopening the song shows saved context.
3. Analysis opens on the first Balanced unit.
4. Switching to Challenge changes ordering and rationale without losing completion.
5. Hovering every referenced landmark/cue immediately highlights the intended keys.
6. Keyboard Tab focus produces the same highlight.
7. Click pins the highlight; Escape clears it.
8. Left/right colors remain distinguishable.
9. Vertical zoom increases spacing.
10. Enhanced mode makes short notes visible without moving their attack.
11. Reload preserves route, zoom, visibility, loops, progress, and selected unit.
12. A legacy analysis still opens and requests regeneration for interactive cues.

---

## 11. Implementation sequence

Implement in this order so every stage has a stable contract:

1. Backend normalized events and event endpoint.
2. Schema v1.1 plus legacy adapter and validators.
3. Context persistence/API and fingerprint update.
4. Prompt/provider changes and provider-fixture tests.
5. Frontend types/API and switch playback data to normalized events.
6. Import/context dialog.
7. Route selector and rationale.
8. Shared referenced-cue component and highlight state.
9. Piano-roll/key highlighting.
10. Zoom and short-note visibility controls.
11. Full automated tests; perform local browser UI acceptance only when the user
    explicitly requests it.

Do not call the real OpenAI or Ollama provider during automated verification.

## Definition of done

The iteration is done when a user who does not know note names can hover a tutor
instruction and instantly see the exact intended keys, while still having optional
pitch labels; can choose Balanced or Challenge without losing progress; can provide
and edit piece context; can zoom short notes; and can reopen both new and legacy
songs without data loss.

## Exact prompt for the Luna implementation pass

> Implement `docs/NEXT_ITERATION_HANDOFF.md` completely in the current
> `/Users/eric/Developer/midi-tutor` workspace. Treat its product decisions and
> contracts as fixed. Preserve the local Python/FastAPI/SQLite architecture and all
> existing song, loop, progress, and analysis data. Use deterministic backend-issued
> MIDI event IDs as the only bridge between AI cues and keyboard highlighting.
> Implement in the specified sequence, run the required automated validation, then
> report the remaining interaction-acceptance checklist. Do not call paid AI APIs
> during tests. Do not deploy this local-first iteration. Report any deliberate
> deviation from the handoff with its reason.
