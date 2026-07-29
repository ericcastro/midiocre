from __future__ import annotations

import json
import os
from urllib.parse import urlparse

import httpx
from openai import OpenAI

from .prompts import build_messages
from .schemas import PieceAnalysis


class AnalysisProviderError(RuntimeError):
    pass


def analyze_with_openai(
    *,
    digest: dict,
    song_title: str,
    context_text: str,
    model: str,
    api_key: str | None,
    reasoning_effort: str,
) -> PieceAnalysis:
    resolved_key = api_key or os.getenv("OPENAI_API_KEY")
    if not resolved_key:
        raise AnalysisProviderError(
            "Add an OpenAI API key in AI settings or set OPENAI_API_KEY in the backend."
        )

    client = OpenAI(api_key=resolved_key)
    try:
        response = client.responses.parse(
            model=model,
            input=build_messages(digest, song_title, context_text),
            reasoning={"effort": reasoning_effort},
            text_format=PieceAnalysis,
        )
    except Exception as exc:
        raise AnalysisProviderError(f"OpenAI analysis failed: {exc}") from exc

    if response.output_parsed is None:
        raise AnalysisProviderError("OpenAI returned no validated analysis.")
    return response.output_parsed


def _validate_ollama_url(base_url: str) -> str:
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {
        "127.0.0.1",
        "localhost",
        "::1",
    }:
        raise AnalysisProviderError("For safety, Ollama must use a local loopback URL.")
    return base_url.rstrip("/")


def analyze_with_ollama(
    *,
    digest: dict,
    song_title: str,
    context_text: str,
    model: str,
    base_url: str,
) -> PieceAnalysis:
    url = _validate_ollama_url(base_url)
    payload = {
        "model": model,
        "messages": build_messages(digest, song_title, context_text),
        "stream": False,
        "format": PieceAnalysis.model_json_schema(),
        "options": {"temperature": 0.2},
    }
    try:
        with httpx.Client(timeout=300) as client:
            response = client.post(f"{url}/api/chat", json=payload)
            response.raise_for_status()
            body = response.json()
    except Exception as exc:
        raise AnalysisProviderError(
            f"Could not run Ollama at {url}. Check that Ollama is running and the model is installed."
        ) from exc

    content = body.get("message", {}).get("content")
    if not content:
        raise AnalysisProviderError("Ollama returned an empty analysis.")
    try:
        return PieceAnalysis.model_validate(json.loads(content))
    except Exception as exc:
        raise AnalysisProviderError(
            "Ollama returned analysis that did not match the standard format."
        ) from exc
