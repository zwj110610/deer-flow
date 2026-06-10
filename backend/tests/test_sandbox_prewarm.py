from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from langchain.tools import ToolRuntime

from deerflow.config.sandbox_config import SandboxPrewarmConfig
from deerflow.sandbox.prewarm import (
    PREWARM_CONSUMED_CONTEXT_KEY,
    PREWARM_TASK_CONTEXT_KEY,
    cleanup_sandbox_prewarm,
    predict_sandbox_prewarm,
    start_sandbox_prewarm_if_needed,
)
from deerflow.sandbox.sandbox import Sandbox
from deerflow.sandbox.sandbox_provider import SandboxProvider, reset_sandbox_provider, set_sandbox_provider
from deerflow.sandbox.search import GrepMatch
from deerflow.sandbox.tools import ls_tool


def _app_config(
    *,
    enabled: bool = True,
    mode: str = "predictive",
    use: str = "deerflow.community.aio_sandbox:AioSandboxProvider",
    max_concurrent: int = 2,
    destroy_unused: bool = True,
    trigger_keywords: list[str] | None = None,
):
    return SimpleNamespace(
        sandbox=SimpleNamespace(
            use=use,
            prewarm=SandboxPrewarmConfig(
                enabled=enabled,
                mode=mode,
                max_concurrent=max_concurrent,
                destroy_unused=destroy_unused,
                trigger_keywords=trigger_keywords or [],
            ),
        )
    )


def _graph_input(text: str, *, files: list[dict] | None = None) -> dict:
    message = {"role": "user", "content": text}
    if files is not None:
        message["additional_kwargs"] = {"files": files}
    return {"messages": [message]}


class _SandboxStub(Sandbox):
    def execute_command(self, command: str) -> str:
        return "OK"

    def read_file(self, path: str) -> str:
        return "content"

    def download_file(self, path: str) -> bytes:
        return b"content"

    def list_dir(self, path: str, max_depth: int = 2) -> list[str]:
        return ["/mnt/user-data/workspace/file.txt"]

    def write_file(self, path: str, content: str, append: bool = False) -> None:
        return None

    def glob(self, path: str, pattern: str, *, include_dirs: bool = False, max_results: int = 200) -> tuple[list[str], bool]:
        return [], False

    def grep(
        self,
        path: str,
        pattern: str,
        *,
        glob: str | None = None,
        literal: bool = False,
        case_sensitive: bool = False,
        max_results: int = 100,
    ) -> tuple[list[GrepMatch], bool]:
        return [], False

    def update_file(self, path: str, content: bytes) -> None:
        return None


class _AsyncProvider(SandboxProvider):
    def __init__(self, *, delay: float = 0.0, fail_async: bool = False) -> None:
        self.delay = delay
        self.fail_async = fail_async
        self.acquire_calls: list[str | None] = []
        self.acquire_async_calls: list[str | None] = []
        self.released_ids: list[str] = []
        self.destroyed_ids: list[str] = []
        self.active = 0
        self.max_active = 0
        self.sandbox = _SandboxStub("sandbox-1")

    def acquire(self, thread_id: str | None = None) -> str:
        self.acquire_calls.append(thread_id)
        return "sandbox-1"

    async def acquire_async(self, thread_id: str | None = None) -> str:
        self.acquire_async_calls.append(thread_id)
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            if self.fail_async:
                raise RuntimeError("prewarm failed")
            return "sandbox-1"
        finally:
            self.active -= 1

    def get(self, sandbox_id: str) -> Sandbox | None:
        return self.sandbox if sandbox_id == "sandbox-1" else None

    def release(self, sandbox_id: str) -> None:
        self.released_ids.append(sandbox_id)

    def destroy(self, sandbox_id: str) -> None:
        self.destroyed_ids.append(sandbox_id)


def _runtime(context: dict) -> ToolRuntime:
    return ToolRuntime(
        state={},
        context=context,
        config={"configurable": {}},
        stream_writer=lambda _: None,
        tools=[],
        tool_call_id="call-1",
        store=None,
    )


def test_predictive_prewarm_matches_structural_signals() -> None:
    app_config = _app_config()

    path_should, path_reason = predict_sandbox_prewarm(_graph_input("Please inspect backend/app.py"), app_config)
    command_should, command_reason = predict_sandbox_prewarm(_graph_input("Please run `pytest -q`"), app_config)
    upload_should, upload_reason = predict_sandbox_prewarm(
        _graph_input("Please analyze this", files=[{"filename": "data.csv", "size": 10}]),
        app_config,
    )

    assert (path_should, path_reason) == (True, "path-pattern")
    assert (command_should, command_reason) == (True, "command-pattern")
    assert (upload_should, upload_reason) == (True, "uploaded-files")


def test_predictive_prewarm_skips_ordinary_chat_and_non_aio() -> None:
    should_chat, reason_chat = predict_sandbox_prewarm(_graph_input("介绍一下这个项目的愿景"), _app_config())
    should_command_concept, reason_command_concept = predict_sandbox_prewarm(_graph_input("What does pwd mean in a shell?"), _app_config())
    should_local, reason_local = predict_sandbox_prewarm(
        _graph_input("Please run `pytest -q`"),
        _app_config(use="deerflow.sandbox.local:LocalSandboxProvider"),
    )

    assert (should_chat, reason_chat) == (False, "no-match")
    assert (should_command_concept, reason_command_concept) == (False, "no-match")
    assert (should_local, reason_local) == (False, "not-aio")


def test_prewarm_always_mode_ignores_prompt_heuristics() -> None:
    should, reason = predict_sandbox_prewarm(_graph_input("普通聊天"), _app_config(mode="always"))

    assert (should, reason) == (True, "always")


@pytest.mark.anyio
async def test_async_tool_reuses_in_flight_prewarm() -> None:
    provider = _AsyncProvider(delay=0.01)
    set_sandbox_provider(provider)
    try:
        context = {"thread_id": "thread-prewarm"}
        task = start_sandbox_prewarm_if_needed(context, _graph_input("Please run `pwd`"), _app_config())
        assert task is not None

        result = await ls_tool.ainvoke({"runtime": _runtime(context), "description": "list workspace", "path": "/mnt/user-data/workspace"})
    finally:
        reset_sandbox_provider()

    assert result == "/mnt/user-data/workspace/file.txt"
    assert provider.acquire_async_calls == ["thread-prewarm"]
    assert provider.acquire_calls == []
    assert context[PREWARM_CONSUMED_CONTEXT_KEY] is True


@pytest.mark.anyio
async def test_failed_prewarm_falls_back_to_lazy_acquire() -> None:
    provider = _AsyncProvider()
    set_sandbox_provider(provider)
    try:
        context = {"thread_id": "thread-fallback"}

        async def fail() -> str:
            raise RuntimeError("boom")

        context[PREWARM_TASK_CONTEXT_KEY] = asyncio.create_task(fail())
        result = await ls_tool.ainvoke({"runtime": _runtime(context), "description": "list workspace", "path": "/mnt/user-data/workspace"})
    finally:
        reset_sandbox_provider()

    assert result == "/mnt/user-data/workspace/file.txt"
    assert provider.acquire_async_calls == ["thread-fallback"]


@pytest.mark.anyio
async def test_cleanup_destroys_unused_completed_prewarm() -> None:
    provider = _AsyncProvider()
    set_sandbox_provider(provider)
    try:
        context = {"thread_id": "thread-unused"}
        task = start_sandbox_prewarm_if_needed(context, _graph_input("Please run `pwd`"), _app_config(destroy_unused=True))
        assert task is not None
        await task

        await cleanup_sandbox_prewarm(context)
    finally:
        reset_sandbox_provider()

    assert provider.destroyed_ids == ["sandbox-1"]
    assert provider.released_ids == []


@pytest.mark.anyio
async def test_cleanup_leaves_consumed_prewarm_to_sandbox_middleware() -> None:
    provider = _AsyncProvider()
    set_sandbox_provider(provider)
    try:
        context = {"thread_id": "thread-consumed"}
        task = start_sandbox_prewarm_if_needed(context, _graph_input("Please run `pwd`"), _app_config(destroy_unused=True))
        assert task is not None
        await task
        context[PREWARM_CONSUMED_CONTEXT_KEY] = True

        await cleanup_sandbox_prewarm(context)
    finally:
        reset_sandbox_provider()

    assert provider.destroyed_ids == []
    assert provider.released_ids == []


@pytest.mark.anyio
async def test_prewarm_respects_max_concurrent() -> None:
    provider = _AsyncProvider(delay=0.02)
    set_sandbox_provider(provider)
    try:
        app_config = _app_config(max_concurrent=1)
        contexts = [{"thread_id": "thread-a"}, {"thread_id": "thread-b"}]
        tasks = [start_sandbox_prewarm_if_needed(ctx, _graph_input("Please run `pwd`"), app_config) for ctx in contexts]
        assert all(task is not None for task in tasks)
        await asyncio.gather(*(task for task in tasks if task is not None))
    finally:
        reset_sandbox_provider()

    assert provider.acquire_async_calls == ["thread-a", "thread-b"]
    assert provider.max_active == 1
