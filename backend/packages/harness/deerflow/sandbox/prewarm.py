"""Predictive sandbox prewarm helpers.

The default sandbox lifecycle stays lazy: tools still own the first mandatory
acquire.  This module lets a run start a best-effort AIO acquire in the
background when language-agnostic structured signals point at sandbox work.
Tool initialization can then await/reuse that in-flight task instead of
starting from zero.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import time
import weakref
from collections.abc import Mapping
from typing import Any

from deerflow.config.app_config import AppConfig
from deerflow.config.sandbox_config import SandboxPrewarmConfig
from deerflow.sandbox.sandbox_provider import get_sandbox_provider

logger = logging.getLogger(__name__)

PREWARM_TASK_CONTEXT_KEY = "__sandbox_prewarm_task"
PREWARM_SANDBOX_ID_CONTEXT_KEY = "__sandbox_prewarm_sandbox_id"
PREWARM_CONSUMED_CONTEXT_KEY = "__sandbox_prewarm_consumed"
PREWARM_TRIGGER_CONTEXT_KEY = "__sandbox_prewarm_trigger"
PREWARM_DESTROY_UNUSED_CONTEXT_KEY = "__sandbox_prewarm_destroy_unused"

_SHELL_COMMAND = r"bash|sh|zsh|pwd|ls|cat|grep|sed|awk|find|git|python|python3|pytest|pip|uv|npm|pnpm|yarn|node|make|cmake|cargo|go|docker|docker-compose"
_CODE_FENCE_RE = re.compile(r"```|~~~")
_INLINE_CODE_RE = re.compile(r"`([^`\n]+)`")
_SHELL_PROMPT_RE = re.compile(rf"(?im)^\s*(?:[$#>]|PS [^>]+>)\s*(?:{_SHELL_COMMAND})\b")
_COMMAND_LINE_RE = re.compile(rf"(?im)^\s*(?:{_SHELL_COMMAND})(?:\s+[-A-Za-z0-9_./:=@]+)*\s*$")
_CLI_SUBCOMMAND_RE = re.compile(
    r"(?ix)"
    r"\b(?:git|npm|pnpm|yarn|pip|uv|cargo|docker|make|cmake|go)\s+"
    r"(?:status|diff|test|install|run|build|sync|compose|logs?|up|down|check|fmt|vet)\b"
)
_TOOL_NAME_RE = re.compile(r"(?i)\b(?:bash_tool|read_file|write_file|edit_file|ls_tool|grep_tool|glob_tool)\b")
_PATH_RE = re.compile(
    r"(?i)(?:^|[\s`'\"(])("
    r"(?:\.{1,2}|~)?/[A-Za-z0-9._/\-]+|"
    r"[A-Za-z]:\\[A-Za-z0-9._\\/\-]+|"
    r"[A-Za-z0-9_.\-]+/[A-Za-z0-9._/\-]+|"
    r"[A-Za-z0-9_.\-]+\.(?:py|js|jsx|ts|tsx|json|ya?ml|toml|md|txt|log|sh|sql|java|go|rs|css|html|csv|tsv|xml|env|ini|cfg|conf|lock|ipynb|dockerfile)"
    r")(?:\s|$|[`'\"),:])"
)
_STACKTRACE_RE = re.compile(
    r"(?im)"
    r"(traceback \(most recent call last\)|stack trace\s*[:\n]|"
    r"^\s*(?:file \"[^\"]+\", line \d+|at\s+\S+\s+\(.+:\d+:\d+\)|"
    r"(?:[a-z_][\w.]*)(?:error|exception):\s+|error:\s+\S+|failed:\s+\S+))"
)

_LOOP_SEMAPHORES: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, tuple[int, asyncio.Semaphore]] = weakref.WeakKeyDictionary()


def _is_aio_sandbox(app_config: AppConfig) -> bool:
    sandbox = getattr(app_config, "sandbox", None)
    sandbox_use = getattr(sandbox, "use", "") or ""
    return "AioSandboxProvider" in sandbox_use or "aio_sandbox" in sandbox_use


def _prewarm_config(app_config: AppConfig) -> SandboxPrewarmConfig:
    sandbox = getattr(app_config, "sandbox", None)
    return getattr(sandbox, "prewarm", SandboxPrewarmConfig()) or SandboxPrewarmConfig()


def _text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, Mapping):
                text = item.get("text") or item.get("content")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(parts)
    return ""


def _message_role(message: Any) -> str | None:
    if isinstance(message, Mapping):
        role = message.get("role") or message.get("type")
    else:
        role = getattr(message, "type", None) or getattr(message, "role", None)
    return role if isinstance(role, str) else None


def latest_user_message(graph_input: Mapping[str, Any] | None) -> Any | None:
    """Return the latest user/human message object or mapping from LangGraph input."""
    if not isinstance(graph_input, Mapping):
        return None

    messages = graph_input.get("messages")
    if not isinstance(messages, list):
        return graph_input

    for message in reversed(messages):
        if _message_role(message) in {None, "user", "human"}:
            return message
    return None


def latest_user_text(graph_input: Mapping[str, Any] | None) -> str:
    """Extract the latest user/human message text from LangGraph input."""
    message = latest_user_message(graph_input)
    if message is None:
        return ""
    if isinstance(message, Mapping):
        return _text_from_content(message.get("message") or message.get("content"))
    return _text_from_content(getattr(message, "content", None))


def _message_additional_kwargs(message: Any) -> Mapping[str, Any]:
    if isinstance(message, Mapping):
        kwargs = message.get("additional_kwargs")
        if isinstance(kwargs, Mapping):
            return kwargs
        return message
    kwargs = getattr(message, "additional_kwargs", None)
    return kwargs if isinstance(kwargs, Mapping) else {}


def _has_upload_files(message: Any | None) -> bool:
    if message is None:
        return False
    files = _message_additional_kwargs(message).get("files")
    return isinstance(files, list) and any(isinstance(file, Mapping) for file in files)


def _has_command_literal(text: str) -> bool:
    if _SHELL_PROMPT_RE.search(text) or _COMMAND_LINE_RE.search(text):
        return True
    for match in _INLINE_CODE_RE.finditer(text):
        literal = match.group(1).strip()
        if _PATH_RE.search(literal) or _COMMAND_LINE_RE.search(literal) or _CLI_SUBCOMMAND_RE.search(literal):
            return True
    return False


def predict_sandbox_prewarm(graph_input: Mapping[str, Any] | None, app_config: AppConfig) -> tuple[bool, str]:
    """Return whether this run should prewarm and a short trigger reason."""
    cfg = _prewarm_config(app_config)
    if not cfg.enabled:
        return False, "disabled"
    if not _is_aio_sandbox(app_config):
        return False, "not-aio"
    if cfg.mode == "always":
        return True, "always"

    message = latest_user_message(graph_input)
    text = latest_user_text(graph_input)

    lowered = text.lower()
    for keyword in tuple(cfg.trigger_keywords):
        if keyword and keyword.lower() in lowered:
            return True, f"custom-keyword:{keyword}"
    if _has_upload_files(message):
        return True, "uploaded-files"
    if _PATH_RE.search(text):
        return True, "path-pattern"
    if _CODE_FENCE_RE.search(text):
        return True, "code-fence"
    if _has_command_literal(text):
        return True, "command-pattern"
    if _STACKTRACE_RE.search(text):
        return True, "error-pattern"
    if _TOOL_NAME_RE.search(text):
        return True, "tool-name-pattern"
    if not text:
        return False, "empty-input"
    return False, "no-match"


def should_prewarm_sandbox(graph_input: Mapping[str, Any] | None, app_config: AppConfig) -> bool:
    """Boolean wrapper for callers/tests that do not need the trigger reason."""
    enabled, _ = predict_sandbox_prewarm(graph_input, app_config)
    return enabled


def _semaphore_for_current_loop(max_concurrent: int) -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    existing = _LOOP_SEMAPHORES.get(loop)
    if existing is not None:
        capacity, semaphore = existing
        if capacity == max_concurrent:
            return semaphore
    semaphore = asyncio.Semaphore(max_concurrent)
    _LOOP_SEMAPHORES[loop] = (max_concurrent, semaphore)
    return semaphore


async def _prewarm_sandbox(thread_id: str, runtime_context: dict[str, Any], max_concurrent: int) -> str:
    semaphore = _semaphore_for_current_loop(max_concurrent)
    async with semaphore:
        started = time.perf_counter()
        sandbox_id = await get_sandbox_provider().acquire_async(thread_id)
        elapsed = time.perf_counter() - started
        runtime_context[PREWARM_SANDBOX_ID_CONTEXT_KEY] = sandbox_id
        runtime_context.setdefault("sandbox_id", sandbox_id)
        logger.info("Prewarmed sandbox %s for thread %s in %.3fs", sandbox_id, thread_id, elapsed)
        return sandbox_id


def _log_task_result(task: asyncio.Task[str]) -> None:
    if task.cancelled():
        logger.info("Sandbox prewarm task was cancelled")
        return
    try:
        task.result()
    except Exception as exc:
        logger.info("Sandbox prewarm failed; lazy acquire will be used if needed: %s", exc)


def start_sandbox_prewarm_if_needed(
    runtime_context: dict[str, Any],
    graph_input: Mapping[str, Any] | None,
    app_config: AppConfig | None,
) -> asyncio.Task[str] | None:
    """Start best-effort predictive prewarm for a run.

    Returns the task when one was started.  The task is also stored in the
    runtime context so lazy tool initialization can await/reuse it.
    """
    if app_config is None:
        return None
    should_prewarm, reason = predict_sandbox_prewarm(graph_input, app_config)
    if not should_prewarm:
        return None

    thread_id = runtime_context.get("thread_id")
    if not isinstance(thread_id, str) or not thread_id:
        return None

    existing = runtime_context.get(PREWARM_TASK_CONTEXT_KEY)
    if isinstance(existing, asyncio.Task):
        return existing

    cfg = _prewarm_config(app_config)
    runtime_context[PREWARM_TRIGGER_CONTEXT_KEY] = reason
    runtime_context[PREWARM_DESTROY_UNUSED_CONTEXT_KEY] = cfg.destroy_unused
    task = asyncio.create_task(
        _prewarm_sandbox(thread_id, runtime_context, cfg.max_concurrent),
        name=f"sandbox-prewarm-{thread_id}",
    )
    task.add_done_callback(_log_task_result)
    runtime_context[PREWARM_TASK_CONTEXT_KEY] = task
    logger.info("Started predictive sandbox prewarm for thread %s (%s)", thread_id, reason)
    return task


def _sandbox_id_from_finished_task(task: asyncio.Task[str], runtime_context: dict[str, Any]) -> str | None:
    if task.cancelled():
        return None
    try:
        sandbox_id = task.result()
    except Exception as exc:
        logger.info("Ignoring failed sandbox prewarm and falling back to lazy acquire: %s", exc)
        return None
    runtime_context[PREWARM_CONSUMED_CONTEXT_KEY] = True
    runtime_context[PREWARM_SANDBOX_ID_CONTEXT_KEY] = sandbox_id
    runtime_context.setdefault("sandbox_id", sandbox_id)
    return sandbox_id


def consume_prewarmed_sandbox_id(runtime_context: dict[str, Any] | None) -> str | None:
    """Return a completed prewarm sandbox id for sync tool paths, if any."""
    if runtime_context is None:
        return None
    task = runtime_context.get(PREWARM_TASK_CONTEXT_KEY)
    if isinstance(task, asyncio.Task):
        if not task.done():
            return None
        return _sandbox_id_from_finished_task(task, runtime_context)

    sandbox_id = runtime_context.get(PREWARM_SANDBOX_ID_CONTEXT_KEY)
    if isinstance(sandbox_id, str):
        runtime_context[PREWARM_CONSUMED_CONTEXT_KEY] = True
        return sandbox_id
    return None


async def consume_prewarmed_sandbox_id_async(runtime_context: dict[str, Any] | None) -> str | None:
    """Await and consume an in-flight prewarm sandbox id for async tool paths."""
    if runtime_context is None:
        return None

    task = runtime_context.get(PREWARM_TASK_CONTEXT_KEY)
    if isinstance(task, asyncio.Task):
        with contextlib.suppress(asyncio.CancelledError):
            try:
                sandbox_id = await task
            except Exception as exc:
                logger.info("Ignoring failed sandbox prewarm and falling back to lazy acquire: %s", exc)
                return None
            runtime_context[PREWARM_CONSUMED_CONTEXT_KEY] = True
            runtime_context[PREWARM_SANDBOX_ID_CONTEXT_KEY] = sandbox_id
            runtime_context.setdefault("sandbox_id", sandbox_id)
            return sandbox_id
        return None

    sandbox_id = runtime_context.get(PREWARM_SANDBOX_ID_CONTEXT_KEY)
    if isinstance(sandbox_id, str):
        runtime_context[PREWARM_CONSUMED_CONTEXT_KEY] = True
        return sandbox_id
    return None


def _cleanup_finished_prewarm(runtime_context: dict[str, Any], sandbox_id: str) -> None:
    provider = get_sandbox_provider()
    destroy_unused = bool(runtime_context.get(PREWARM_DESTROY_UNUSED_CONTEXT_KEY, True))
    if destroy_unused and not runtime_context.get(PREWARM_CONSUMED_CONTEXT_KEY):
        destroy = getattr(provider, "destroy", None)
        if callable(destroy):
            destroy(sandbox_id)
            logger.info("Destroyed unused prewarmed sandbox %s", sandbox_id)
            return
    provider.release(sandbox_id)
    logger.info("Released prewarmed sandbox %s during cleanup", sandbox_id)


async def cleanup_sandbox_prewarm(runtime_context: dict[str, Any] | None) -> None:
    """Clean up unused prewarm work after a run completes.

    If the task is still in flight, attach a callback that releases/destroys the
    sandbox when acquisition eventually finishes rather than blocking the final
    response path.
    """
    if runtime_context is None:
        return
    task = runtime_context.get(PREWARM_TASK_CONTEXT_KEY)
    if not isinstance(task, asyncio.Task):
        return
    if runtime_context.get(PREWARM_CONSUMED_CONTEXT_KEY):
        return

    if not task.done():
        task.add_done_callback(lambda done: _cleanup_prewarm_task_done(done, runtime_context))
        return

    sandbox_id = _result_for_cleanup(task)
    if sandbox_id is None:
        return
    await asyncio.to_thread(_cleanup_finished_prewarm, runtime_context, sandbox_id)


def _result_for_cleanup(task: asyncio.Task[str]) -> str | None:
    if task.cancelled():
        return None
    try:
        return task.result()
    except Exception:
        return None


def _cleanup_prewarm_task_done(task: asyncio.Task[str], runtime_context: dict[str, Any]) -> None:
    sandbox_id = _result_for_cleanup(task)
    if sandbox_id is None:
        return
    try:
        _cleanup_finished_prewarm(runtime_context, sandbox_id)
    except Exception:
        logger.warning("Failed to clean up completed sandbox prewarm %s", sandbox_id, exc_info=True)
