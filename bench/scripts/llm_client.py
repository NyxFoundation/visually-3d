"""Minimal LLM client with provider routing.

Stdlib-only on purpose: no `openai` / `anthropic` SDK dependency. Every
supported provider exposes an OpenAI-compatible /v1/chat/completions endpoint,
including Ollama Cloud — so one HTTP shape covers them all. Anthropic is the
exception and uses its own /v1/messages endpoint.

Provider routing is driven by `bench/configs/models.yaml`:

  - id:        canonical model id used on the CLI (e.g. qwen-coder-32b)
    provider:  ollama_cloud | openai | anthropic
    model:     wire-format model name sent to the provider (defaults to id)
    cost_per_mtok_in / cost_per_mtok_out: USD per 1M tokens

Env vars expected:
  OLLAMA_API_KEY    (Ollama Cloud — https://ollama.com)
  OPENAI_API_KEY
  ANTHROPIC_API_KEY
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from _common import BENCH_ROOT

DEFAULT_TIMEOUT_S = 120

PROVIDER_ENDPOINTS = {
    "ollama_cloud": ("https://ollama.com/v1/chat/completions", "OLLAMA_API_KEY"),
    "openai": ("https://api.openai.com/v1/chat/completions", "OPENAI_API_KEY"),
    "anthropic": ("https://api.anthropic.com/v1/messages", "ANTHROPIC_API_KEY"),
}


class LLMClientError(RuntimeError):
    pass


@dataclass
class ModelSpec:
    id: str
    provider: str
    wire_model: str
    cost_in: float
    cost_out: float


@dataclass
class LLMResponse:
    text: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    latency_ms: int
    raw: dict[str, Any]


def load_model_spec(model_id: str, models_yaml: Path | None = None) -> ModelSpec:
    """Look up a model in configs/models.yaml. Requires PyYAML."""
    try:
        import yaml  # type: ignore
    except ImportError as exc:
        raise LLMClientError("PyYAML required to load configs/models.yaml") from exc

    path = models_yaml or (BENCH_ROOT / "configs" / "models.yaml")
    with path.open() as fh:
        cfg = yaml.safe_load(fh)
    for entry in cfg.get("models", []):
        if entry.get("id") == model_id:
            provider = entry.get("provider")
            if provider not in PROVIDER_ENDPOINTS:
                raise LLMClientError(
                    f"model {model_id!r} has unsupported provider {provider!r}; "
                    f"expected one of {sorted(PROVIDER_ENDPOINTS)}"
                )
            return ModelSpec(
                id=model_id,
                provider=provider,
                wire_model=entry.get("model") or model_id,
                cost_in=float(entry.get("cost_per_mtok_in", 0.0)),
                cost_out=float(entry.get("cost_per_mtok_out", 0.0)),
            )
    raise LLMClientError(f"model {model_id!r} not in {path}")


def complete(
    spec: ModelSpec,
    messages: list[dict[str, str]],
    *,
    max_tokens: int = 1024,
    temperature: float = 0.2,
    timeout: int = DEFAULT_TIMEOUT_S,
) -> LLMResponse:
    """Send a chat-completion request. Returns text + usage + cost + latency."""
    url, env_key = PROVIDER_ENDPOINTS[spec.provider]
    api_key = os.environ.get(env_key)
    if not api_key:
        raise LLMClientError(f"{env_key} not set in environment")

    if spec.provider == "anthropic":
        return _anthropic_call(spec, url, api_key, messages, max_tokens, temperature, timeout)
    return _openai_compatible_call(spec, url, api_key, messages, max_tokens, temperature, timeout)


def _openai_compatible_call(
    spec: ModelSpec,
    url: str,
    api_key: str,
    messages: list[dict[str, str]],
    max_tokens: int,
    temperature: float,
    timeout: int,
) -> LLMResponse:
    body = json.dumps(
        {
            "model": spec.wire_model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    raw = _post(req, timeout)
    text = raw["choices"][0]["message"]["content"] or ""
    usage = raw.get("usage") or {}
    in_tok = int(usage.get("prompt_tokens") or 0)
    out_tok = int(usage.get("completion_tokens") or 0)
    cost = (in_tok / 1_000_000.0) * spec.cost_in + (out_tok / 1_000_000.0) * spec.cost_out
    return LLMResponse(text, in_tok, out_tok, cost, raw["_latency_ms"], raw)


def _anthropic_call(
    spec: ModelSpec,
    url: str,
    api_key: str,
    messages: list[dict[str, str]],
    max_tokens: int,
    temperature: float,
    timeout: int,
) -> LLMResponse:
    system = ""
    chat = []
    for m in messages:
        if m["role"] == "system":
            system = (system + "\n\n" + m["content"]).strip()
        else:
            chat.append({"role": m["role"], "content": m["content"]})
    body = json.dumps(
        {
            "model": spec.wire_model,
            "system": system,
            "messages": chat,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
    )
    raw = _post(req, timeout)
    blocks = raw.get("content") or []
    text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
    usage = raw.get("usage") or {}
    in_tok = int(usage.get("input_tokens") or 0)
    out_tok = int(usage.get("output_tokens") or 0)
    cost = (in_tok / 1_000_000.0) * spec.cost_in + (out_tok / 1_000_000.0) * spec.cost_out
    return LLMResponse(text, in_tok, out_tok, cost, raw["_latency_ms"], raw)


def _post(req: urllib.request.Request, timeout: int) -> dict[str, Any]:
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read()
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise LLMClientError(f"HTTP {exc.code} from {req.full_url}: {body}") from exc
    except urllib.error.URLError as exc:
        raise LLMClientError(f"network error to {req.full_url}: {exc}") from exc
    latency_ms = int((time.perf_counter() - t0) * 1000)
    parsed = json.loads(payload.decode("utf-8"))
    parsed["_latency_ms"] = latency_ms
    return parsed
