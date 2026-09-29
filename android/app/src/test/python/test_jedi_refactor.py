import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

HOST = Path(__file__).parents[2] / 'main/python/pythona_jedi_host.py'

class JediRefactorContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import jedi
        native=types.ModuleType('_pythona_native')
        native.is_request_cancelled=lambda value: False
        native.clear_request_cancelled=lambda value: None
        sys.modules['_pythona_native']=native
        spec=importlib.util.spec_from_file_location('jedi_refactor_contract',HOST)
        cls.host=importlib.util.module_from_spec(spec);sys.modules[spec.name]=cls.host
        spec.loader.exec_module(cls.host)

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.host._documents.clear();self.host._projects.clear()

    def opened(self, path, text):
        (self.root/path).parent.mkdir(parents=True,exist_ok=True)
        (self.root/path).write_bytes(text.encode('utf-8'))
        p=dict(uri='pythona://workspace/'+path,path=str(self.root/path),workspaceRoot=str(self.root),text=text,epoch=5,bufferVersion=1)
        self.host._open(p)
        return p

    def test_alias_rename_is_semantic_and_does_not_write_disk(self):
        self.opened('package/__init__.py','')
        p=self.opened('package/defs.py','def greet(name):\n    return name\n')
        self.opened('package/use.py','from .defs import greet as hello\nvalue = hello("world")\n')
        self.opened('package/unrelated.py','greet = "unrelated"\n')
        r=self.host._rename({**p,'position':{'line':0,'character':5},'newName':'welcome'})
        self.assertEqual(len(r['files']),2)
        use=next(e for e in r['files'] if e['path'].endswith('use.py'))
        self.assertIn('welcome as hello',use['newText'])
        self.assertIn('hello("world")',use['newText'])
        self.assertEqual((self.root/'package/defs.py').read_text(),p['text'])
        refs=self.host._references({**p,'position':{'line':0,'character':5}})
        definition=next(e for e in refs if e['path'].endswith('defs.py'))
        self.assertEqual(definition['range']['start'],{'line':0,'character':4})

    def test_unicode_identifier_and_no_newline_end_range(self):
        p=self.opened('unicode.py','emoji="🙂"; 名称 = 1\nprint(名称)')
        r=self.host._rename({**p,'position':{'line':1,'character':7},'newName':'新名称'})
        e=r['files'][0]
        self.assertEqual(e['newText'],'emoji="🙂"; 新名称 = 1\nprint(新名称)')
        self.assertEqual(e['range']['end'],{'line':1,'character':9})

    def test_short_unicode_name_finds_cross_file_alias_semantically(self):
        self.opened('qa_fixture/lang/__init__.py','')
        p=self.opened('qa_fixture/lang/defs.py','def 问候(名字):\n    return "你好 " + 名字\n')
        self.opened('qa_fixture/lang/use.py','from .defs import 问候 as hello\nmessage=hello("tablet")\n')
        self.opened('qa_fixture/lang/unrelated.py','问候 = "问候"\nprint(问候)\n')
        query={**p,'position':{'line':0,'character':5}}
        refs=self.host._references(query)
        self.assertEqual({r['path'] for r in refs},{'qa_fixture/lang/defs.py','qa_fixture/lang/use.py'})
        self.assertEqual(len(refs),2)
        r=self.host._rename({**query,'newName':'欢迎'})
        self.assertEqual(len(r['files']),2)
        use=next(f for f in r['files'] if f['path'].endswith('/use.py'))
        self.assertEqual(use['newText'],'from .defs import 欢迎 as hello\nmessage=hello("tablet")\n')
        self.assertEqual((self.root/'qa_fixture/lang/defs.py').read_bytes().decode('utf-8'),p['text'])

    def test_single_character_identifier_keeps_cross_file_semantics(self):
        self.opened('package/__init__.py','')
        p=self.opened('package/defs.py','x = 1\n')
        self.opened('package/use.py','from .defs import x as amount\nprint(amount)\n')
        self.opened('package/unrelated.py','x = 2\n')
        query={**p,'position':{'line':0,'character':0}}
        self.assertEqual({r['path'] for r in self.host._references(query)}, {'package/defs.py','package/use.py'})
        renamed=self.host._rename({**query,'newName':'total'})
        self.assertEqual(len(renamed['files']),2)
        self.assertIn('total as amount', next(f['newText'] for f in renamed['files'] if f['path'].endswith('/use.py')))

    def test_short_symbol_search_restores_jedi_hook_after_failure(self):
        original=self.host._jedi_references.get_module_contexts_containing_name
        with self.assertRaises(RuntimeError):
            with self.host._workspace_symbol_search('request'):
                self.assertIsNot(original,self.host._jedi_references.get_module_contexts_containing_name)
                raise RuntimeError('cancelled')
        self.assertIs(original,self.host._jedi_references.get_module_contexts_containing_name)

    def test_dirty_buffers_and_stale_versions_are_rejected(self):
        p=self.opened('a.py','value = 1\n')
        with self.assertRaises(self.host._HostError): self.host._rename({**p,'bufferVersion':0,'newName':'updated'})
        self.host._change({**p,'bufferVersion':2,'text':'value = 2\n'})
        with self.assertRaises(self.host._HostError): self.host._rename({**p,'bufferVersion':2,'text':'value = 2\n','position':{'line':0,'character':2},'newName':'updated'})

    def test_no_external_builtin_references_or_textual_rename(self):
        p=self.opened('a.py','print("print")\n')
        refs = self.host._references({**p,'position':{'line':0,'character':2}})
        self.assertEqual(len(refs), 1)  # actual local use; string literal is excluded
        self.assertEqual(refs[0]['uri'], 'pythona://workspace/a.py')
        r=json.loads(self.host.dispatch(json.dumps({'method':'rename','payload':{**p,'position':{'line':0,'character':0},'newName':'renamed'}})))
        self.assertIn('error',r)
