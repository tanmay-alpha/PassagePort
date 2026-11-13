"""Optional language-model client (any OpenAI-compatible chat-completions endpoint).

The rest of the application only knows the ``LLMClient`` protocol and asks ``get_client`` for one,
so tests replace ``get_client`` and no test ever talks to a network.
"""

from __future__ import annotations

import logging
from typing import Protocol

import httpx
from pydantic import SecretStr

from passageport.config import Settings

log = logging.getLogger("passageport.llm")

Message = dict[str, str]


class LLMError(Exception):
    """The model call failed. The message is safe to log: it never contains keys, prompts or replies."""


class LLMClient(Protocol):
    model: str

    def complete(self, messages: list[Message]) -> str:
        """Return the assistant's reply text. Raises ``LLMError`` on any failure."""
        ...


class OpenAICompatibleClient:
    """POSTs to ``{base_url}/chat/completions`` with temperature 0 (repeatable answers)."""

    def __init__(
        self,
        base_url: str,
        model: str,
        api_key: SecretStr | None = None,
        timeout: float = 60.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.model = model
        self._url = base_url.rstrip("/") + "/chat/completions"
        self._api_key = api_key
        self._timeout = timeout
        self._transport = transport

    def __repr__(self) -> str:  # never expose the key through a debugger or a log line
        return f"OpenAICompatibleClient(model={self.model!r})"

    def complete(self, messages: list[Message]) -> str:
        headers = {"Content-Type": "application/json"}
        if self._api_key is not None and self._api_key.get_secret_value():
            headers["Authorization"] = f"Bearer {self._api_key.get_secret_value()}"
        payload = {"model": self.model, "messages": messages, "temperature": 0}
        try:
            with httpx.Client(timeout=self._timeout, transport=self._transport) as client:
                response = client.post(self._url, json=payload, headers=headers)
        except httpx.TimeoutException:
            raise LLMError("the language model did not answer in time") from None
        except httpx.HTTPError as exc:
            # ``from None``: the chained exception would carry the request, including its headers.
            raise LLMError(f"could not reach the language model ({type(exc).__name__})") from None
        if response.status_code >= 400:
            raise LLMError(f"the language model endpoint returned HTTP {response.status_code}")
        try:
            content = response.json()["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError):
            raise LLMError("the language model endpoint returned an unexpected response") from None
        if not isinstance(content, str) or not content.strip():
            raise LLMError("the language model returned an empty answer")
        return content


def get_client(settings: Settings) -> LLMClient | None:
    """The configured client, or ``None`` when no language model is set up."""
    if not settings.llm_configured:
        return None
    return OpenAICompatibleClient(
        settings.llm_base_url,
        settings.llm_model,
        api_key=settings.llm_api_key,
        timeout=settings.llm_timeout_seconds,
    )


def complete_safely(client: LLMClient, messages: list[Message]) -> str | None:
    """Call the model; on failure log the reason (no prompt, no key) and return ``None``."""
    try:
        return client.complete(messages)
    except LLMError as exc:
        log.warning("language model call failed: %s", exc)
    except Exception as exc:  # noqa: BLE001 - a third-party client must not break the request
        log.warning("language model call failed: %s", type(exc).__name__)
    return None
