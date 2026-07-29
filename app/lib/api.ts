import type {
  AiSettings,
  BarTiming,
  MidiEventResponse,
  PieceAnalysis,
  SongDetail,
  SongListItem,
  SongState,
} from "./types";

function defaultApiBase() {
  if (typeof window === "undefined") return "http://127.0.0.1:8000";
  const hostname =
    window.location.hostname.includes(":") &&
    !window.location.hostname.startsWith("[")
      ? `[${window.location.hostname}]`
      : window.location.hostname;
  return `http://${hostname}:8000`;
}

export const API_BASE =
  process.env.NEXT_PUBLIC_MIDI_TUTOR_API_URL ?? defaultApiBase();

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      detail?: string;
    } | null;
    throw new Error(body?.detail ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function listSongs() {
  return apiFetch<SongListItem[]>("/api/songs");
}

export function getSong(songId: string) {
  return apiFetch<SongDetail>(`/api/songs/${songId}`);
}

export function uploadSong(file: File, title: string, contextText: string) {
  const form = new FormData();
  form.append("file", file);
  form.append("title", title);
  form.append("context_text", contextText);
  return apiFetch<SongDetail>("/api/songs", { method: "POST", body: form });
}

export function updateSongContext(
  songId: string,
  context: { title: string; context_text: string },
) {
  return apiFetch<SongDetail>(`/api/songs/${songId}/context`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(context),
  });
}

export function getSongEvents(songId: string) {
  return apiFetch<MidiEventResponse[]>(`/api/songs/${songId}/events`);
}

export function getSongBars(songId: string) {
  return apiFetch<BarTiming[]>(`/api/songs/${songId}/bars`);
}

export function saveSongState(songId: string, state: SongState) {
  return apiFetch<SongState>(`/api/songs/${songId}/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
}

export function deleteSong(songId: string) {
  return apiFetch<void>(`/api/songs/${songId}`, { method: "DELETE" });
}

export async function analyzeSong(
  songId: string,
  settings: AiSettings,
): Promise<{
  analysis: PieceAnalysis;
  provider: string;
  model: string;
  updated_at: string;
}> {
  return apiFetch(`/api/songs/${songId}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: settings.provider,
      model: settings.model,
      api_key: settings.apiKey || null,
      ollama_base_url: settings.ollamaBaseUrl,
      reasoning_effort: settings.reasoningEffort,
    }),
  });
}
