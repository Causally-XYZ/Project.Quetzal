"""JSON 提案调用的失败边界；不读 ADC、不联网。"""
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('proposal', Path(__file__).with_name('adaptive-vertex-proposal.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class ProposalTest(unittest.TestCase):
    def request(self):
        return {'model': 'gemini-3.8-flash', 'system': 'synthetic', 'user': 'synthetic', 'schema': {'type': 'OBJECT'}, 'config': {'maxOutputTokens': 16384, 'responseMimeType': 'application/json', 'thinkingConfig': {'thinkingLevel': 'LOW'}}}

    def response(self, **changes):
        data = {'modelVersion': 'gemini-3.8-flash', 'candidates': [{'finishReason': 'STOP', 'content': {'parts': [{'text': '{"contexts":[],"records":[]}'}, {'text': 'hidden thought', 'thought': True}]}}],
                'usageMetadata': {'promptTokenCount': 10, 'candidatesTokenCount': 5, 'thoughtsTokenCount': 3, 'totalTokenCount': 18}}
        data.update(changes)
        return io.BytesIO(json.dumps(data).encode())

    def call(self, response):
        with patch.object(m.smoke, 'credentials', return_value=('synthetic-project', 'TOKEN_SENTINEL')), patch.object(m.urllib.request, 'urlopen', return_value=response):
            return m.generate(self.request())

    def test_json_and_usage(self):
        result = self.call(self.response())
        self.assertTrue(result['ok'])
        self.assertEqual(result['proposal'], {'contexts': [], 'records': []})
        self.assertEqual(result['usage']['totalTokenCount'], 18)
        self.assertNotIn('hidden thought', result['text'])

    def test_wrong_model_or_incomplete(self):
        self.assertFalse(self.call(self.response(modelVersion='another-model'))['ok'])
        result = self.call(self.response(candidates=[{'finishReason': 'MAX_TOKENS', 'content': {'parts': [{'text': '{}'}]}}]))
        self.assertFalse(result['ok']); self.assertNotIn('proposal', result)

    def test_malformed_json(self):
        result = self.call(self.response(candidates=[{'finishReason': 'STOP', 'content': {'parts': [{'text': 'not JSON'}]}}]))
        self.assertEqual(result['error'], 'invalid-response')
        self.assertEqual(result['usage']['totalTokenCount'], 18)

    def test_http_error_does_not_expose_body_or_token(self):
        with patch.object(m.smoke, 'credentials', return_value=('synthetic-project', 'TOKEN_SENTINEL')), patch.object(m.urllib.request, 'urlopen', side_effect=urllib.error.HTTPError('secret-url', 403, 'secret-body', {}, None)):
            result = m.generate(self.request())
        self.assertEqual(result['status'], 403)
        self.assertIsNone(result['usage'])
        self.assertNotIn('secret', json.dumps(result)); self.assertNotIn('TOKEN_SENTINEL', json.dumps(result))

    def test_config_is_forwarded_and_invalid_minimal_rejected(self):
        request = self.request()
        with patch.object(m.smoke, 'credentials', return_value=('synthetic-project', 'TOKEN_SENTINEL')), patch.object(m.urllib.request, 'urlopen', return_value=self.response()) as urlopen:
            result = m.generate(request)
        sent = json.loads(urlopen.call_args.args[0].data)
        self.assertEqual(sent['generationConfig'], {**request['config'], 'responseSchema': request['schema']})
        self.assertEqual(result['config'], request['config'])
        request['config']['thinkingConfig']['thinkingLevel'] = 'MINIMAL'
        with patch.object(m.smoke, 'credentials', side_effect=AssertionError('must not read')):
            self.assertEqual(m.generate(request)['error'], 'invalid-request')

    def test_invalid_request_does_not_read_credentials(self):
        with patch.object(m.smoke, 'credentials', side_effect=AssertionError('must not read')):
            for value in (None, [], {}, {'model': 'unexpected', 'system': 'x', 'user': 'y'}):
                self.assertEqual(m.generate(value)['error'], 'invalid-request')

if __name__ == '__main__':
    unittest.main()
