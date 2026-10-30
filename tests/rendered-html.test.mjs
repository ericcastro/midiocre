import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the MIDIocre application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>MIDIocre — Piano Tutor<\/title>/i);
  assert.match(html, /Library/);
  assert.match(html, /Practice map/);
  assert.match(html, /Loading your library/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Starter Project/);
});

test("ships product metadata and no disposable starter preview", async () => {
  const [page, layout, shell, packageJson, logo] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../public/midiocre-logo.png", import.meta.url)),
  ]);

  assert.match(page, /MIDIocre — Piano Tutor/);
  assert.match(layout, /local-first MIDI player/);
  assert.match(layout, /midiocre-logo\.png/);
  assert.match(shell, /MIDIocre/);
  assert.match(shell, /Piano Tutor/);
  assert.match(shell, /midiocre-logo\.png/);
  assert.match(packageJson, /"name": "midiocre"/);
  assert.ok(logo.byteLength > 0);
  assert.doesNotMatch(page, /_sites-preview|SkeletonPreview|codex-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

test("keeps local persistence and credentials out of commit candidates", async () => {
  const [ignoreFile, secretCheck] = await Promise.all([
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
    readFile(new URL("../scripts/check-secrets.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(ignoreFile, /^\/data\/$/m);
  assert.match(ignoreFile, /^\.env\.\*$/m);
  assert.match(ignoreFile, /^!\.env\.example$/m);
  assert.match(ignoreFile, /^\*\.sqlite3$/m);
  assert.match(ignoreFile, /^\*\.tsbuildinfo$/m);
  assert.match(secretCheck, /"git",\s*\["ls-files", "--cached", "--others", "--exclude-standard"\]/);
  assert.match(secretCheck, /sk-\(\?:proj-\)\?/);
});

test("uses a complete chromatic map for Tone sampler playback", async () => {
  const [source, Tone] = await Promise.all([
    readFile(new URL("../app/lib/midi.ts", import.meta.url), "utf8"),
    import("tone"),
  ]);
  const table = source.match(/const TONE_NOTE_NAMES[^=]*= \[([\s\S]*?)\];/);
  assert.ok(table, "Tone note-name table is present");
  const names = [...table[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(names, ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"]);
  assert.deepEqual(
    names.map((name) => Tone.Frequency(`${name}4`).toMidi()),
    Array.from({ length: 12 }, (_, index) => 60 + index),
  );
});

test("ships the deterministic structured practice workflow", async () => {
  const [shell, structuredPractice, structuredUnits, types] = await Promise.all([
    readFile(new URL("../app/components/AppShell.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/components/StructuredPractice.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/lib/structuredPractice.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/lib/types.ts", import.meta.url), "utf8"),
  ]);

  assert.match(shell, /"structured", "balanced", "challenge"/);
  assert.match(types, /"balanced" \| "challenge" \| "structured"/);
  assert.match(structuredPractice, /Learn bar/);
  assert.match(structuredPractice, /Bridge .*→/);
  assert.match(structuredPractice, /Bridge window/);
  assert.match(structuredPractice, /Same on both sides/);
  assert.match(structuredPractice, /Beats before the bridge/);
  assert.match(structuredPractice, /Beats after the bridge/);
  assert.match(structuredPractice, /step=\{0\.25\}/);
  assert.match(structuredPractice, /Hard passage anywhere/);
  assert.match(structuredPractice, /cross or ignore bar lines/);
  assert.match(structuredPractice, /Custom trouble spot/);
  assert.match(structuredPractice, /\{index \+ 1\}/);
  assert.match(structuredUnits, /STRUCTURED_BARS_PER_SECTION = 4/);
  assert.match(structuredUnits, /This section comes directly from the MIDI timeline/);
  assert.match(shell, /No AI analysis or credits required/);
  assert.match(shell, /Add optional AI guidance/);
});

test("inspects multi-instrument MIDI imports and keeps the screen awake during playback", async () => {
  const [dialog, api, player, pianoRoll] = await Promise.all([
    readFile(new URL("../app/components/ImportSongDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/hooks/useMidiPlayer.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PianoRoll.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(api, /\/api\/midi\/inspect/);
  assert.match(dialog, /Which parts do you want to practise/);
  assert.match(dialog, /left\/right preserved/);
  assert.match(pianoRoll, /trackColors\[note\.trackIndex\]/);
  assert.match(player, /wakeLock\.request\("screen"\)/);
  assert.match(player, /visibilitychange/);
});

test("offers recent pieces and portable library backups", async () => {
  const [shell, library, api] = await Promise.all([
    readFile(new URL("../app/components/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SongLibraryDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
  ]);
  assert.match(shell, /Pick up where you left off/);
  assert.match(shell, /songs\.slice\(0, 4\)/);
  assert.match(shell, /Restore library backup/);
  assert.match(library, /Export library backup/);
  assert.match(api, /\/api\/library\/backup/);
});

test("supports readable touch controls and direct piano-roll scrubbing", async () => {
  const [pianoRoll, styles, api, packageJson] = await Promise.all([
    readFile(new URL("../app/components/PianoRoll.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(pianoRoll, /addEventListener\("wheel"/);
  assert.match(pianoRoll, /passive: false/);
  assert.match(pianoRoll, /onPointerMove/);
  assert.match(pianoRoll, /Drag to seek · pinch to zoom/);
  assert.match(pianoRoll, /event\.clientY - drag\.startY/);
  assert.match(pianoRoll, /Math\.hypot/);
  assert.match(pianoRoll, /onHorizontalZoom/);
  assert.match(styles, /@media \(pointer: coarse\)/);
  assert.match(styles, /touch-action: none/);
  assert.match(styles, /min-height: 44px/);
  assert.match(api, /window\.location\.hostname/);
  assert.match(packageJson, /"dev:lan"/);
});

test("ships a persisted light and dark theme switch", async () => {
  const [shell, styles] = await Promise.all([
    readFile(new URL("../app/components/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(shell, /cadence\.theme\.v1/);
  assert.match(shell, /Switch to \$\{theme === "dark" \? "light" : "dark"\} theme/);
  assert.match(shell, /Moon/);
  assert.match(shell, /Sun/);
  assert.match(styles, /:root\[data-theme="dark"\]/);
  assert.match(styles, /color-scheme: dark/);
  assert.match(styles, /\.theme-toggle/);
});

test("ships a persisted metronome and counted loop restart delay", async () => {
  const [player, transport, types, styles] = await Promise.all([
    readFile(new URL("../app/hooks/useMidiPlayer.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/Transport.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/types.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(types, /metronome_enabled: boolean/);
  assert.match(types, /loop_delay_enabled: boolean/);
  assert.match(types, /loop_delay_beats: number \| null/);
  assert.match(transport, /Metronome/);
  assert.match(transport, /Loop delay/);
  assert.match(transport, /Full count \(\{beatsPerBar\} beats\)/);
  assert.match(transport, /Counting…/);
  assert.match(player, /loopDelayActiveRef\.current/);
  assert.match(player, /beatDurationInSong = \(60 \/ safeTempo\) \* \(4 \/ safeBeatUnit\)/);
  assert.match(player, /"C4"[\s\S]*0\.18/);
  assert.match(player, /downbeat \? 0\.55 : 0\.34/);
  assert.match(styles, /\.timing-toggle/);
  assert.match(styles, /\.delay-select/);
});

test("matches the roll to cyclic practice and moves the library into a dialog", async () => {
  const [shell, pianoRoll, library, transport, player, types] = await Promise.all([
    readFile(new URL("../app/components/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PianoRoll.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../app/components/SongLibraryDialog.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/components/Transport.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/hooks/useMidiPlayer.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/types.ts", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(shell, /<aside className="song-sidebar">/);
  assert.match(shell, /<SongLibraryDialog/);
  assert.match(library, /Choose what to practice/);
  assert.match(library, /Import MIDI/);
  assert.match(types, /loop_timing_offset_ms: number/);
  assert.match(types, /roll_horizontal_zoom: number/);
  assert.match(types, /roll_horizontal_pan: number/);
  assert.match(transport, /Loop timing offset/);
  assert.match(transport, /Start&nbsp; \{formatTime\(loopStart\)\}/);
  assert.match(transport, /End&nbsp; \{formatTime\(loopEnd\)\}/);
  assert.match(pianoRoll, /PLAYING NOW/);
  assert.match(pianoRoll, /LOOP RANGE/);
  assert.match(pianoRoll, /RESTARTS HERE/);
  assert.doesNotMatch(pianoRoll, /B → A/);
  assert.match(pianoRoll, /previewOpacity: 0\.42/);
  assert.doesNotMatch(pianoRoll, /cycleLength/);
  assert.match(pianoRoll, /COUNT-IN/);
  assert.match(pianoRoll, /note\.time >= loopStart && note\.time < loopEnd/);
  assert.match(pianoRoll, /loopDelayRemainingSeconds/);
  assert.match(
    player,
    /const scheduledFrom = includeBoundaryOnNextScheduleRef\.current[\s\S]*\? scheduledThroughRef\.current/,
  );
  assert.match(
    pianoRoll,
    /isPlaying && !isMuted && delta <= 0 && delta \+ note\.duration >= 0/,
  );
});
