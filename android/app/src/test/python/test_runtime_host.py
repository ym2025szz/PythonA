import builtins
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest


HOST = Path(__file__).parents[2] / "main" / "python" / "pythona_runtime_host.py"


class FakeNative(types.ModuleType):
    def __init__(self) -> None:
        super().__init__("_pythona_native")
        self.chunks: list[tuple[str, str]] = []

    def write(self, stream: str, text: str) -> None:
        self.chunks.append((stream, text))

    def read_input(self, prompt: str) -> str:
        return "answer\n"

    def cancelled(self) -> bool:
        return False

    def stdout(self) -> str:
        return "".join(text for stream, text in self.chunks if stream == "stdout")


class RuntimeHostIsolationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.native = FakeNative()
        sys.modules["_pythona_native"] = cls.native
        spec = importlib.util.spec_from_file_location("pythona_runtime_host_test", HOST)
        assert spec and spec.loader
        cls.host = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = cls.host
        spec.loader.exec_module(cls.host)

    def setUp(self) -> None:
        self.native.chunks.clear()

    def run_script(self, root: Path, name: str, options: dict | None = None) -> dict:
        result = self.host.run_file(
            "test-run", str(root), str(root / name), json.dumps(options or []))
        return json.loads(result)

    def test_workspace_imports_are_reloaded_after_source_change(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "model.py").write_text("VALUE = 1\n", encoding="utf-8")
            (root / "main.py").write_text("from model import VALUE\nprint(VALUE)\n", encoding="utf-8")
            self.assertEqual(0, self.run_script(root, "main.py")["exitCode"])
            self.assertIn("1", self.native.stdout())

            self.native.chunks.clear()
            (root / "model.py").write_text("VALUE = 2\n", encoding="utf-8")
            self.assertEqual(0, self.run_script(root, "main.py")["exitCode"])
            self.assertIn("2", self.native.stdout())

    def test_console_hooks_are_restored_for_each_run(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "mutate.py").write_text(
                "import builtins, io, sys\n"
                "sys.stdout = io.StringIO()\n"
                "builtins.input = lambda prompt='': 'wrong'\n",
                encoding="utf-8",
            )
            (root / "next.py").write_text("print(input('prompt:'))\n", encoding="utf-8")
            self.assertEqual(0, self.run_script(root, "mutate.py")["exitCode"])

            self.native.chunks.clear()
            self.assertEqual(0, self.run_script(root, "next.py")["exitCode"])
            self.assertIn("prompt:answer", self.native.stdout())
            self.assertIs(builtins.input, self.host._console_input)

    def test_run_configuration_applies_cwd_env_and_env_file_then_restores_process(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "config.env").write_text("FROM_FILE=loaded\n", encoding="utf-8")
            (root / "sub").mkdir()
            (root / "inspect.py").write_text(
                "import os\n"
                "print(os.getcwd().endswith('sub'))\n"
                "print(os.environ.get('FROM_FILE'))\n"
                "print(os.environ.get('FROM_CONFIG'))\n",
                encoding="utf-8",
            )
            before = dict(self.host.os.environ)
            result = self.run_script(root, "inspect.py", {
                "args": [], "workingDirectory": "sub", "envFiles": ["config.env"],
                "environment": {"FROM_CONFIG": "configured"},
            })
            self.assertEqual(0, result["exitCode"])
            self.assertEqual(before, dict(self.host.os.environ))
            self.assertIn("True", self.native.stdout())
            self.assertIn("loaded", self.native.stdout())
            self.assertIn("configured", self.native.stdout())

    def test_run_configuration_rejects_workspace_escape(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "main.py").write_text("print('never')\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                self.host.run_file(
                    "test-run", str(root), str(root / "main.py"),
                    json.dumps({"workingDirectory": "../outside"}),
                )


if __name__ == "__main__":
    unittest.main()
