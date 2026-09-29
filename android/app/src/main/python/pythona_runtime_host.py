"""Runtime-side helpers for PythonA's embedded CPython process.

This module intentionally implements a Python console, not a POSIX terminal.
The native module is built into ``libpythona_engine.so`` and supplies the
thread-safe Android callbacks/input queue.
"""

from __future__ import annotations

import builtins
import importlib
import json
import os
import runpy
import sys
import time
import traceback
from typing import Any

import _pythona_native as _native


_installed = False


class _ConsoleStream:
    """Minimal UTF-8 text stream which forwards chunks to the Android UI."""

    encoding = "utf-8"
    errors = "strict"
    newlines = None

    def __init__(self, stream: str) -> None:
        self._stream = stream

    def write(self, value: object) -> int:
        text = str(value)
        if text:
            _native.write(self._stream, text)
        return len(text)

    def writelines(self, lines: object) -> None:
        for line in lines:
            self.write(line)

    def flush(self) -> None:
        return None

    def isatty(self) -> bool:
        return False

    def writable(self) -> bool:
        return True

    def fileno(self) -> int:
        raise OSError("PythonA console streams do not expose file descriptors")


def _console_input(prompt: object = "") -> str:
    prompt_text = str(prompt)
    if prompt_text:
        sys.stdout.write(prompt_text)
        sys.stdout.flush()
    value = _native.read_input(prompt_text)
    # Android sends one logical console line. Match builtins.input by removing
    # one line terminator without stripping meaningful surrounding whitespace.
    if value.endswith("\r\n"):
        return value[:-2]
    if value.endswith("\n") or value.endswith("\r"):
        return value[:-1]
    return value


def install(*, force: bool = False) -> None:
    """Install (or restore) the process-wide managed-console hooks."""
    global _installed
    if _installed and not force:
        return
    sys.stdout = _ConsoleStream("stdout")
    sys.stderr = _ConsoleStream("stderr")
    builtins.input = _console_input
    sys.dont_write_bytecode = True
    _installed = True


def _path_inside(root: str, candidate: object) -> bool:
    if not isinstance(candidate, (str, bytes, os.PathLike)):
        return False
    try:
        return os.path.commonpath((root, os.path.realpath(candidate))) == root
    except (OSError, TypeError, ValueError):
        return False


def _evict_workspace_modules(root: str) -> None:
    """Remove imports backed by the workspace before every script run.

    The embedded interpreter intentionally survives between runs for startup
    latency, but project modules must behave like a desktop IDE's fresh Run
    action after their source changes. Standard-library and installed runtime
    pack modules remain cached.
    """
    protected = {__name__, "_pythona_native"}
    remove = set()
    for name, module in list(sys.modules.items()):
        if name in protected or module is None:
            continue
        origins: list[object] = []
        origin = getattr(module, "__file__", None)
        if origin is not None:
            origins.append(origin)
        spec = getattr(module, "__spec__", None)
        spec_origin = getattr(spec, "origin", None)
        if spec_origin not in (None, "built-in", "frozen"):
            origins.append(spec_origin)
        package_paths = getattr(module, "__path__", None)
        if package_paths is not None:
            try:
                origins.extend(package_paths)
            except (TypeError, KeyError):
                pass
        if any(_path_inside(root, candidate) for candidate in origins):
            remove.add(name)

    for name in sorted(remove, key=lambda value: value.count('.'), reverse=True):
        sys.modules.pop(name, None)

    for path in list(sys.path_importer_cache):
        if _path_inside(root, path):
            sys.path_importer_cache.pop(path, None)
    importlib.invalidate_caches()


def _inside(root: str, candidate: str) -> tuple[str, str]:
    real_root = os.path.realpath(root)
    real_candidate = os.path.realpath(candidate)
    try:
        contained = os.path.commonpath((real_root, real_candidate)) == real_root
    except ValueError:
        contained = False
    if not contained or not os.path.isfile(real_candidate):
        raise ValueError("script is outside the workspace or is not a regular file")
    return real_root, real_candidate


def _exit_code(value: object) -> int:
    if value is None:
        return 0
    if isinstance(value, int):
        return int(value)
    sys.stderr.write(str(value) + "\n")
    return 1


def run_file(
    run_id: str,
    workspace_root: str,
    script_path: str,
    arguments_json: str,
) -> str:
    """Execute one script and return a compact JSON result.

    ``os._exit`` and native crashes intentionally remain process-fatal; Android
    restarts only the ``:runtime`` service process, leaving the editor intact.
    """
    # A previous user script may have replaced stdout/stderr/input. Restore
    # the managed console before doing any work or reporting an error.
    install(force=True)
    started = time.monotonic_ns()
    root, script = _inside(workspace_root, script_path)
    requested = json.loads(arguments_json)
    if isinstance(requested, list):
        arguments = requested
        working_directory = "/"
        configured_environment: dict[str, str] = {}
        env_files: list[str] = []
    elif isinstance(requested, dict):
        arguments = requested.get("args", [])
        working_directory = requested.get("workingDirectory", "/")
        configured_environment = requested.get("environment", {})
        env_files = requested.get("envFiles", [])
    else:
        raise ValueError("arguments_json must contain an array or run options object")
    if not isinstance(arguments, list) or not all(isinstance(v, str) for v in arguments):
        raise ValueError("run arguments must be an array of strings")
    if not isinstance(configured_environment, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in configured_environment.items()
    ):
        raise ValueError("environment must contain string keys and values")
    if not isinstance(env_files, list) or not all(isinstance(v, str) for v in env_files):
        raise ValueError("envFiles must be an array of workspace paths")

    relative_cwd = str(working_directory or "/").replace("\\", "/").lstrip("/")
    run_cwd = os.path.realpath(os.path.join(root, relative_cwd))
    if os.path.commonpath((root, run_cwd)) != root or not os.path.isdir(run_cwd):
        raise ValueError("workingDirectory is outside the workspace or is not a directory")
    loaded_environment: dict[str, str] = {}
    for env_file in env_files:
        relative_env = env_file.replace("\\", "/").lstrip("/")
        _, resolved_env = _inside(root, os.path.join(root, relative_env))
        with open(resolved_env, encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                if key and key.replace("_", "a").isascii() and key.replace("_", "a").isalnum() and not key[0].isdigit():
                    loaded_environment[key] = value.strip().strip('"').strip("'")
    loaded_environment.update(configured_environment)

    old_argv = sys.argv
    old_path = list(sys.path)
    old_cwd = os.getcwd()
    old_environment = dict(os.environ)
    exit_code = 0
    cancelled = False
    error: dict[str, Any] | None = None
    try:
        os.chdir(run_cwd)
        os.environ.update(loaded_environment)
        _evict_workspace_modules(root)
        install(force=True)
        sys.argv = [script, *arguments]
        # The script directory has normal Python command-line precedence, with
        # the workspace root immediately after it for project imports.
        script_dir = os.path.dirname(script)
        sys.path[:] = [script_dir, root, *(p for p in old_path if p not in (script_dir, root))]
        runpy.run_path(script, run_name="__main__")
    except SystemExit as exc:
        exit_code = _exit_code(exc.code)
    except KeyboardInterrupt:
        cancelled = bool(_native.cancelled())
        exit_code = 130
        if not cancelled:
            sys.stderr.write("KeyboardInterrupt\n")
    except BaseException as exc:
        exit_code = 1
        formatted = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        sys.stderr.write(formatted)
        error = {
            "type": type(exc).__name__,
            "message": str(exc),
            "traceback": formatted,
        }
    finally:
        sys.argv = old_argv
        sys.path[:] = old_path
        os.environ.clear()
        os.environ.update(old_environment)
        try:
            os.chdir(old_cwd)
        except OSError:
            os.chdir(root)

    result: dict[str, Any] = {
        "runId": run_id,
        "exitCode": exit_code,
        "cancelled": cancelled,
        "durationMillis": (time.monotonic_ns() - started) // 1_000_000,
    }
    if error is not None:
        result["exception"] = error
        # Keep the protocol-v2 runtime service's historical field while the JS
        # adapter migrates to the more explicit ``exception`` name.
        result["error"] = error
    return json.dumps(result, ensure_ascii=False, separators=(",", ":"))
