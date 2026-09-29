"""Single-worker Jedi 0.20 JSON host used by PythonA's ``:language`` process.

The wire format follows the useful subset of LSP 3.17 while retaining
PythonA's URI/epoch/bufferVersion gate.  All positions crossing the boundary
are UTF-16 positions; Jedi's Python-code-point columns are converted here.
"""

from __future__ import annotations

from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass
import json
import os
from pathlib import Path
import sys
import tempfile
import traceback
import keyword
from typing import Any, Callable
from urllib.parse import quote, unquote, urlparse

import _pythona_native as _native
import jedi
from jedi.api.environment import InterpreterEnvironment
from jedi.inference import references as _jedi_references


jedi.settings.add_bracket_after_function = False
jedi.settings.auto_import_modules = []
jedi.settings.fast_parser = True
_jedi_cache = Path(tempfile.gettempdir()) / "pythona-jedi-cache"
_jedi_cache.mkdir(parents=True, exist_ok=True)
jedi.settings.cache_directory = str(_jedi_cache)


@dataclass
class _Document:
    uri: str
    text: str
    version: int
    epoch: int
    path: str | None
    workspace_root: str | None
    language_id: str = "python"


class _HostError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


_documents: dict[str, _Document] = {}
_projects: dict[str, jedi.Project] = {}
_completion_cache: OrderedDict[str, dict[str, Any]] = OrderedDict()
_completion_sequence = 0
_environment = InterpreterEnvironment()

_KIND = {
    "module": "Module",
    "class": "Class",
    "instance": "Variable",
    "function": "Function",
    "param": "Variable",
    "path": "File",
    "keyword": "Keyword",
    "property": "Property",
    "statement": "Variable",
}


def _method_name(value: object) -> str:
    method = str(value or "")
    if method.startswith("language/"):
        method = method[len("language/"):]
    if method.startswith("textDocument/"):
        method = method[len("textDocument/"):]
    aliases = {
        "didOpen": "openDocument",
        "didChange": "changeDocument",
        "didClose": "closeDocument",
        "completion": "complete",
        "completionItem/resolve": "resolveCompletion",
        "documentSymbol": "documentSymbols",
        "findReferences": "references",
        "renameSymbol": "rename",
        "publishDiagnostics": "diagnose",
        "$/cancelRequest": "cancel",
    }
    return aliases.get(method, method)


def _int(value: object, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    try:
        result = int(value)
    except (TypeError, ValueError):
        return default
    return result if result >= 0 else default


def _uri(payload: dict[str, Any]) -> str:
    uri = payload.get("uri")
    text_document = payload.get("textDocument")
    if not uri and isinstance(text_document, dict):
        uri = text_document.get("uri")
    if not uri and payload.get("path"):
        path = str(payload["path"])
        uri = Path(path).as_uri() if os.path.isabs(path) else "pythona://workspace/" + quote(path)
    if not uri:
        raise _HostError("invalid-document", "document URI is required")
    return str(uri)


def _document_values(payload: dict[str, Any]) -> tuple[str, str, int, int, str | None, str | None, str]:
    td = payload.get("textDocument")
    source = td if isinstance(td, dict) else payload
    uri = _uri(payload)
    text = source.get("text", payload.get("text", payload.get("content", "")))
    version = _int(source.get("version", payload.get("version", payload.get("bufferVersion", 1))), 1)
    epoch = _int(payload.get("epoch", 1), 1)
    path = payload.get("path")
    workspace_root = payload.get("workspaceRoot") or payload.get("workspace")
    language_id = str(source.get("languageId", payload.get("languageId", "python")))
    return uri, str(text), version, epoch, str(path) if path else None, str(workspace_root) if workspace_root else None, language_id


def _line(text: str, line_number: int) -> str:
    lines = text.split("\n")
    if line_number < 0:
        return lines[0]
    if line_number >= len(lines):
        return lines[-1]
    return lines[line_number]


def _utf16_length(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def _utf16_to_codepoint(text: str, units: int) -> int:
    if units <= 0:
        return 0
    consumed = 0
    for index, character in enumerate(text):
        width = 2 if ord(character) > 0xFFFF else 1
        if consumed + width > units:
            return index
        consumed += width
        if consumed == units:
            return index + 1
    return len(text)


def _position_to_jedi(text: str, position: object) -> tuple[int, int]:
    position = position if isinstance(position, dict) else {}
    zero_line = _int(position.get("line"), 0)
    units = _int(position.get("character"), 0)
    return zero_line + 1, _utf16_to_codepoint(_line(text, zero_line), units)


def _jedi_to_position(text: str, line: int, column: int) -> dict[str, int]:
    zero_line = max(0, int(line) - 1)
    if not text:
        return {"line": zero_line, "character": max(0, int(column))}
    segment = _line(text, zero_line)
    return {
        "line": zero_line,
        "character": _utf16_length(segment[:max(0, int(column))]),
    }


def _range(text: str, start: tuple[int, int], end: tuple[int, int]) -> dict[str, Any]:
    return {
        "start": _jedi_to_position(text, start[0], start[1]),
        "end": _jedi_to_position(text, end[0], end[1]),
    }


def _apply_changes(text: str, changes: object) -> str:
    if not isinstance(changes, list):
        raise _HostError("invalid-change", "contentChanges must be an array")
    result = text
    for change in changes:
        if not isinstance(change, dict) or not isinstance(change.get("text"), str):
            raise _HostError("invalid-change", "each content change needs text")
        range_value = change.get("range")
        if not isinstance(range_value, dict):
            result = change["text"]
            continue
        start = _position_to_offset(result, range_value.get("start"))
        end = _position_to_offset(result, range_value.get("end"))
        if end < start:
            raise _HostError("invalid-change", "content change range is reversed")
        result = result[:start] + change["text"] + result[end:]
    return result


def _position_to_offset(text: str, position: object) -> int:
    position = position if isinstance(position, dict) else {}
    target_line = _int(position.get("line"), 0)
    units = _int(position.get("character"), 0)
    lines = text.splitlines(keepends=True)
    if not lines:
        return 0
    if target_line >= len(lines):
        return len(text)
    prefix = sum(len(value) for value in lines[:target_line])
    logical_line = lines[target_line].rstrip("\r\n")
    return prefix + _utf16_to_codepoint(logical_line, units)


def _path_for(document: _Document, payload: dict[str, Any]) -> str:
    value = payload.get("path") or document.path
    if value:
        value = str(value)
        if os.path.isabs(value):
            return os.path.realpath(value)
        root = payload.get("workspaceRoot") or document.workspace_root
        if root:
            return os.path.realpath(os.path.join(str(root), value))
    parsed = urlparse(document.uri)
    if parsed.scheme == "file":
        return os.path.realpath(unquote(parsed.path))
    root = payload.get("workspaceRoot") or document.workspace_root or os.getcwd()
    leaf = unquote(parsed.path).lstrip("/") or "untitled.py"
    return os.path.realpath(os.path.join(str(root), leaf))


def _project(document: _Document, payload: dict[str, Any], path: str) -> jedi.Project:
    root = payload.get("workspaceRoot") or document.workspace_root
    if not root:
        root = os.path.dirname(path)
    root = os.path.realpath(str(root))
    project = _projects.get(root)
    if project is None:
        # The :language process receives only base CPython + Jedi paths. Runtime
        # pack paths must never be added here; that prevents third-party native
        # extensions from being imported merely to answer a completion.
        project = jedi.Project(
            root,
            load_unsafe_extensions=False,
            sys_path=list(sys.path),
            added_sys_path=(root,),
            smart_sys_path=True,
        )
        _projects[root] = project
    return project


def _snapshot(payload: dict[str, Any]) -> _Document:
    uri = _uri(payload)
    document = _documents.get(uri)
    if document is None:
        document = _recover_document(payload)
        if document is None:
            raise _HostError("document-not-open", "document is not open: " + uri)
    requested_epoch = payload.get("epoch")
    requested_version = payload.get("version", payload.get("bufferVersion"))
    if requested_epoch is not None and _int(requested_epoch) != document.epoch:
        raise _HostError("content-modified", "document epoch is no longer current")
    if requested_version is not None and _int(requested_version) != document.version:
        raise _HostError("content-modified", "document version is no longer current")
    # Requests from the JS coordinator include the current full text. Accept it
    # only when the identity gate above matched.
    if "text" in payload and str(payload["text"]) != document.text:
        raise _HostError("content-modified", "request text does not match the open document")
    return document


def _recover_document(payload: dict[str, Any]) -> _Document | None:
    """Rehydrate one buffer after Android restarted only ``:language``.

    Recovery is deliberately stricter than didOpen: URI, full text, epoch and
    version must all be explicit in the same request. This preserves the
    identity gate and never guesses state from a ranged change or disk content.
    """
    text_document = payload.get("textDocument")
    nested = text_document if isinstance(text_document, dict) else {}
    has_text = "text" in payload or "content" in payload or "text" in nested
    has_version = (
        "version" in payload
        or "bufferVersion" in payload
        or "version" in nested
    )
    if not has_text or not has_version or "epoch" not in payload:
        return None
    uri = _uri(payload)
    text = payload.get("text", payload.get("content", nested.get("text")))
    version = _int(
        payload.get("version", payload.get("bufferVersion", nested.get("version"))),
        -1,
    )
    epoch = _int(payload.get("epoch"), -1)
    if version < 0 or epoch < 0:
        return None
    document = _Document(
        uri=uri,
        text=str(text),
        version=version,
        epoch=epoch,
        path=str(payload["path"]) if payload.get("path") else None,
        workspace_root=(
            str(payload["workspaceRoot"])
            if payload.get("workspaceRoot")
            else None
        ),
        language_id=str(payload.get("languageId", nested.get("languageId", "python"))),
    )
    _documents[uri] = document
    return document


def _script(document: _Document, payload: dict[str, Any]) -> jedi.Script:
    path = _path_for(document, payload)
    return jedi.Script(
        code=document.text,
        path=path,
        project=_project(document, payload, path),
        environment=_environment,
    )


def _check_cancelled(request_id: object) -> None:
    if request_id and _native.is_request_cancelled(str(request_id)):
        raise _HostError("cancelled", "language request was cancelled")


def _open(payload: dict[str, Any]) -> dict[str, Any]:
    values = _document_values(payload)
    document = _Document(*values)
    _documents[document.uri] = document
    return {"opened": True}


def _change(payload: dict[str, Any]) -> dict[str, Any]:
    uri = _uri(payload)
    current = _documents.get(uri)
    if current is None:
        current = _recover_document(payload)
        if current is None:
            raise _HostError("document-not-open", "document is not open: " + uri)
        return {"changed": True, "recovered": True}
    text_document = payload.get("textDocument")
    nested_version = text_document.get("version") if isinstance(text_document, dict) else None
    version = _int(
        payload.get("version", payload.get("bufferVersion", nested_version)),
        current.version + 1,
    )
    epoch = _int(payload.get("epoch", current.epoch), current.epoch)
    if epoch != current.epoch:
        raise _HostError("content-modified", "document epoch is no longer current")
    if "text" in payload or "content" in payload:
        text = str(payload.get("text", payload.get("content", "")))
    else:
        changes = payload.get("changes", payload.get("contentChanges", []))
        text = _apply_changes(current.text, changes)
    if version < current.version or (version == current.version and text != current.text):
        raise _HostError("content-modified", "document versions must increase monotonically")
    _documents[uri] = _Document(
        uri, text, version, epoch,
        str(payload.get("path")) if payload.get("path") else current.path,
        str(payload.get("workspaceRoot")) if payload.get("workspaceRoot") else current.workspace_root,
        current.language_id,
    )
    return {"changed": version != current.version or text != current.text}


def _close(payload: dict[str, Any]) -> dict[str, Any]:
    return {"closed": _documents.pop(_uri(payload), None) is not None}


def _completion_item(completion: Any, document: _Document, position: dict[str, Any], token: str) -> dict[str, Any]:
    line, column = _position_to_jedi(document.text, position)
    prefix = max(0, int(completion.get_completion_prefix_length()))
    start_column = max(0, column - prefix)
    item = {
        "label": completion.name,
        "insertText": completion.name,
        "kind": _KIND.get(completion.type, "Text"),
        "detail": completion.description,
        "sortText": completion.name.lower(),
        "filterText": completion.name,
        "textEdit": {
            "range": _range(document.text, (line, start_column), (line, column)),
            "newText": completion.name,
        },
        "data": {"pythonaCompletion": token},
    }
    full_name = completion.full_name
    if full_name:
        item["fullName"] = full_name
    return item


def _complete(payload: dict[str, Any]) -> dict[str, Any]:
    global _completion_sequence
    document = _snapshot(payload)
    request_id = payload.get("requestId")
    _check_cancelled(request_id)
    position = payload.get("position") if isinstance(payload.get("position"), dict) else {"line": 0, "character": 0}
    line, column = _position_to_jedi(document.text, position)
    completions = _script(document, payload).complete(line=line, column=column)
    items = []
    for index, completion in enumerate(completions):
        _check_cancelled(request_id)
        _completion_sequence += 1
        token = f"{_completion_sequence:x}"
        _completion_cache[token] = {
            "uri": document.uri,
            "version": document.version,
            "epoch": document.epoch,
            "position": position,
            "path": payload.get("path"),
            "workspaceRoot": payload.get("workspaceRoot"),
            "name": completion.name,
            "index": index,
        }
        items.append(_completion_item(completion, document, position, token))
    while len(_completion_cache) > 512:
        _completion_cache.popitem(last=False)
    return {"items": items, "isIncomplete": False}


def _resolve(payload: dict[str, Any]) -> dict[str, Any]:
    item = payload.get("item") if isinstance(payload.get("item"), dict) else payload
    data = item.get("data") if isinstance(item, dict) else None
    token = data.get("pythonaCompletion") if isinstance(data, dict) else None
    cached = _completion_cache.get(str(token)) if token is not None else None
    if cached is None:
        return dict(item) if isinstance(item, dict) else {}
    document = _documents.get(cached["uri"])
    if document is None or document.version != cached["version"] or document.epoch != cached["epoch"]:
        raise _HostError("content-modified", "completion belongs to an older document")
    replay = {
        "uri": document.uri,
        "position": cached["position"],
        "path": cached["path"],
        "workspaceRoot": cached["workspaceRoot"],
    }
    line, column = _position_to_jedi(document.text, cached["position"])
    candidates = _script(document, replay).complete(line=line, column=column)
    match = next((value for value in candidates if value.name == cached["name"]), None)
    resolved = dict(item)
    if match is not None:
        documentation = match.docstring(raw=True, fast=False)
        if documentation:
            resolved["documentation"] = {"kind": "markdown", "value": documentation}
        resolved["detail"] = match.description
    return resolved


def _hover(payload: dict[str, Any]) -> dict[str, Any] | None:
    document = _snapshot(payload)
    _check_cancelled(payload.get("requestId"))
    line, column = _position_to_jedi(document.text, payload.get("position"))
    names = _script(document, payload).infer(line=line, column=column)
    if not names:
        names = _script(document, payload).goto(line=line, column=column, follow_imports=True)
    if not names:
        return None
    sections = []
    for name in names[:5]:
        heading = name.description or name.name
        documentation = name.docstring(raw=True)
        sections.append("```python\n" + heading + "\n```" + (("\n\n" + documentation) if documentation else ""))
    return {"contents": {"kind": "markdown", "value": "\n\n---\n\n".join(sections)}}


def _signature(payload: dict[str, Any]) -> dict[str, Any] | None:
    document = _snapshot(payload)
    _check_cancelled(payload.get("requestId"))
    line, column = _position_to_jedi(document.text, payload.get("position"))
    signatures = _script(document, payload).get_signatures(line=line, column=column)
    if not signatures:
        return None
    result = []
    for signature in signatures:
        result.append({
            "label": signature.to_string(),
            "documentation": signature.docstring(raw=True),
            "parameters": [{"label": parameter.to_string()} for parameter in signature.params],
        })
    active = signatures[0].index
    return {
        "signatures": result,
        "activeSignature": 0,
        "activeParameter": 0 if active is None else max(0, int(active)),
    }


def _name_uri(name: Any, fallback: _Document) -> str:
    module_path = name.module_path
    if module_path is None:
        return fallback.uri
    try:
        path = os.path.realpath(str(module_path))
        fallback_path = _path_for(fallback, {})
        if path == fallback_path:
            return fallback.uri
        if fallback.workspace_root:
            root = os.path.realpath(fallback.workspace_root)
            try:
                if os.path.commonpath((root, path)) == root:
                    relative = os.path.relpath(path, root).replace(os.sep, "/")
                    return "pythona://workspace/" + quote(relative, safe="/")
            except ValueError:
                pass
        return Path(path).as_uri()
    except (OSError, ValueError):
        return fallback.uri


def _definition_source(name: Any, uri: str, fallback: _Document) -> str:
    if uri == fallback.uri:
        return fallback.text
    module_path = name.module_path
    if module_path is None:
        return ""
    try:
        path = Path(os.path.realpath(str(module_path)))
        if not path.is_file() or path.stat().st_size > 8 * 1024 * 1024:
            return ""
        return path.read_text(encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        return ""


def _name_start(name: Any) -> tuple[int, int] | None:
    start = name.get_definition_start_position()
    if start is not None:
        return start
    if name.line is None or name.column is None:
        return None
    return int(name.line), int(name.column)


def _definition(payload: dict[str, Any]) -> list[dict[str, Any]]:
    document = _snapshot(payload)
    request_id = payload.get("requestId")
    _check_cancelled(request_id)
    line, column = _position_to_jedi(document.text, payload.get("position"))
    definitions = _script(document, payload).goto(
        line=line,
        column=column,
        follow_imports=True,
        follow_builtin_imports=True,
    )
    output = []
    for definition in definitions:
        _check_cancelled(request_id)
        start = _name_start(definition)
        if start is None:
            continue
        end = (start[0], start[1] + len(definition.name))
        uri = _name_uri(definition, document)
        target_text = _definition_source(definition, uri, document)
        output.append({
            "uri": uri,
            "range": _range(target_text, start, end),
        })
    return output


MAX_REFERENCE_RESULTS = 1000
MAX_RENAME_FILES = 128


@contextmanager
def _workspace_symbol_search(request_id: object):
    """Retain semantic matching for one/two-character workspace identifiers.

    Pinned Jedi 0.20 skips project searches entirely for names of length <= 2.
    That heuristic also excludes ordinary Chinese names such as ``问候``.
    Use Jedi's same bounded file iterator and semantic resolver, bypassing only
    that heuristic. This host has one request worker; restore the hook even on
    cancellation or an invalid refactoring so other Jedi operations are intact.
    """
    original = _jedi_references.get_module_contexts_containing_name

    def search(inference_state, module_contexts, name, limit_reduction=1):
        if len(name) > 2:
            yield from original(inference_state, module_contexts, name, limit_reduction)
            return
        for context in module_contexts:
            _check_cancelled(request_id)
            if not context.is_compiled():
                yield context

        def files():
            for file_io in _jedi_references._find_project_modules(inference_state, module_contexts):
                _check_cancelled(request_id)
                yield file_io

        yield from _jedi_references.search_in_file_ios(
            inference_state, files(), name, limit_reduction=limit_reduction,
        )

    _jedi_references.get_module_contexts_containing_name = search
    try:
        yield
    finally:
        _jedi_references.get_module_contexts_containing_name = original


def _workspace_path(document: _Document, payload: dict[str, Any], path: str) -> bool:
    root_value = payload.get("workspaceRoot") or document.workspace_root
    if not root_value:
        return False
    try:
        root = Path(str(root_value)).resolve()
        candidate = Path(path).resolve()
        return (candidate.is_file() and candidate.is_relative_to(root) and os.access(candidate, os.W_OK)
                and not set(candidate.relative_to(root).parts) & {'.venv', 'venv', 'site-packages', 'node_modules', '.git'})
    except (OSError, ValueError):
        return False


def _read_workspace_source(path: str, fallback: _Document, uri: str) -> str:
    if uri == fallback.uri:
        return fallback.text
    try:
        value = Path(path).read_text(encoding="utf-8", errors="replace")
        return value if len(value.encode("utf-8")) <= 8 * 1024 * 1024 else ""
    except OSError:
        return ""


def _reference_entry(name: Any, fallback: _Document, payload: dict[str, Any]) -> dict[str, Any] | None:
    start = (name.line, name.column) if name.line is not None and name.column is not None else None
    if start is None:
        return None
    module_path = getattr(name, "module_path", None)
    if module_path is None:
        return None
    path = os.path.realpath(str(module_path))
    uri = _name_uri(name, fallback)
    if not _workspace_path(fallback, payload, path):
        return None
    text = _read_workspace_source(path, fallback, uri)
    if not text:
        return None
    end = (start[0], start[1] + len(getattr(name, "name", "")))
    return {"uri": uri, "path": os.path.relpath(path, os.path.realpath(payload.get("workspaceRoot") or fallback.workspace_root)).replace(os.sep, "/"),
            "range": _range(text, start, end), "name": getattr(name, "name", "")}


def _references(payload: dict[str, Any]) -> list[dict[str, Any]]:
    document = _snapshot(payload)
    request_id = payload.get("requestId")
    _check_cancelled(request_id)
    line, column = _position_to_jedi(document.text, payload.get("position"))
    with _workspace_symbol_search(request_id):
        names = _script(document, payload).get_references(line=line, column=column, include_builtins=False)
    output = []
    seen = set()
    for name in names:
        _check_cancelled(request_id)
        item = _reference_entry(name, document, payload)
        if item is None:
            continue
        key = json.dumps(item, sort_keys=True)
        if key not in seen:
            output.append(item)
            seen.add(key)
        if len(output) >= MAX_REFERENCE_RESULTS:
            break
    return output


def _rename(payload: dict[str, Any]) -> dict[str, Any]:
    new_name = payload.get("newName")
    if not isinstance(new_name, str) or not new_name.isidentifier() or keyword.iskeyword(new_name):
        raise _HostError("invalid-rename", "newName must be a valid Python identifier")
    document = _snapshot(payload)
    request_id = payload.get("requestId")
    root = Path(str(payload.get("workspaceRoot") or document.workspace_root)).resolve()
    source_path = Path(_path_for(document, payload))
    if not _workspace_path(document, payload, str(source_path)):
        raise _HostError("invalid-document", "Rename requires a writable workspace file")
    # Cross-file Jedi reads disk. Require saved buffers to avoid combining
    # unsaved source with stale imports in other files.
    if source_path.read_bytes().decode("utf-8") != document.text:
        raise _HostError("content-modified", "Save the document before renaming")
    snapshots = {}
    total = 0
    for current, directories, files in os.walk(root, followlinks=False):
        directories[:] = [n for n in directories if n not in {".git", ".venv", "venv", "node_modules", "__pycache__"}
                          and not (Path(current) / n).is_symlink()]
        for name in files:
            if not name.endswith((".py", ".pyi")):
                continue
            path = (Path(current) / name).resolve()
            if not path.is_relative_to(root):
                continue
            _check_cancelled(request_id)
            data = path.read_bytes()
            total += len(data)
            if len(snapshots) >= 5000 or total > 32 * 1024 * 1024:
                raise _HostError("rename-too-large", "Workspace exceeds rename snapshot limits")
            snapshots[path] = data
    line, column = _position_to_jedi(document.text, payload.get("position"))
    script = _script(document, payload)
    definitions = script.goto(line=line, column=column, follow_imports=True, follow_builtin_imports=True)
    if not definitions or any(name.module_path is None or not _workspace_path(document, payload, str(name.module_path)) for name in definitions):
        raise _HostError("refactor-unsupported", "The symbol is defined outside the writable workspace")
    with _workspace_symbol_search(request_id):
        refactoring = script.rename(line=line, column=column, new_name=new_name)
    if refactoring.get_renames():
        raise _HostError("refactor-unsupported", "Renaming files or modules is not supported")
    changed_files = refactoring.get_changed_files()
    if len(changed_files) > MAX_RENAME_FILES:
        raise _HostError("too-many-references", "Rename affects too many files")
    changes = {}
    for raw_path, changed in changed_files.items():
        _check_cancelled(request_id)
        path = Path(raw_path).resolve()
        if path not in snapshots or not _workspace_path(document, payload, str(path)):
            raise _HostError("refactor-unsupported", "Rename contains a non-writable or external file")
        if path.read_bytes() != snapshots[path]:
            raise _HostError("content-modified", "A file changed during rename analysis")
        before = snapshots[path].decode("utf-8")
        after = changed.get_new_code()
        if before == after:
            continue
        relative = path.relative_to(root).as_posix()
        uri = "pythona://workspace/" + quote(relative, safe="/")
        end = {"line": before.count("\n"), "character": _utf16_length(before.rsplit("\n", 1)[-1])}
        changes[uri] = [{"range": {"start": {"line": 0, "character": 0}, "end": end},
                         "newText": after, "path": relative, "before": before}]
    if not changes:
        raise _HostError("rename-no-edits", "Jedi returned no writable workspace edits")
    return {"newName": new_name, "changes": changes,
            "files": [e for edits in changes.values() for e in edits], "truncated": False}


def _symbols(payload: dict[str, Any]) -> list[dict[str, Any]]:
    document = _snapshot(payload)
    request_id = payload.get("requestId")
    names = _script(document, payload).get_names(
        all_scopes=True,
        definitions=True,
        references=False,
    )
    output = []
    for name in names:
        _check_cancelled(request_id)
        start = _name_start(name)
        if start is None:
            continue
        end = (start[0], start[1] + len(name.name))
        symbol_range = _range(document.text, start, end)
        output.append({
            "name": name.name,
            "kind": _KIND.get(name.type, "Variable"),
            "range": symbol_range,
            "selectionRange": symbol_range,
            "detail": name.description,
        })
    return output


def _diagnose(payload: dict[str, Any]) -> list[dict[str, Any]]:
    document = _snapshot(payload)
    request_id = payload.get("requestId")
    output = []
    for error in _script(document, payload).get_syntax_errors():
        _check_cancelled(request_id)
        output.append({
            "range": _range(
                document.text,
                (error.line, error.column),
                (error.until_line, error.until_column),
            ),
            "severity": 1,
            "source": "Python syntax",
            "code": "syntax-error",
            "message": error.get_message(),
        })
    return output


def _cancel(payload: dict[str, Any]) -> dict[str, Any]:
    request_id = payload.get("requestId") or payload.get("id")
    if request_id:
        _native.cancel_request(str(request_id))
    return {"cancelled": bool(request_id)}


_HANDLERS: dict[str, Callable[[dict[str, Any]], Any]] = {
    "openDocument": _open,
    "changeDocument": _change,
    "closeDocument": _close,
    "complete": _complete,
    "resolveCompletion": _resolve,
    "hover": _hover,
    "signatureHelp": _signature,
    "definition": _definition,
    "references": _references,
    "rename": _rename,
    "documentSymbols": _symbols,
    "diagnose": _diagnose,
    "cancel": _cancel,
}


def _identity(payload: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key in ("requestId", "epoch"):
        if key in payload:
            result[key] = payload[key]
    if "uri" in payload:
        result["uri"] = payload["uri"]
    elif isinstance(payload.get("textDocument"), dict) and payload["textDocument"].get("uri"):
        result["uri"] = payload["textDocument"]["uri"]
    if "version" in payload:
        result["bufferVersion"] = payload["version"]
    elif "bufferVersion" in payload:
        result["bufferVersion"] = payload["bufferVersion"]
    elif isinstance(payload.get("textDocument"), dict) and "version" in payload["textDocument"]:
        result["bufferVersion"] = payload["textDocument"]["version"]
    return result


def dispatch(request_json: str) -> str:
    """Dispatch one request and always return JSON, never Python objects."""
    payload: dict[str, Any] = {}
    try:
        request = json.loads(request_json)
        if not isinstance(request, dict):
            raise _HostError("invalid-request", "request must be a JSON object")
        method = _method_name(request.get("method"))
        raw_payload = request.get("payload", request.get("params", request))
        if not isinstance(raw_payload, dict):
            raise _HostError("invalid-request", "request payload must be an object")
        payload = raw_payload
        if method == "capabilities":
            result: Any = {
                "available": True,
                "engine": "Jedi 0.20.0 / Parso",
                "python": sys.version.split()[0],
                "loadUnsafeExtensions": False,
                "features": {
                    "completion": True,
                    "resolveCompletion": True,
                    "hover": True,
                    "signatureHelp": True,
                    "definition": True,
                    "references": True,
                    "rename": True,
                    "documentSymbols": True,
                    "syntaxDiagnostics": True,
                    "typeChecking": False,
                },
            }
        else:
            handler = _HANDLERS.get(method)
            if handler is None:
                raise _HostError("method-not-found", "unsupported language method: " + method)
            request_id = payload.get("requestId")
            if method != "cancel":
                _check_cancelled(request_id)
            result = handler(payload)
            if method != "cancel":
                _check_cancelled(request_id)
        response = _identity(payload)
        response["result"] = result
        return json.dumps(response, ensure_ascii=False, separators=(",", ":"))
    except _HostError as error:
        response = _identity(payload)
        response.update({"error": str(error), "code": error.code})
        return json.dumps(response, ensure_ascii=False, separators=(",", ":"))
    except Exception as error:
        response = _identity(payload)
        response.update({
            "error": str(error) or type(error).__name__,
            "code": "jedi-host-error",
            "details": "".join(traceback.format_exception_only(type(error), error)).strip(),
        })
        return json.dumps(response, ensure_ascii=False, separators=(",", ":"))
    finally:
        request_id = payload.get("requestId") if isinstance(payload, dict) else None
        if request_id:
            _native.clear_request_cancelled(str(request_id))
