#!/usr/bin/env python
"""prism_seat.py — run ONE prism verification for ONE jury seat.

Why this shim exists instead of shelling `prism verify` (verified against
prism-verify 1.6.0 on 2026-07-14, not assumed):

`prism verify` (cli/main.py) constructs ``VerificationEngine(providers=...)`` with a
default ``FamilyRouter``, so it never calls ``resolve_routing_map()``. That function is
the F-14 config registry — the only reader of ``PRISM_VERIFIER_MODEL_*`` — and it is
reached solely through ``build_default_engine()`` (core/setup.py), which today only
prism's MCP server uses. So the CLI always resolves the hardcoded DEFAULT_ROUTING_MAP,
and every seat would run on ``mistral-small:24b`` regardless of its env recipe: five
identical jurors wearing five different name tags, not a panel. The CLI also registers
only ollama OR anthropic, so an OpenAI-compatible cloud seat is unreachable there at
all. Calling prism's own shared factory is what makes a seat's env recipe actually
select that seat's model.

Contract: read ONE JSON request on stdin, write ONE JSON response on stdout in EXACTLY
the shape `prism verify` prints — ``VerifyResponse.model_dump()``, or ``{"error": {...}}``
for a ``VerifyError``. Holding that shape keeps the Node parser transport-agnostic: if
the upstream CLI gap is fixed, the transport can swap with no parser change.

The seat's model selection is this PROCESS's env, set by the caller. This script takes
no model argument, so there is exactly one source of truth for who sits on the jury.
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

# Mirrors prism's own RefusalReason codes so a shim-level failure is indistinguishable
# in shape from a prism-level one and the caller has a single abstain path.
_REASON_UNAVAILABLE = "VERIFIER_UNAVAILABLE"
_REASON_INVALID = "INVALID_ARTIFACT"


def _emit(payload: dict[str, Any]) -> None:
    json.dump(payload, sys.stdout, default=str)
    sys.stdout.write("\n")


def _fail(reason: str, detail: str) -> int:
    _emit({"error": {"reason": reason, "detail": detail, "retryable": False}})
    return 0


def main() -> int:
    try:
        req = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        return _fail(_REASON_INVALID, f"seat request is not valid JSON: {exc}")

    try:
        from prism.core.setup import build_default_engine
        from prism.core.types import (
            Artifact,
            ArtifactType,
            Budget,
            CallerContext,
            ModelFamily,
            VerifyError,
            VerifyRequest,
        )
    except ImportError as exc:
        return _fail(_REASON_UNAVAILABLE, f"prism-verify is not importable: {exc}")

    try:
        request = VerifyRequest(
            artifact=Artifact(
                type=ArtifactType(req["artifact_type"]),
                content=req["content"],
            ),
            intent=req["intent"],
            caller=CallerContext(
                model_family=ModelFamily(req["caller_family"]),
                model_id=req["caller_model"],
            ),
            budget=Budget(max_latency_ms=req["max_latency_ms"]),
        )
    except (KeyError, ValueError, TypeError) as exc:
        return _fail(_REASON_INVALID, f"{type(exc).__name__}: {exc}")

    # Every failure below becomes a structured abstain rather than a traceback: this is
    # a jury seat, and the panel's contract is that a dead juror abstains instead of
    # crashing or biasing the panel. An unparseable traceback would strand the caller
    # with no verdict to record.
    try:
        # Resolves PRISM_VERIFIER_MODEL_* from THIS process's env — the whole reason the
        # shim exists.
        engine = build_default_engine()
        result = asyncio.run(engine.verify(request))
    except Exception as exc:  # noqa: BLE001 — see the abstain rationale above
        return _fail(_REASON_UNAVAILABLE, f"{type(exc).__name__}: {exc}")

    if isinstance(result, VerifyError):
        _emit({"error": result.model_dump()})
    else:
        _emit(result.model_dump())
    return 0


if __name__ == "__main__":
    sys.exit(main())
