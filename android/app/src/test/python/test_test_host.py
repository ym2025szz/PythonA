import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


HOST = Path(__file__).parents[2] / "main" / "python" / "pythona_test_host.py"


class FakeNative(types.ModuleType):
    def __init__(self):
        super().__init__("_pythona_native")
        self.cancelled_ids = set()
        self.chunks = []

    def cancelled(self):
        return False

    def write(self, stream, text):
        self.chunks.append((stream, text))

    def is_request_cancelled(self, value):
        return value in self.cancelled_ids

    def cancel_request(self, value):
        self.cancelled_ids.add(value)

    def clear_request_cancelled(self, value):
        self.cancelled_ids.discard(value)


class TestHostContract(unittest.TestCase):
    def setUp(self):
        self.native.chunks.clear()
        self.native.cancelled_ids.clear()

    def execute(self, root, **kwargs):
        return self.host.run({"workspaceRoot": str(root), "runId": "contract", **kwargs})
    @classmethod
    def setUpClass(cls):
        cls.native = FakeNative()
        sys.modules["_pythona_native"] = cls.native
        spec = importlib.util.spec_from_file_location("pythona_test_host_contract", HOST)
        assert spec and spec.loader
        cls.host = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = cls.host
        spec.loader.exec_module(cls.host)

    def test_pytest_result_and_discovery_are_structured(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "tests").mkdir()
            (root / "tests/test_result.py").write_text(
                "def test_ok():\n    assert True\n"
                "def test_failure():\n    assert False\n",
                encoding="utf-8",
            )
            discovered = self.host.discover({"workspaceRoot": str(root)})
            self.assertEqual(discovered["files"][0]["path"], "tests/test_result.py")
            result = self.host.run({"workspaceRoot": str(root), "runId": "pytest-run"})
            self.assertEqual(result["framework"], "pytest")
            self.assertEqual(result["counts"]["collected"], 2)
            self.assertEqual(result["counts"]["failed"], 1)
            self.assertTrue(any(case["outcome"] == "failed" for case in result["cases"]))

    def test_unittest_fallback_keeps_skip_and_restores_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "test_case.py").write_text(
                "import os, unittest\n"
                "class Case(unittest.TestCase):\n"
                "    def test_ok(self): self.assertEqual(os.environ['PYTHONA_TEST'], 'yes')\n"
                "    @unittest.skip('later')\n"
                "    def test_skip(self): pass\n",
                encoding="utf-8",
            )
            before = dict(self.host.os.environ)
            result = self.host.run({
                "workspaceRoot": str(root), "runId": "unittest-run",
                "framework": "unittest", "environment": {"PYTHONA_TEST": "yes"},
            })
            self.assertEqual(result["framework"], "unittest")
            self.assertEqual(result["counts"]["skipped"], 1)
            self.assertEqual(before, dict(self.host.os.environ))

    def test_paths_cannot_escape_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(self.host.TestHostError) as error:
                self.host.discover({"workspaceRoot": str(root), "path": "../outside"})
            self.assertEqual(error.exception.code, "path-outside-workspace")

    def test_cancelled_task_reports_cancelled(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "test_cancel.py").write_text("def test_ok():\n    assert True\n", encoding="utf-8")
            self.native.cancel_request("cancel-run")
            result = self.host.run({"workspaceRoot": str(root), "runId": "cancel-run"})
            self.assertEqual(result["status"], "cancelled")

    def test_failure_after_display_limit_remains_failed_with_complete_counts(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'test_many.py').write_text('import pytest\n@pytest.mark.parametrize("n", range(510))\ndef test_many(n):\n    assert n < 509\n')
            result = self.execute(root)
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['counts'], dict(collected=510, passed=509, failed=1, skipped=0, errors=0))
            self.assertTrue(result['truncated'])
            self.assertLessEqual(len(result['cases']), 500)
            self.assertEqual(result['cases'][0]['outcome'], 'failed')

    def test_class_parameter_node_ids_roundtrip_and_failure_points_to_assert(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'test_cases.py').write_text('import pytest\nclass TestCases:\n    @pytest.mark.parametrize("x", [1, 2])\n    def test_item(self, x):\n        assert x == 1\n')
            result = self.execute(root)
            failure = next(c for c in result['cases'] if c['outcome'] == 'failed')
            self.assertEqual(failure['nodeId'], 'test_cases.py::TestCases::test_item[2]')
            self.assertEqual(failure['line'], 5)
            single = self.execute(root, path='test_cases.py', nodeId=failure['nodeId'])
            self.assertEqual(single['counts']['collected'], 1)
            self.assertEqual(single['counts']['failed'], 1)

    def test_stream_is_forwarded_before_completion_and_retained_output_is_bounded(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'test_stream.py').write_text('def test_output():\n    print("stream-before-end", flush=True)\n')
            self.execute(root)
            self.assertTrue(any('stream-before-end' in text for _, text in self.native.chunks))
        capture = self.host._LiveCapture('stdout')
        capture.write('x' * (self.host.MAX_TRACEBACK_CHARS * 3))
        self.assertTrue(capture.truncated)
        self.assertLess(len(capture.getvalue()), self.host.MAX_TRACEBACK_CHARS + 100)

    def test_duplicate_test_names_in_different_files_keep_their_paths(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for name in ('a', 'b'):
                (root / name).mkdir()
                (root / name / 'test_shared.py').write_text('def test_same():\n    assert True\n')
            result = self.execute(root)
            # Importlib mode avoids pytest's same-basename import mismatch.
            self.assertEqual({c['path'] for c in result['cases']}, {'a/test_shared.py', 'b/test_shared.py'})

    def test_invalid_node_paths_and_shell_args_are_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'test_case.py').write_text('def test_ok(): pass\n')
            for options in ({'args': 'pytest tests'}, {'args': ['../escape']}, {'nodeId': '../outside.py::test_x'}, {'args': ['--basetemp=../outside']}):
                with self.assertRaises(self.host.TestHostError): self.execute(root, **options)

    def test_missing_pytest_uses_unittest_and_capabilities_are_honest(self):
        original = self.host.importlib.import_module
        def importing(name, *a, **kw):
            if name == 'pytest': raise ImportError('missing pytest')
            return original(name, *a, **kw)
        with patch.object(self.host.importlib, 'import_module', side_effect=importing):
            self.assertEqual(self.host.capabilities()['framework'], 'unittest')
            self.assertFalse(self.host.capabilities()['pytest'])

    def test_junit_properties_are_not_mistaken_for_failure_and_skip_location_is_known(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            (root/'test_skip.py').write_text('import pytest\n@pytest.mark.skip(reason="later")\ndef test_skip(): pass\n')
            result=self.execute(root)
            self.assertEqual(result['counts']['skipped'],1)
            self.assertGreater(result['cases'][0]['line'],0)

    def test_unittest_failure_line_and_nodeid_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            (root/'test_case.py').write_text('import unittest\nclass Case(unittest.TestCase):\n    def test_bad(self):\n        self.fail("expected")\n    def test_good(self): pass\n')
            result=self.execute(root,framework='unittest')
            failure=next(c for c in result['cases'] if c['outcome']=='failed')
            self.assertEqual(failure['line'],4)
            single=self.execute(root,framework='unittest',nodeId=failure['nodeId'])
            self.assertEqual(single['counts']['collected'],1)

    def test_unittest_skip_wrapper_keeps_workspace_identity(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            (root/'test_skip.py').write_text('import unittest\nclass Case(unittest.TestCase):\n    @unittest.skip("later")\n    def test_skip(self): pass\n')
            c=self.execute(root,framework='unittest')['cases'][0]
            self.assertEqual(c['path'],'test_skip.py')
            self.assertEqual(c['nodeId'],'test_skip.py::Case::test_skip')

    def test_interrupted_junit_placeholder_is_not_a_pass(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);report=root/'report.xml'
            report.write_text('<testsuite><testcase time="0" /></testsuite>')
            self.assertEqual(self.host._parse_junit(report,root),[])

    def test_error_envelope_is_not_a_successful_result(self):
        response=json.loads(self.host.dispatch(json.dumps({'method':'discover','payload':{}})))
        self.assertEqual(response['code'],'invalid-workspace')
        self.assertNotIn('result',response)

    def test_nested_namespace_modules_are_evicted_without_removing_parents_early(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            (root/'package'/'nested').mkdir(parents=True)
            (root/'package'/'nested'/'test_case.py').write_text('def test_ok(): pass\n')
            for _ in range(2):
                result=self.execute(root)
                self.assertEqual(result['status'],'passed',result)
                self.assertNotIn('package.nested.test_case',sys.modules)


if __name__ == "__main__":
    unittest.main()
