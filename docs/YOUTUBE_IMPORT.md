# YouTube import and review

Open **Import MIDI → Import from YouTube**. Reviews live separately from practice:

1. Retrieve the source and choose a short passage.
2. Test settings, compare a candidate with the accepted baseline, and explicitly accept or discard it.
3. Correct notes, then prepare the practice grid.
4. Inspect and audition the exported full-piece MIDI, confirm, and open Structured practice.

Passage previews cannot be imported. Run **Transcribe full recording**, review that candidate, and accept it before preparing the final MIDI.

## Install the optional transcription tools

The normal `uv sync` environment remains lightweight. MuScriptor runs in a separate Python process and environment. No inference service or hosted API is required.

On macOS, install [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation) and FFmpeg using your package manager, for example:

```sh
brew install yt-dlp ffmpeg
uv venv .venv-muscriptor
uv pip install --python .venv-muscriptor/bin/python \
  'muscriptor @ git+https://github.com/muscriptor/muscriptor@8a1ef88672cc23c26619adaff37ec48d82c0b906'
```

On Intel Macs, use `uv venv --python 3.12 .venv-muscriptor`: the available Intel PyTorch wheels require Python ≤3.12. On Windows with NVIDIA hardware, install the appropriate CUDA PyTorch wheels in this isolated environment, following MuScriptor's upstream instructions. The default Python path assumes macOS/Linux; set `MUSCRIPTOR_PYTHON` to the absolute interpreter path for other layouts.

Keep yt-dlp current. YouTube can change extraction requirements; some installations also need a supported JavaScript runtime. Downloader errors, including unavailable/private videos and authentication restrictions, appear in the review. The importer does not read browser cookies or bypass access restrictions.

### Local checkpoints

Place the checkpoints in the repository root with these names:

```text
muscriptor-small.safetensors
muscriptor-medium.safetensors
muscriptor-large.safetensors
```

They are ignored by Git. Alternatively set `MUSCRIPTOR_WEIGHTS_DIR` to their directory. Local weights take priority and require no Hugging Face request. Each checkpoint is identified by SHA-256, so different weights cannot reuse another checkpoint's predictions. MuScriptor recognizes the architecture from these filenames; avoid placing a shared, unrelated `config.json` beside them.

Without a local checkpoint, the worker fetches that model's weights and config from the same Hugging Face snapshot. Accept the selected model's license and authenticate first:

- [Small](https://huggingface.co/MuScriptor/muscriptor-small)
- [Medium](https://huggingface.co/MuScriptor/muscriptor-medium)
- [Large](https://huggingface.co/MuScriptor/muscriptor-large)

```sh
uvx hf auth login
# Or provide HF_TOKEN through the server environment; never commit it.
```

`MUSCRIPTOR_WEIGHTS_REVISION` optionally pins a Hugging Face snapshot. Its resolved commit is part of the prediction cache identity. Downloaded weights are cached under the local data directory.

MuScriptor's **code is MIT**, but the **model weights are CC BY-NC 4.0 (non-commercial)**. Local files retain those terms. This adapter pins and checks upstream commit `8a1ef88672cc23c26619adaff37ec48d82c0b906`, package version 0.4.0. An upstream upgrade requires rechecking the adapter rather than silently accepting changed APIs.

Small is the practical starting point, particularly on CPU. Medium and large need progressively more memory and computation; large is intended for GPU use. PyTorch chooses CUDA/Metal when available. `MUSCRIPTOR_DEVICE=cpu` is an optional server-side diagnostic override. Cancellation terminates the worker, so the next inference reloads the model. Successful experiments reuse the loaded model; changing size releases the previous model.

The worker guards MuScriptor's timing-only accelerator synchronization on CPU-only hosts. With the tested PyTorch build, the upstream helper could otherwise segfault even though no accelerator was available. The guard does not change model generation.

## Verified upstream capabilities

The integration uses the inspected [Python model](https://github.com/muscriptor/muscriptor/blob/8a1ef88672cc23c26619adaff37ec48d82c0b906/muscriptor/transcription_model.py), [CLI](https://github.com/muscriptor/muscriptor/blob/8a1ef88672cc23c26619adaff37ec48d82c0b906/muscriptor/main.py), [HTTP API](https://github.com/muscriptor/muscriptor/blob/8a1ef88672cc23c26619adaff37ec48d82c0b906/muscriptor/server.py), and [MIDI exporter](https://github.com/muscriptor/muscriptor/blob/8a1ef88672cc23c26619adaff37ec48d82c0b906/muscriptor/utils/midi.py).

| Operation | Review behavior | Musical consequence |
| --- | --- | --- |
| Model size | Explicit inference job | Different learned transcription model |
| Acoustic piano / automatic instruments | Explicit inference job | Restricts allowed instrument tokens; does not separate piano audio from a mix |
| Beam width 1, 2, 4 | Explicit inference job | Greedy decoding or wider search; wider is slower and not guaranteed to be better |
| Meter and first downbeat | Apply grid & prepare | Changes bar interpretation, preserving reviewed note times |
| Detected tempo map / deliberate fixed BPM | Apply grid & prepare | Follows performance tempo by default; a supplied BPM chooses a constant grid |
| Quantization subdivision and strength | Apply grid & prepare | Moves note starts/ends in a separate practice copy |
| Note edits, display range, levels, audition version | Immediate edit/display/transport operations | No model run |

The Python API also exposes sampling, temperature, guidance, batching, strict EOS handling, and prelude forcing. They are not all exposed in this initial UI. Generation uses greedy/beam decoding with sustained-note prelude forcing and batch size 1. The upstream streaming HTTP endpoint only accepts instrument selection and tempo detection; it does not expose all Python/CLI inference settings. That is why this integration uses a persistent Python worker.

Upstream also supports gap filling, beat scaling, and trimming leading bars. These are omitted here to keep review focused and avoid hiding attacks or breaking source alignment. There are no invented confidence scores or accuracy sliders.

## Source retention and passage timing

- yt-dlp selects `bestaudio/best`, retains the original stream and full metadata, and uses one stable video cache. Repeated experiments do not download again.
- Playback uses PCM decoded at the original rate/channels. Inference alone gets mono 16 kHz PCM, as required by MuScriptor. There is no lossy audio transcode or claim that resampling improves quality.
- Recordings are limited to two hours and original streams to 500 MB. Playback currently decodes the complete recording into browser memory, so long recordings can require substantial memory; short/medium piano performances are the practical starting point.
- A passage adds one five-second chunk before and after, where available, and rounds context boundaries to source-aligned five-second boundaries.
- Raw note times receive the exact crop offset. Notes overlapping the selection retain their full inferred duration within the context. Notes touching an inference-context edge are dashed. Previews are never stitched into a full piece, avoiding duplicate/truncated notes at stitched boundaries.
- A finite warm-up cannot recover arbitrarily long earlier sustain. Model prelude state and beat detection can differ from a full run. Cropped and full results are not guaranteed to match.
- Predictions are cached by source hash, actual context range, upstream/adapter version, checkpoint identity, device, and inference settings. Raw events and beat predictions remain available for export experiments.

## Corrections and audition

The comparison overlay uses common time/pitch coordinates. Outlines represent the corrected baseline and fills represent the candidate. Colors distinguish additions, removals, timing changes, plausible pitch changes, and ambiguous correspondence. Matching tolerates small time shifts; near-ties stay unpaired rather than inventing a correspondence.

Select notes with clicks, Shift-click, or a dragged box. Move them by dragging, resize from the right edge or with Alt-drag, and add by double-clicking empty space or using **Add note at playhead**. Exact pitch/start/end fields support precise corrections. Arrow keys nudge selected notes by a semitone or 50 ms. Delete removes them. Undo/redo persists across closing and reopening the review.

**Merge** is explicit and limited to the same pitch and instrument: it replaces the selected attacks with one sustain from the earliest start to the latest end, filling gaps. The UI explains this before applying it; repeated attacks are never merged automatically.

Generated versions remain immutable. Edits form a separate history on an accepted baseline. A candidate cannot replace a corrected baseline unless the user explicitly archives that correction branch. Archived branches can be restored, and inference never silently rebases or discards edits. This initial policy surfaces the conflict rather than attempting an unreliable automatic merge.

Original audio and sampled piano use one Web Audio clock. Audio-only, MIDI-only, and Both have separate levels. Play/pause/seek/loop and version switches keep one source position. Version switches and recovery after a background-tab stall reanchor both streams together. Playback-rate changes are intentionally omitted. Piano samples use the same Salamander source as the existing practice player and require network access on first load; there is no silent synth fallback.

## Practice export and persistence

Expressive model timings and corrections are authoritative. MuScriptor's optional automatic global onset-delay correction is not silently subtracted from them. Its measured delay is retained in the raw grid. Grid preparation explicitly uses zero additional onset correction.

Grid interpretation and quantization are separate from transcription. A variable detected grid retains a tempo map; rubato is not forced onto one BPM by default. The user can correct meter/downbeat or deliberately supply a fixed BPM. Individual beat-by-beat dragging and meter changes within a piece are not implemented in this first version. If tempo or meter detection fails, preparation asks for deliberate values rather than pretending the model detected them.

Practice preparation uses the real MuScriptor exporter without rerunning the model. It previews the actual exported note timing and bar boundaries. Upstream may add leading MIDI time for bar alignment; the review reads its `muscriptor:bar_offset` marker and removes that padding for comparison with the original audio. The imported MIDI keeps its tempo map and bar alignment for Structured practice.

Reviews, correction histories, raw predictions, audio, and worker logs are under:

```text
data/youtube/
├── sources/<video-id>/
├── predictions/<cache-key>.json
├── models/                         # optional Hugging Face cache
└── reviews/<review-id>/review.json  # plus prepared MIDI and logs
```

`CADENCE_DATA_DIR` relocates all runtime data. Session writes are atomic, mutations check revision numbers, and cancelled/superseded jobs cannot publish late results. Previous results remain usable if a run fails. Interrupted jobs become retryable after an API restart. Run one API process for this local review store; multi-worker/distributed job coordination is not implemented.

Confirmation stores a normal MIDI/song/state record and opens the existing Structured practice route. Source/review provenance is saved in piece context; repeated confirmation of the same prepared result is idempotent. Deleting a practice song does not delete its source review. The existing portable library backup contains the confirmed MIDI and practice data, **not** the larger `data/youtube` audio/review cache; copy that directory separately to preserve resumable review history.

## Verification performed

Automated checks cover timestamp offsets, selection-crossing notes, cache identities, note matching and ambiguity, correction archives, undo/redo, stale/cancelled jobs, restart recovery, practice export padding, and confirmed Structured import. A fake Web Audio clock additionally exercises the actual transport's audio/piano anchors through seeks, version changes, and loops. The optional real-worker export test runs when `.venv-muscriptor` is installed.

Hands-on checks used a separate temporary library, so the user's real pieces were not modified. Live yt-dlp retrieval and a second cached retrieval were exercised. The supplied small checkpoint was loaded and used for both cropped and full inference on a controlled sampled-piano recording, on CPU and Metal. The real exporter and browser playback/editor were exercised. These checks establish pipeline behavior, not a general transcription-accuracy benchmark. Full inference can hallucinate or miss notes; human review remains necessary. Medium/large checkpoints have not been run as a quality benchmark.

Run the normal checks with:

```sh
npm run lint
npx tsc --noEmit
npm test
```
