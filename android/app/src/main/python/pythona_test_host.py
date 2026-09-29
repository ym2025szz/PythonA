"""Bounded test sessions in the trusted, offline PythonA Runtime process.

Test case line/column are one-based (zero means unknown). Language positions
remain LSP UTF-16/zero-based. JNI owns the active run identity and interruption.
"""
from __future__ import annotations

import builtins
import contextlib
import importlib
import inspect
import io
import json
import linecache
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import traceback
import unittest
import warnings
import xml.etree.ElementTree as ET
from urllib.parse import quote

import _pythona_native as _native

MAX_CASES = 500
MAX_TRACEBACK_CHARS = 32 * 1024
MAX_MESSAGE_CHARS = 8 * 1024
MAX_RESULT_BYTES = 2 * 1024 * 1024
DEFAULT_PATTERNS = ("test_*.py", "*_test.py")
_EXCLUDED = {".git", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache"}


class TestHostError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class _LiveCapture(io.StringIO):
    """Keep only a bounded report prefix; stream all chunks through JNI."""
    encoding = "utf-8"

    def __init__(self, stream):
        super().__init__()
        self.stream = stream
        self.kept = 0
        self.truncated = False

    def write(self, value):
        text = str(value)
        for offset in range(0, len(text), 8192):
            try:
                _native.write(self.stream, text[offset:offset + 8192])
            except AttributeError:  # desktop protocol test double
                pass
        remaining = max(0, MAX_TRACEBACK_CHARS - self.kept)
        super().write(text[:remaining])
        self.kept += min(len(text), remaining)
        self.truncated |= len(text) > remaining
        return len(text)

    def getvalue(self):
        return super().getvalue() + ("\n…[truncated]" if self.truncated else "")


def _request_cancelled(run_id):
    try:
        return bool(_native.cancelled()) or bool(_native.is_request_cancelled(run_id))
    except AttributeError:
        return bool(_native.is_request_cancelled(run_id))


def _workspace(value):
    if not isinstance(value, str) or not value:
        raise TestHostError("invalid-workspace", "workspaceRoot is required")
    root = Path(value).resolve()
    if not root.is_dir():
        raise TestHostError("invalid-workspace", "workspaceRoot is not a directory")
    return root


def _inside(root, value, *, directory=None):
    if not isinstance(value, str) or not value or "\0" in value:
        raise TestHostError("invalid-test-path", "A workspace-relative path is required")
    normal = value.replace("\\", "/")
    if normal.startswith("/") or re.match(r"^[A-Za-z]:", normal) or ".." in normal.split("/"):
        raise TestHostError("path-outside-workspace", "Test paths must stay in the workspace")
    path = (root / normal).resolve()
    if not path.is_relative_to(root):
        raise TestHostError("path-outside-workspace", "Test path is outside the workspace")
    if not path.exists() or (directory is True and not path.is_dir()) or (directory is False and not path.is_file()):
        raise TestHostError("invalid-test-path", "Test path does not exist or has the wrong kind")
    return path


def _targets(root, payload):
    raw = payload.get("paths", payload.get("path"))
    if raw in (None, "", []):
        return [root]
    values = raw if isinstance(raw, list) else [raw]
    return [_inside(root, value) for value in values]


def _discover_paths(root, payload):
    files = set()
    for target in _targets(root, payload):
        if target.is_file():
            if target.suffix == ".py":
                files.add(target)
            continue
        for current, directories, names in os.walk(target, followlinks=False):
            directories[:] = [n for n in directories if n not in _EXCLUDED
                              and not (Path(current) / n).is_symlink()]
            for name in names:
                if not (name.startswith("test_") and name.endswith(".py") or name.endswith("_test.py")):
                    continue
                path = (Path(current) / name).resolve()
                if path.is_relative_to(root) and path.is_file():
                    files.add(path)
                if len(files) > 5000:
                    raise TestHostError("too-many-test-files", "Discovery exceeds 5000 files; select a directory")
    return sorted(files)


def _framework(requested=None):
    if requested not in (None, "", "auto", "pytest", "unittest"):
        raise TestHostError("invalid-framework", "framework must be pytest, unittest or auto")
    if requested == "unittest":
        return "unittest"
    try:
        importlib.import_module("pytest")
        return "pytest"
    except ImportError:
        return "unittest"


def capabilities():
    framework = _framework()
    return {"available": True, "framework": framework, "pytest": framework == "pytest",
            "fallback": "unittest", "methods": ["capabilities", "discover", "run", "cancel"],
            "network": False, "sandboxed": False}


def discover(payload):
    root = _workspace(payload.get("workspaceRoot"))
    files = [{"path": p.relative_to(root).as_posix(),
              "uri": "pythona://workspace/" + quote(p.relative_to(root).as_posix(), safe="/")}
             for p in _discover_paths(root, payload)]
    return {"framework": _framework(payload.get("framework")), "files": files,
            "tests": files, "count": len(files), "truncated": False}


def _environment(root, payload):
    cwd_value = payload.get("workingDirectory", payload.get("cwd", "/")) or "/"
    cwd = root if cwd_value in ("/", ".") else _inside(root, cwd_value, directory=True)
    env_files = payload.get("envFiles", [])
    configured = payload.get("environment", payload.get("env", {}))
    if not isinstance(env_files, list) or not isinstance(configured, dict):
        raise TestHostError("invalid-environment", "Invalid environment or envFiles")
    values = {}
    for value in env_files:
        path = _inside(root, value, directory=False)
        if path.stat().st_size > 1024 * 1024:
            raise TestHostError("invalid-environment", "Environment file exceeds 1 MiB")
        for raw in path.read_text(encoding="utf-8").splitlines():
            if raw.strip().startswith("#") or "=" not in raw:
                continue
            key, value = raw.split("=", 1)
            if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key.strip()):
                values[key.strip()] = value.strip().strip("\"'")
    for key, value in configured.items():
        if not isinstance(value, str) or not isinstance(key, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) or "\0" in value:
            raise TestHostError("invalid-environment", "Environment must contain valid string assignments")
        values[key] = value
    return cwd, values


def _evict_workspace_modules(root):
    remove = set()
    for name, module in list(sys.modules.items()):
        if module is None or name in {__name__, "_pythona_native", "pythona_runtime_host"}:
            continue
        origins = [getattr(module, "__file__", None), getattr(getattr(module, "__spec__", None), "origin", None)]
        paths = getattr(module, "__path__", None)
        if paths is not None:
            try:
                origins.extend(list(paths))
            except KeyError:
                origins.extend(getattr(paths, '_path', ()))
        for origin in origins:
            try:
                if origin not in (None, "built-in", "frozen") and Path(origin).resolve().is_relative_to(root):
                    remove.add(name)
                    break
            except (OSError, TypeError, ValueError):
                pass
    # Namespace paths recompute using the parent module. Inspect the whole
    # graph before deleting a parent, then remove deepest names first.
    for name in sorted(remove, key=lambda n: n.count('.'), reverse=True):
        sys.modules.pop(name, None)
    for path in list(sys.path_importer_cache):
        try:
            if Path(path).resolve().is_relative_to(root):
                sys.path_importer_cache.pop(path, None)
        except (OSError, TypeError, ValueError):
            pass
    linecache.clearcache()
    importlib.invalidate_caches()


@contextlib.contextmanager
def _session(root, payload):
    cwd, env = _environment(root, payload)
    old = (list(sys.argv), list(sys.path), os.getcwd(), dict(os.environ),
           list(sys.meta_path), list(warnings.filters), sys.stdout, sys.stderr, builtins.input,
           sys.dont_write_bytecode)
    try:
        _evict_workspace_modules(root)
        os.chdir(cwd)
        os.environ.update(env)
        os.environ["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
        os.environ.pop("PYTEST_ADDOPTS", None)
        os.environ.pop("PYTEST_PLUGINS", None)
        sys.dont_write_bytecode = True
        sys.path[:] = [str(root), str(cwd), *old[1]]
        yield
    finally:
        sys.argv = old[0]
        sys.path[:] = old[1]
        os.environ.clear()
        os.environ.update(old[3])
        sys.meta_path[:] = old[4]
        warnings.filters[:] = old[5]
        sys.stdout, sys.stderr, builtins.input = old[6:9]
        sys.dont_write_bytecode = old[9]
        try:
            os.chdir(old[2])
        except OSError:
            os.chdir(root)
        _evict_workspace_modules(root)


def _bound_text(value, limit):
    text = str(value or "")
    return (text[:limit] + "\n…[truncated]", True) if len(text) > limit else (text, False)


def _case(path, node_id, name, outcome, *, line=0, column=0, duration=0, message="", tb=""):
    message, mt = _bound_text(message, MAX_MESSAGE_CHARS)
    tb, tt = _bound_text(tb, MAX_TRACEBACK_CHARS)
    return {"id": node_id, "nodeId": node_id, "name": name, "path": path,
            "line": max(0, int(line or 0)), "column": max(0, int(column or 0)),
            "outcome": outcome, "durationMillis": max(0, int(float(duration or 0) * 1000)),
            "message": message, "traceback": tb, "truncated": mt or tt}


def _result(framework, cases, started, stdout="", stderr="", *, cancelled=False, exit_code=0):
    # Aggregate before any transport truncation. Failures after case 500 must
    # remain failures, even when their detailed rows cannot cross Binder.
    counts = {"collected": len(cases), "passed": 0, "failed": 0, "skipped": 0, "errors": 0}
    for case in cases:
        key = "errors" if case["outcome"] == "error" else case["outcome"]
        if key in counts:
            counts[key] += 1
    status = ("cancelled" if cancelled else "error" if counts["errors"] or exit_code not in (0, 1, 5)
              else "failed" if counts["failed"] or exit_code == 1
              else "empty" if not counts["collected"]
              else "skipped" if counts["skipped"] == counts["collected"] else "passed")
    output, ot = _bound_text(stdout, MAX_TRACEBACK_CHARS)
    error_output, et = _bound_text(stderr, MAX_TRACEBACK_CHARS)
    # Prefer failure details when the suite is larger than the display limit.
    retained = sorted(enumerate(cases), key=lambda x: (x[1]["outcome"] not in ("failed", "error"), x[0]))[:MAX_CASES]
    value = {"framework": framework, "status": status, "counts": counts,
             "cases": [c for _, c in retained], "stdout": output, "stderr": error_output,
             "truncated": ot or et or len(cases) > MAX_CASES or any(c.get("truncated") for c in cases),
             "durationMillis": (time.monotonic_ns() - started) // 1_000_000}
    while len(json.dumps(value, ensure_ascii=False).encode("utf-8")) > MAX_RESULT_BYTES and value["cases"]:
        value["truncated"] = True
        value["cases"].pop()
    return value


def _relative(root, value):
    try:
        path = Path(value)
        return (path if path.is_absolute() else root / path).resolve().relative_to(root).as_posix()
    except (ValueError, OSError):
        return ""


def _parse_junit(xml_path, root):
    if not xml_path.is_file():
        raise TestHostError("missing-test-report", "pytest did not produce its JUnit report")
    cases = []
    # Clear elements as they are processed; stdout/stderr never live in XML.
    for _, item in ET.iterparse(xml_path, events=("end",)):
        if item.tag != "testcase":
            continue
        properties = {p.attrib.get("name"): p.attrib.get("value")
                      for p in item.findall("./properties/property")}
        path = _relative(root, properties.get("pythona.path", item.attrib.get("file", ""))) if properties.get("pythona.path") or item.attrib.get("file") else ""
        name = item.attrib.get("name", "")
        if not name:
            # pytest can leave a placeholder reporter for an interrupted
            # setup/call. It is not a completed passing test.
            item.clear()
            continue
        node = properties.get("pythona.nodeId", (path + "::" if path else "") + name)
        line = int(properties.get("pythona.line", 0))
        if not line and "line" in item.attrib:
            line = int(item.attrib["line"]) + 1
        outcome, message, detail = "passed", "", ""
        for tag, kind in (("error", "error"), ("failure", "failed"), ("skipped", "skipped")):
            child = item.find(tag)
            if child is not None:
                outcome, message, detail = kind, child.attrib.get("message", ""), child.text or ""
                break
        cases.append(_case(path, node, name, outcome, line=line,
                           duration=float(item.attrib.get("time", 0)), message=message, tb=detail))
        item.clear()
    return cases


def _selection(root, payload):
    value = payload.get("nodeId")
    if not value:
        return None
    if not isinstance(value, str):
        raise TestHostError("invalid-node-id", "nodeId must be a string")
    path, sep, selector = value.partition("::")
    if path.endswith(".py"):
        return _inside(root, path, directory=False), selector if sep else ""
    targets = _targets(root, payload)
    if len(targets) != 1 or not targets[0].is_file():
        raise TestHostError("invalid-node-id", "A short selector requires one test file")
    return targets[0], value


def _test_arguments(payload):
    args = payload.get("args", payload.get("testArgs", []))
    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        raise TestHostError("invalid-test-args", "Test arguments must be an array of strings")
    # Paths, reports, plugins and configuration are managed by the host. This
    # prevents argv from bypassing workspace containment or overwriting reports.
    switches = {"-q", "-v", "-vv", "-x", "-s", "--disable-warnings", "--strict-markers"}
    values = {"-k", "-m", "--maxfail", "--tb"}
    result, index = [], 0
    while index < len(args):
        arg = args[index]
        if arg in switches:
            result.append(arg)
        elif arg in values and index + 1 < len(args):
            result.extend([arg, args[index + 1]])
            index += 1
        elif any(arg.startswith(option + "=") for option in values):
            result.append(arg)
        else:
            raise TestHostError("invalid-test-args", "Unsupported test option: " + arg)
        index += 1
    return result


def _run_pytest(root, payload, run_id, started):
    import pytest
    selection = _selection(root, payload)
    files = _discover_paths(root, payload)
    targets = ([str(selection[0]) + ("::" + selection[1] if selection[1] else "")] if selection
               else [str(p) for p in files])
    if not targets:
        return _result("pytest", [], started)
    extra = _test_arguments(payload)
    stdout, stderr = _LiveCapture("stdout"), _LiveCapture("stderr")

    class Reports:
        @pytest.hookimpl(tryfirst=True)
        def pytest_collection_modifyitems(self, items):
            for item in items:
                path = _relative(root, item.path)
                selector = item.nodeid.split("::", 1)[1] if "::" in item.nodeid else item.name
                item.user_properties.extend([("pythona.path", path),
                    ("pythona.nodeId", path + "::" + selector),
                    ("pythona.line", int(item.location[1]) + 1)])

        @pytest.hookimpl(hookwrapper=True)
        def pytest_runtest_makereport(self, item, call):
            outcome = yield
            report = outcome.get_result()
            if call.excinfo and report.failed:
                # Prefer the innermost workspace frame, including fixture
                # failures, rather than merely the test function's first line.
                for entry in reversed(call.excinfo.traceback):
                    path = _relative(root, str(entry.path))
                    if path:
                        props = dict(report.user_properties)
                        props.update({"pythona.path": path, "pythona.line": entry.lineno + 1})
                        report.user_properties = list(props.items())
                        item.user_properties = list(props.items())
                        break

        def pytest_runtest_setup(self, item):
            if _request_cancelled(run_id):
                pytest.exit("Test task cancelled", returncode=2)

    exit_code = 3
    with tempfile.TemporaryDirectory(prefix="pythona-test-") as temp:
        report = Path(temp) / "results.xml"
        # Isolate config/cache/output files from user paths, allow conftest.py.
        args = [*targets, *extra, "-q", "-s", "--import-mode=importlib", "-p", "no:cacheprovider",
                "-c", os.devnull, "--rootdir=" + str(root), "--confcutdir=" + str(root),
                "-o", "junit_family=xunit1", "-o", "junit_logging=no",
                "--junitxml=" + str(report)]
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                if _request_cancelled(run_id):
                    return _result("pytest", [], started, cancelled=True)
                exit_code = int(pytest.main(args, plugins=[Reports()]))
            except KeyboardInterrupt:
                exit_code = 2
        try:
            cases = _parse_junit(report, root)
        except (TestHostError, ET.ParseError):
            cases = [] if _request_cancelled(run_id) else [
                _case("", run_id, "Test runner", "error", message="Missing or invalid JUnit report",
                      tb=stderr.getvalue())]
    return _result("pytest", cases, started, stdout.getvalue(), stderr.getvalue(),
                   cancelled=_request_cancelled(run_id), exit_code=exit_code)


class _UnittestResult(unittest.TextTestResult):
    def __init__(self, root, run_id, stream):
        super().__init__(unittest.runner._WritelnDecorator(stream), True, 1)
        self.root, self.run_id, self.cases = root, run_id, []
        self.current = None
        self.began = 0

    def startTest(self, test):
        if _request_cancelled(self.run_id):
            raise KeyboardInterrupt
        self.current = {"outcome": "passed", "message": "", "tb": ""}
        self.began = time.monotonic()
        super().startTest(test)

    def addSuccess(self, test):
        super().addSuccess(test)

    def addFailure(self, test, err):
        self._error(test, err, "failed")
        super().addFailure(test, err)

    def addError(self, test, err):
        self._error(test, err, "error")
        super().addError(test, err)

    def _error(self, test, err, outcome):
        self.current.update(outcome=outcome, message=str(err[1]), tb=self._exc_info_to_string(err, test))
        frames = traceback.extract_tb(err[2])
        for frame in reversed(frames):
            path = _relative(self.root, frame.filename)
            if path:
                self.current.update(path=path, line=frame.lineno)
                break

    def addSkip(self, test, reason):
        self.current.update(outcome="skipped", message=reason)
        super().addSkip(test, reason)

    def addUnexpectedSuccess(self, test):
        self.current.update(outcome="failed", message="Unexpected success")
        super().addUnexpectedSuccess(test)

    def addExpectedFailure(self, test, err):
        self.current.update(outcome="skipped", message="Expected failure")
        super().addExpectedFailure(test, err)

    def addSubTest(self, test, subtest, err):
        if err:
            self._error(test, err, "failed" if issubclass(err[0], test.failureException) else "error")
        super().addSubTest(test, subtest, err)

    def stopTest(self, test):
        method = getattr(test, "_testMethodName", "")
        function = inspect.unwrap(getattr(test, method, None))
        try:
            path = _relative(self.root, inspect.getfile(function))
            line = inspect.getsourcelines(function)[1]
        except (OSError, TypeError):
            path, line = "", 0
        fields = self.current or {"outcome": "error", "message": "Interrupted", "tb": ""}
        node = path + "::" + test.__class__.__qualname__ + "::" + method
        self.cases.append(_case(fields.get("path", path), node, method, fields["outcome"],
            line=fields.get("line", line), duration=time.monotonic() - self.began,
            message=fields["message"], tb=fields["tb"]))
        super().stopTest(test)


def _run_unittest(root, payload, run_id, started):
    selection = _selection(root, payload)
    files = [selection[0]] if selection else _discover_paths(root, payload)
    suite, errors = unittest.TestSuite(), []
    stdout, stderr = _LiveCapture("stdout"), _LiveCapture("stderr")
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        loader = unittest.TestLoader()
        for path in files:
            if _request_cancelled(run_id):
                break
            try:
                module_name = "_pythona_test_" + str(abs(hash(str(path))))
                spec = importlib.util.spec_from_file_location(module_name, path)
                module = importlib.util.module_from_spec(spec)
                sys.modules[module_name] = module
                spec.loader.exec_module(module)
                selector = selection[1].replace("::", ".") if selection else ""
                suite.addTests(loader.loadTestsFromName(selector, module) if selector else loader.loadTestsFromModule(module))
            except Exception as error:
                text = "".join(traceback.format_exception(error))
                errors.append(_case(path.relative_to(root).as_posix(), path.relative_to(root).as_posix(),
                                    path.name, "error", message=str(error), tb=text))
        result = _UnittestResult(root, run_id, stderr)
        try:
            suite.run(result)
        except KeyboardInterrupt:
            result.stop()
        result.printErrors()
    return _result("unittest", errors + result.cases, started, stdout.getvalue(), stderr.getvalue(),
                   cancelled=_request_cancelled(run_id))


def run(payload):
    root = _workspace(payload.get("workspaceRoot"))
    run_id = str(payload.get("runId", "")).strip()
    if not run_id:
        raise TestHostError("invalid-run-id", "test runId is required")
    started = time.monotonic_ns()
    framework = _framework(payload.get("framework"))
    try:
        with _session(root, payload):
            return (_run_pytest if framework == "pytest" else _run_unittest)(root, payload, run_id, started)
    except KeyboardInterrupt:
        return _result(framework, [], started, cancelled=True)
    except TestHostError:
        raise
    except BaseException as error:
        text = "".join(traceback.format_exception(error))
        return _result(framework, [_case("", run_id, "Test runner", "error", message=str(error), tb=text)], started)
    finally:
        _native.clear_request_cancelled(run_id)


def dispatch(request_json):
    payload = {}
    try:
        request = json.loads(request_json)
        payload = request.get("payload", request)
        if not isinstance(payload, dict):
            raise TestHostError("invalid-request", "Test payload must be an object")
        method = str(request.get("method", "")).removeprefix("test.")
        if method == "capabilities":
            value = capabilities()
        elif method == "discover":
            value = discover(payload)
        elif method == "run":
            value = run(payload)
        else:
            raise TestHostError("method-not-found", "Unsupported test method")
        return json.dumps({"result": value}, ensure_ascii=False, separators=(",", ":"))
    except Exception as error:
        return json.dumps({"error": str(error), "code": getattr(error, "code", "test-host-error")},
                          ensure_ascii=False, separators=(",", ":"))
