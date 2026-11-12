"""AI provider abstraction: one interface for text and vision, with fallback and budgets.

Providers:
* GeminiProvider        - Google Gemini API (text + images)
* OpenAICompatProvider  - any /chat/completions API: Groq, OpenRouter, Ollama, custom
* OcrSpaceProvider      - OCR-only fallback for images (text extraction, no visual reasoning)

AIRouter tries providers in the configured order, applies per-provider pacing and a
daily request ceiling, retries transient failures with exponential backoff, and raises
AllProvidersExhausted (never a fake answer) when nothing can serve the request.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import random
import time
from dataclasses import dataclass, field

import httpx

from ..config import Config
from ..db import Database

log = logging.getLogger(__name__)


class ProviderError(Exception):
    """A provider could not serve this request (do not retry on the same provider)."""

    status: int | None = None


class RateLimited(ProviderError):
    def __init__(self, message: str, retry_after: float | None = None):
        super().__init__(message)
        self.retry_after = retry_after


class TransientError(ProviderError):
    """Timeouts and 5xx: worth retrying."""


class AllProvidersExhausted(Exception):
    """Every configured provider failed, is rate limited, or is over its daily budget."""


class BudgetExceeded(Exception):
    """The task hit its own AI-call or token ceiling."""


@dataclass
class ImageInput:
    data: bytes
    mime: str = "image/jpeg"


@dataclass
class AIResult:
    text: str
    provider: str
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0


@dataclass
class Budget:
    """Hard per-task ceilings, shared by every AI call the task makes."""

    max_calls: int
    max_tokens: int
    calls: int = 0
    tokens: int = 0
    task_id: int | None = None

    def check(self) -> None:
        if self.calls >= self.max_calls:
            raise BudgetExceeded(f"AI call budget reached ({self.max_calls} calls)")
        if self.tokens >= self.max_tokens:
            raise BudgetExceeded(f"token budget reached ({self.max_tokens:,} tokens)")

    @property
    def remaining_calls(self) -> int:
        return max(0, self.max_calls - self.calls)


def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def _retry_after(response: httpx.Response) -> float | None:
    raw = response.headers.get("retry-after", "")
    try:
        return float(raw)
    except ValueError:
        return None


def _raise_for_status(response: httpx.Response, name: str) -> None:
    code = response.status_code
    if code < 400:
        return
    detail = response.text[:300].replace("\n", " ")
    if code == 429:
        raise RateLimited(f"{name}: rate limit or quota reached (HTTP 429) {detail}", _retry_after(response))
    if code >= 500:
        raise TransientError(f"{name}: server error HTTP {code} {detail}")
    error = ProviderError(f"{name}: HTTP {code} {detail}")
    error.status = code
    raise error


class AIProvider:
    name = "base"
    model = ""
    supports_text = True
    supports_vision = False
    max_prompt_chars = 60_000

    async def generate(self, client: httpx.AsyncClient, prompt: str, *, system: str = "", images: list[ImageInput] | None = None,
                       want_json: bool = False, max_output_tokens: int = 4096) -> AIResult:
        raise NotImplementedError


class GeminiProvider(AIProvider):
    name = "gemini"
    supports_vision = True

    def __init__(self, api_key: str, model: str, base_url: str, max_prompt_chars: int = 60_000):
        self.api_key, self.model, self.base_url = api_key, model, base_url.rstrip("/")
        self.max_prompt_chars = max_prompt_chars

    async def generate(self, client, prompt, *, system="", images=None, want_json=False, max_output_tokens=4096):
        parts = [{"inline_data": {"mime_type": img.mime, "data": base64.b64encode(img.data).decode()}} for img in images or []]
        parts.append({"text": prompt})
        body: dict = {
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": max_output_tokens},
        }
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        if want_json:
            body["generationConfig"]["responseMimeType"] = "application/json"
        response = await client.post(
            f"{self.base_url}/models/{self.model}:generateContent", json=body, headers={"x-goog-api-key": self.api_key}
        )
        _raise_for_status(response, self.name)
        data = response.json()
        candidates = data.get("candidates") or []
        if not candidates:
            raise ProviderError(f"gemini: no candidates returned ({data.get('promptFeedback', {})})")
        text = "".join(p.get("text", "") for p in candidates[0].get("content", {}).get("parts", []) if not p.get("thought"))
        if not text.strip():
            raise ProviderError(f"gemini: empty reply (finishReason={candidates[0].get('finishReason')})")
        usage = data.get("usageMetadata", {})
        return AIResult(text, self.name, self.model, usage.get("promptTokenCount", 0),
                        usage.get("candidatesTokenCount", 0) + usage.get("thoughtsTokenCount", 0))


class OpenAICompatProvider(AIProvider):
    """Groq, OpenRouter, Ollama and anything else speaking the OpenAI chat API."""

    def __init__(self, name: str, base_url: str, api_key: str, model: str, vision_model: str = "", max_prompt_chars: int = 60_000):
        self.name, self.base_url, self.api_key = name, base_url.rstrip("/"), api_key
        self.model, self.vision_model = model, vision_model
        self.supports_text = bool(model)
        self.supports_vision = bool(vision_model)
        self.max_prompt_chars = max_prompt_chars

    async def generate(self, client, prompt, *, system="", images=None, want_json=False, max_output_tokens=4096):
        model = self.vision_model if images else self.model
        content: list | str = prompt
        if images:
            content = [{"type": "text", "text": prompt}] + [
                {"type": "image_url", "image_url": {"url": f"data:{img.mime};base64,{base64.b64encode(img.data).decode()}"}}
                for img in images
            ]
        messages = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": content}]
        body = {"model": model, "messages": messages, "temperature": 0.2, "max_tokens": max_output_tokens}
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        response = await client.post(f"{self.base_url}/chat/completions", json=body, headers=headers)
        _raise_for_status(response, self.name)
        data = response.json()
        try:
            text = data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError):
            raise ProviderError(f"{self.name}: unexpected response shape {str(data)[:200]}")
        if not text.strip():
            raise ProviderError(f"{self.name}: empty reply")
        usage = data.get("usage") or {}
        return AIResult(text, self.name, data.get("model", model), usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0))


class OcrSpaceProvider(AIProvider):
    """Plain OCR. Used only when no vision model is available; cannot interpret charts or scenes."""

    name = "ocrspace"
    model = "ocr.space engine 2"
    supports_text = False
    supports_vision = True
    ocr_only = True

    def __init__(self, api_key: str):
        self.api_key = api_key

    async def generate(self, client, prompt, *, system="", images=None, want_json=False, max_output_tokens=4096):
        texts = []
        for img in images or []:
            if len(img.data) > 1024 * 1024:
                raise ProviderError("ocrspace: image over the 1 MB free-tier limit")
            payload = {"base64Image": f"data:{img.mime};base64,{base64.b64encode(img.data).decode()}", "OCREngine": "2", "scale": "true"}
            response = await client.post("https://api.ocr.space/parse/image", data=payload, headers={"apikey": self.api_key})
            _raise_for_status(response, self.name)
            data = response.json()
            if data.get("IsErroredOnProcessing"):
                raise ProviderError(f"ocrspace: {str(data.get('ErrorMessage'))[:200]}")
            texts.append("\n".join(r.get("ParsedText", "") for r in data.get("ParsedResults") or []))
        return AIResult("\n---\n".join(texts), self.name, self.model)


def build_providers(cfg: Config) -> list[AIProvider]:
    """Instantiate only the providers that have credentials, in AI_PROVIDER_ORDER."""
    available: dict[str, AIProvider] = {}
    if cfg.gemini_api_key:
        available["gemini"] = GeminiProvider(cfg.gemini_api_key, cfg.gemini_model, cfg.gemini_base_url, cfg.ai_max_prompt_chars)
    if cfg.groq_api_key:
        # Groq's free tier has a small tokens-per-minute allowance, so keep prompts short.
        available["groq"] = OpenAICompatProvider("groq", "https://api.groq.com/openai/v1", cfg.groq_api_key, cfg.groq_model,
                                                 cfg.groq_vision_model, min(cfg.ai_max_prompt_chars, 24_000))
    if cfg.openrouter_api_key:
        available["openrouter"] = OpenAICompatProvider("openrouter", "https://openrouter.ai/api/v1", cfg.openrouter_api_key,
                                                       cfg.openrouter_model, cfg.openrouter_vision_model, cfg.ai_max_prompt_chars)
    if cfg.custom_base_url and (cfg.custom_model or cfg.custom_vision_model):
        available["custom"] = OpenAICompatProvider("custom", cfg.custom_base_url, cfg.custom_api_key, cfg.custom_model,
                                                   cfg.custom_vision_model, cfg.ai_max_prompt_chars)
    if cfg.ollama_base_url:
        available["ollama"] = OpenAICompatProvider("ollama", cfg.ollama_base_url + "/v1", "", cfg.ollama_model,
                                                   cfg.ollama_vision_model, min(cfg.ai_max_prompt_chars, 24_000))
    ordered = [available[name] for name in cfg.ai_provider_order if name in available]
    ordered += [p for name, p in available.items() if name not in cfg.ai_provider_order]
    if cfg.ocr_space_api_key:
        ordered.append(OcrSpaceProvider(cfg.ocr_space_api_key))
    return ordered


@dataclass
class _State:
    last_call: float = 0.0
    cooldown_until: float = 0.0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class AIRouter:
    def __init__(self, cfg: Config, db: Database, providers: list[AIProvider], client: httpx.AsyncClient | None = None,
                 sleep=asyncio.sleep):
        self.cfg, self.db, self.providers = cfg, db, providers
        self.client = client or httpx.AsyncClient(timeout=cfg.ai_timeout)
        self._sleep = sleep
        self._state: dict[str, _State] = {p.name: _State() for p in providers}

    async def aclose(self) -> None:
        await self.client.aclose()

    @property
    def has_text(self) -> bool:
        return any(p.supports_text for p in self.providers)

    @property
    def has_vision(self) -> bool:
        return any(p.supports_vision for p in self.providers)

    def describe(self) -> str:
        if not self.providers:
            return "none configured"
        return ", ".join(f"{p.name} ({'text' if p.supports_text else ''}{'+' if p.supports_text and p.supports_vision else ''}"
                         f"{'vision' if p.supports_vision else ''})" for p in self.providers)

    def _daily_used(self, provider: AIProvider) -> int:
        return self.db.usage_count(provider.name, time.time() - 86400)

    async def generate(self, prompt: str, *, system: str = "", images: list[ImageInput] | None = None, want_json: bool = False,
                       max_output_tokens: int = 4096, budget: Budget | None = None, purpose: str = "") -> AIResult:
        if budget:
            budget.check()
        kind = "vision" if images else "text"
        candidates = [p for p in self.providers if (p.supports_vision if images else p.supports_text)]
        if not candidates:
            raise AllProvidersExhausted(
                "No vision-capable AI provider is configured." if images else "No AI provider is configured."
            )
        reasons: list[str] = []
        for provider in candidates:
            state = self._state[provider.name]
            now = time.time()
            if len(prompt) + len(system) > provider.max_prompt_chars:
                reasons.append(f"{provider.name}: prompt too large for this provider")
                continue
            if state.cooldown_until > now:
                reasons.append(f"{provider.name}: cooling down for {int(state.cooldown_until - now)}s after a rate limit")
                continue
            if self._daily_used(provider) >= self.cfg.ai_daily_request_limit:
                reasons.append(f"{provider.name}: local daily budget of {self.cfg.ai_daily_request_limit} requests used")
                continue
            try:
                result = await self._call_with_retries(provider, state, prompt, system, images, want_json, max_output_tokens, budget, kind)
            except BudgetExceeded:
                raise
            except ProviderError as exc:
                reasons.append(str(exc)[:200])
                log.warning("AI provider %s failed for %s: %s", provider.name, purpose or kind, exc)
                continue
            return result
        raise AllProvidersExhausted("; ".join(reasons) or "no provider available")

    async def _call_with_retries(self, provider, state, prompt, system, images, want_json, max_output_tokens, budget, kind) -> AIResult:
        task_id = budget.task_id if budget else None
        last: ProviderError | None = None
        for attempt in range(1, self.cfg.ai_max_retries + 1):
            if budget:
                budget.check()
            async with state.lock:  # pace requests to stay under per-minute limits
                wait = state.last_call + self.cfg.ai_min_interval - time.time()
                if wait > 0:
                    await self._sleep(wait)
                state.last_call = time.time()
                try:
                    result = await provider.generate(self.client, prompt, system=system, images=images, want_json=want_json,
                                                     max_output_tokens=max_output_tokens)
                except httpx.HTTPError as exc:
                    last = TransientError(f"{provider.name}: network error {type(exc).__name__}: {exc}")
                except ProviderError as exc:
                    last = exc
                else:
                    if not result.prompt_tokens:
                        result.prompt_tokens = _estimate_tokens(prompt + system)
                    if not result.completion_tokens:
                        result.completion_tokens = _estimate_tokens(result.text)
                    if budget:  # only answered calls count against the task; failures are bounded by the retry limit
                        budget.calls += 1
                        budget.tokens += result.prompt_tokens + result.completion_tokens
                    self.db.log_usage(provider.name, kind, model=result.model, task_id=task_id,
                                      prompt_tokens=result.prompt_tokens, completion_tokens=result.completion_tokens)
                    return result
            self.db.log_usage(provider.name, kind, model=provider.model, task_id=task_id, ok=False, error=str(last))
            if isinstance(last, RateLimited):
                retry_after = last.retry_after or 0
                if retry_after > 30 or attempt == self.cfg.ai_max_retries:
                    # Long waits mean a quota, not a burst: park the provider and fall through to the next one.
                    state.cooldown_until = time.time() + min(max(retry_after, 60), 3600)
                    raise last
                await self._sleep(max(retry_after, self._backoff(attempt)))
            elif isinstance(last, TransientError):
                if attempt == self.cfg.ai_max_retries:
                    state.cooldown_until = time.time() + 60  # let it recover instead of retrying on every step
                    raise last
                await self._sleep(self._backoff(attempt))
            else:
                if last.status in (401, 403, 404):  # bad key or unknown model will not fix itself mid-task
                    state.cooldown_until = time.time() + 600
                raise last
        raise last or ProviderError(f"{provider.name}: failed")

    @staticmethod
    def _backoff(attempt: int) -> float:
        return min(30.0, 2.0 ** attempt) + random.uniform(0, 1)
