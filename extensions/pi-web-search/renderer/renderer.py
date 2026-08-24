#!/usr/bin/env python3
"""Local JavaScript renderer for pi-web-search.

The process communicates exclusively through JSON Lines on stdin/stdout.
Diagnostic messages belong on stderr so stdout remains machine-readable.
"""

from __future__ import annotations

import json
import sys
import time
from typing import Any
from urllib.parse import urlparse


MAX_TIMEOUT_MS = 60_000
DEFAULT_TIMEOUT_MS = 20_000
DEFAULT_SETTLE_MS = 1_000
MAX_SETTLE_MS = 10_000


def write_response(response: dict[str, Any]) -> None:
    print(json.dumps(response, ensure_ascii=False, separators=(",", ":")), flush=True)


def error_response(request_id: Any, message: str) -> dict[str, Any]:
    return {"id": request_id, "ok": False, "error": message}


def validate_request(request: dict[str, Any]) -> tuple[str, int, int]:
    url = request.get("url")
    if not isinstance(url, str) or not url.strip():
        raise ValueError("url must be a non-empty string")

    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("only http and https URLs are supported")

    timeout_ms = request.get("timeoutMs", DEFAULT_TIMEOUT_MS)
    if not isinstance(timeout_ms, (int, float)):
        raise ValueError("timeoutMs must be a number")
    timeout_ms = max(1, min(int(timeout_ms), MAX_TIMEOUT_MS))

    settle_ms = request.get("settleMs", DEFAULT_SETTLE_MS)
    if not isinstance(settle_ms, (int, float)):
        raise ValueError("settleMs must be a number")
    settle_ms = max(0, min(int(settle_ms), MAX_SETTLE_MS))

    return url, timeout_ms, settle_ms


def render_page(browser: Any, request: dict[str, Any]) -> dict[str, Any]:
    request_id = request.get("id")
    url, timeout_ms, settle_ms = validate_request(request)
    timeout = timeout_ms

    context = browser.new_context()
    page = context.new_page()
    started = time.monotonic()
    try:
        response = page.goto(url, wait_until="domcontentloaded", timeout=timeout)
        # A short settling period allows the SPA bootstrap and initial API calls
        # to update the DOM without requiring networkidle, which is unreliable
        # for pages with long-lived connections.
        if settle_ms:
            page.wait_for_timeout(settle_ms)

        return {
            "id": request_id,
            "ok": True,
            "finalUrl": page.url,
            "status": response.status if response is not None else None,
            "html": page.content(),
            "elapsedMs": int((time.monotonic() - started) * 1000),
        }
    finally:
        context.close()


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as error:
        print(f"Playwright indisponível: {error}", file=sys.stderr, flush=True)
        return 2

    with sync_playwright() as playwright:
        try:
            browser = playwright.chromium.launch(headless=True)
        except Exception as error:  # pragma: no cover - requires a browser install
            print(f"Não foi possível iniciar o Chromium: {error}", file=sys.stderr, flush=True)
            return 3

        with browser:
            for line in sys.stdin:
                if not line.strip():
                    continue
                request_id: Any = None
                try:
                    request = json.loads(line)
                    if not isinstance(request, dict):
                        raise ValueError("request must be a JSON object")
                    request_id = request.get("id")
                    if request.get("action") == "health":
                        response = {"id": request_id, "ok": True, "action": "health"}
                    else:
                        response = render_page(browser, request)
                except json.JSONDecodeError as error:
                    response = error_response(request_id, f"invalid JSON: {error.msg}")
                except Exception as error:
                    response = error_response(request_id, str(error))
                write_response(response)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
