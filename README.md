<p align="center">
  <img src="./public/midiocre-logo.png" width="112" alt="MIDIocre logo">
</p>

<h1 align="center">MIDIocre</h1>
<p align="center"><strong>Piano Tutor for self-taught players</strong></p>

MIDIocre turns a well-formed piano MIDI file into a focused, resumable practice
session. It is built for players who learn by sound, shape, repetition, and a
falling-note piano roll—not by reading conventional notation.

Your library stays on your computer. The app separates hands, remembers where
you stopped, and can ask either a local Ollama model or OpenAI for a practical
practice map.

## What it does

- Plays piano MIDI on an 88-key falling-note roll with left, right, or both
  hands isolated.
- Saves songs, resume position, speed, A/B loops, named loops, and progress in
  a local SQLite library.
- Offers a chronological **Structured** route: learn a bar, connect it to the
  next one, then shrink a stubborn passage to a custom trouble spot.
- Keeps Balanced and Challenge routes for a difficulty-led practice order.
- Provides metronome and optional counted loop-delay playback.
- Includes a centred **Loop offset** control. It moves both loop boundaries
  together by ±300 ms, preserving loop length while correcting imperfect MIDI
  timing around bar lines.
- Supports optional AI tutoring through local Ollama or the OpenAI Responses
  API. MIDI is converted locally to a compact symbolic summary before analysis.
- Highlights referenced notes on the roll and keyboard from teaching cues.
- Works well with touch, including iPad use on a trusted local network.

## Run locally

Requirements:

- Node.js 22.13+
- Python 3.11+
- [uv](https://docs.astral.sh/uv/)
- Optional: Ollama, or an OpenAI API key

Install once:

```bash
npm install
uv sync
```

Start both services:

```bash
npm run dev:all
```

The web app normally opens on `http://localhost:3000`; the Python API runs on
`http://127.0.0.1:8000`.

## Use MIDIocre from an iPad

Connect the computer and iPad to the same trusted Wi-Fi network, then run:

```bash
npm run dev:lan
```

Open the printed **Network** URL on the iPad. The browser uses that same host
for the Python API on port 8000.

`dev:lan` exposes the development app and local library to devices on the
current network. Stop it after practice, avoid public Wi-Fi, and prefer setting
`OPENAI_API_KEY` on the computer rather than entering it on an unencrypted
local-network page.

## AI tutor options

Open **AI tutor settings** from the practice map.

- **Ollama:** run a model locally and use a loopback URL such as
  `http://127.0.0.1:11434`.
- **OpenAI:** provide `OPENAI_API_KEY` in `.env`, or enter a key for the current
  browser session.

Pasted keys are used only for that analysis and are not stored in the song
database or browser storage. The MIDI file itself is not sent to either
provider; the backend sends only a compact, bar-by-bar symbolic digest.

## Persistence

Runtime data is local and ignored by Git:

```text
data/
├── cadence.sqlite3  (legacy filename retained for existing libraries)
└── midi/
```

Deleting a piece removes its MIDI file, state, loops, and saved analysis.

## Verify changes

```bash
npm run lint
npm test
```

`npm test` builds the app, runs the backend tests, and runs frontend contract
tests.
