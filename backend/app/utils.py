from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8].upper()}"


def now_ms() -> int:
    return int(time.time() * 1000)


@contextmanager
def elapsed_timer() -> Iterator[dict[str, int]]:
    start = now_ms()
    box = {"elapsed_ms": 0}
    try:
        yield box
    finally:
        box["elapsed_ms"] = max(0, now_ms() - start)


def receipt_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def sql_string(value: Any) -> str:
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def simple_policy_vector(text: str) -> list[float]:
    tokens = re.findall(r"[a-z0-9]+", text.lower())
    buckets = [0.0] * 8
    for token in tokens:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        idx = digest[0] % 8
        sign = 1.0 if digest[1] % 2 == 0 else -1.0
        buckets[idx] += sign * (1.0 + min(len(token), 10) / 10.0)
    norm = sum(v * v for v in buckets) ** 0.5 or 1.0
    return [round(v / norm, 6) for v in buckets]


def vector_literal(values: list[float]) -> str:
    return "[" + ",".join(f"{v:.6f}" for v in values) + "]"


def count_code_lines(paths: list[Path]) -> int:
    total = 0
    for path in paths:
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                total += 1
    return total


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def extract_usage(result: Any) -> dict[str, int]:
    totals = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    raw_responses = getattr(result, "raw_responses", None) or []
    for response in raw_responses:
        usage = getattr(response, "usage", None)
        if usage is None and isinstance(response, dict):
            usage = response.get("usage")
        if usage is None:
            continue
        input_tokens = _usage_value(usage, "input_tokens") or _usage_value(usage, "prompt_tokens")
        output_tokens = _usage_value(usage, "output_tokens") or _usage_value(usage, "completion_tokens")
        total_tokens = _usage_value(usage, "total_tokens")
        totals["input_tokens"] += int(input_tokens or 0)
        totals["output_tokens"] += int(output_tokens or 0)
        totals["total_tokens"] += int(total_tokens or (input_tokens or 0) + (output_tokens or 0))
    usage = getattr(result, "usage", None)
    if usage is not None and totals["total_tokens"] == 0:
        totals["input_tokens"] = int(_usage_value(usage, "input_tokens") or 0)
        totals["output_tokens"] = int(_usage_value(usage, "output_tokens") or 0)
        totals["total_tokens"] = int(_usage_value(usage, "total_tokens") or totals["input_tokens"] + totals["output_tokens"])
    return totals


def _usage_value(usage: Any, key: str) -> int | None:
    if isinstance(usage, dict):
        value = usage.get(key)
    else:
        value = getattr(usage, key, None)
    return int(value) if value is not None else None


def normalize_rows(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if isinstance(value, list):
        rows = []
        for item in value:
            if isinstance(item, dict):
                rows.append(item)
        return rows
    if isinstance(value, dict):
        if isinstance(value.get("rows"), list):
            return normalize_rows(value["rows"])
        if isinstance(value.get("results"), list):
            rows: list[dict[str, Any]] = []
            for result in value["results"]:
                rows.extend(normalize_rows(result.get("result") if isinstance(result, dict) else result))
            return rows
        return [value]
    return []
