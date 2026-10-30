from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import queue
import shutil
import subprocess
import threading
import time
from urllib.parse import parse_qs, urlparse

class Cancelled(Exception):
    pass


def youtube_id(url: str) -> str:
    import re
    parsed = urlparse(url)
    if parsed.scheme not in {"https", "http"} or parsed.username or parsed.port:
        raise ValueError("Use a standard https://www.youtube.com/watch?v=… or youtu.be link.")
    host = (parsed.hostname or "").lower()
    if host == "youtu.be":
        video = parsed.path.strip("/")
    elif host in {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"}:
        video = parse_qs(parsed.query).get("v", [""])[0] if parsed.path == "/watch" else parsed.path.split("/")[-1] if parsed.path.startswith(("/shorts/", "/live/", "/embed/")) else ""
    else:
        video = ""
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video):
        raise ValueError("This is not a supported YouTube video URL. Playlists are not imported.")
    return video


def crop_bounds(passage: dict, duration: float, full: bool) -> tuple[float, float]:
    if full:
        return 0.0, duration
    # One complete training chunk of warm-up and tail, aligned to source zero.
    return max(0.0, math.floor(passage["start"] / 5) * 5 - 5), min(duration, math.ceil(passage["end"] / 5) * 5 + 5)


def align_notes(raw: list[dict], offset: float, crop_end: float, passage: dict, full: bool) -> tuple[list[dict], int]:
    notes = []
    excluded = 0
    for n in raw:
        if n["instrument"] == "drums" or not 21 <= n["pitch"] <= 108:
            excluded += 1
            continue
        start, end = n["start"] + offset, min(n["end"] + offset, crop_end)
        if end <= start or (not full and (end <= passage["start"] or start >= passage["end"])):
            continue
        notes.append({**n, "id": f"model-{n['id']}", "start": start, "end": end,
                      "boundary": (offset > 0 and start <= offset + .02) or end >= crop_end - .02})
    return notes, excluded


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def run_process(command: list[str], cancel: threading.Event, log: Path, timeout=1800):
    with log.open("w") as out:
        process = subprocess.Popen(command, stdout=out, stderr=subprocess.STDOUT)
        started = time.monotonic()
        try:
            while process.poll() is None:
                if cancel.wait(.1):
                    raise Cancelled()
                if time.monotonic() - started > timeout:
                    raise RuntimeError("The operation timed out. Try a shorter recording or retry later.")
            if process.returncode:
                detail = log.read_text(errors="replace")[-1800:]
                raise RuntimeError(detail or "External audio tool failed.")
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def download(video: str, folder: Path, cancel: threading.Event, progress):
    folder.mkdir(parents=True, exist_ok=True)
    cached = folder / "source.json"
    if cached.exists():
        source = json.loads(cached.read_text())
        if (folder / source["original"]).exists() and (folder / "playback.wav").exists():
            progress({"phase": "Using cached original audio"})
            return source
    if not shutil.which("yt-dlp") or not shutil.which("ffmpeg"):
        raise RuntimeError("Install yt-dlp and FFmpeg, then retry. See docs/YOUTUBE_IMPORT.md.")
    progress({"phase": "Downloading best available audio"})
    run_process(["yt-dlp", "--ignore-config", "--no-playlist", "--no-progress", "--write-info-json",
                 "--max-filesize", "500M", "--match-filter", "!is_live & duration <= 7200", "-f", "bestaudio/best",
                 "-o", str(folder / "original.%(ext)s"), "--", f"https://www.youtube.com/watch?v={video}"], cancel, folder / "download.log")
    info_path = folder / "original.info.json"
    if not info_path.exists():
        raise RuntimeError("The video is live, longer than two hours, unavailable, or was rejected by YouTube.")
    info = json.loads(info_path.read_text())
    originals = [p for p in folder.glob("original.*") if p.is_file() and p.name == f"original.{info.get('ext')}"]
    if not originals:
        raise RuntimeError("YouTube returned no audio stream (or it exceeded the 500 MB limit).")
    original = originals[0]
    progress({"phase": "Preparing lossless playback audio"})
    # Keep source rate/channels. PCM is a decode, not a lossy quality upgrade.
    temporary = folder / "playback.partial.wav"
    run_process(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(original), "-vn", "-c:a", "pcm_s16le", str(temporary)], cancel, folder / "decode.log")
    temporary.replace(folder / "playback.wav")
    import wave
    with wave.open(str(folder / "playback.wav")) as audio:
        duration = audio.getnframes() / audio.getframerate()
        sample_rate = audio.getframerate()
    if not .25 <= duration <= 7200:
        raise RuntimeError("Choose a recording between 0.25 seconds and two hours long.")
    with original.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    source = {"video_id": video, "url": f"https://www.youtube.com/watch?v={video}", "title": info.get("title", video),
              "uploader": info.get("uploader"), "duration": duration, "sample_rate": sample_rate,
              "original": original.name, "format": info.get("format"),
              "sha256": checksum}
    temporary_metadata = folder / "source.tmp"
    temporary_metadata.write_text(json.dumps(source))
    temporary_metadata.replace(cached)
    return source


class Worker:
    """One serialized worker with cancellation during model load and inference."""
    def __init__(self):
        self.lock = threading.Lock()
        self.process = None
        self.lines = None
        self.log_handle = None

    def stop(self):
        if self.process is not None:
            self.process.terminate()
            try:
                self.process.wait(3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            self.process = None
        if self.log_handle:
            self.log_handle.close()
            self.log_handle = None

    def request(self, payload, cancel, progress, folder):
        while not self.lock.acquire(timeout=.1):
            if cancel.is_set():
                raise Cancelled()
        try:
            if cancel.is_set():
                raise Cancelled()
            if self.process is None or self.process.poll() is not None:
                self.stop()
                python = os.getenv("MUSCRIPTOR_PYTHON", str(Path(__file__).resolve().parents[2] / ".venv-muscriptor/bin/python"))
                if not Path(python).is_file():
                    raise RuntimeError("MuScriptor is not installed. Follow docs/YOUTUBE_IMPORT.md and set MUSCRIPTOR_PYTHON to its isolated Python executable.")
                self.log_handle = (folder / "worker.log").open("a")
                self.process = subprocess.Popen([python, "-u", str(Path(__file__).with_name("worker.py"))], stdin=subprocess.PIPE,
                                                stdout=subprocess.PIPE, stderr=self.log_handle, text=True)
                lines = queue.Queue()
                self.lines = lines
                def read_lines(stream):
                    for line in stream:
                        lines.put(line)
                    lines.put(None)
                threading.Thread(target=read_lines, args=(self.process.stdout,), daemon=True).start()
            self.process.stdin.write(json.dumps(payload) + "\n")
            self.process.stdin.flush()
            started = time.monotonic()
            while True:
                if cancel.is_set():
                    self.stop()
                    raise Cancelled()
                if time.monotonic() - started > 7200:
                    self.stop()
                    raise RuntimeError("MuScriptor exceeded the two-hour job limit.")
                try:
                    line = self.lines.get(timeout=.1)
                except queue.Empty:
                    continue
                if line is None:
                    self.stop()
                    raise RuntimeError("MuScriptor stopped unexpectedly. Check worker.log in this review's data folder; model memory or installation may be insufficient.")
                message = json.loads(line)
                if "error" in message:
                    raise RuntimeError("MuScriptor: " + message["error"] + " Check model license access, HF authentication, and the documented installation.")
                if "result" in message:
                    return message["result"]
                progress(message["progress"])
        finally:
            self.lock.release()
