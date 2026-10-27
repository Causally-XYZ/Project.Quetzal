"""ADC 探针的失败边界；只用合成哨兵，不联网、不读取已有凭据。"""
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import socket
import ssl
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location("vertex_probe", Path(__file__).with_name("adaptive-vertex-smoke.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
proposal_spec = importlib.util.spec_from_file_location("vertex_proposal", Path(__file__).with_name("adaptive-vertex-proposal.py"))
proposal = importlib.util.module_from_spec(proposal_spec)
proposal_spec.loader.exec_module(proposal)


class VertexSmokeBoundaries(unittest.TestCase):
    def call(self):
        return probe.probe("synthetic-project", "SECRET-SENTINEL", "quick", probe.MODELS["quick"])

    def test_partial_response_is_failure(self):
        with patch.object(probe.urllib.request, "urlopen", side_effect=http.client.IncompleteRead(b"PRIVATE-PARTIAL")):
            result = self.call()
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "transport-or-timeout")
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.assertEqual(result['failure'], {'phase': 'request', 'kind': 'incomplete-read', 'receivedBytes': 15})

    def test_transport_classification_never_echoes_exception_detail(self):
        for error, kind in [(TimeoutError('PRIVATE'), 'timeout'), (ssl.SSLError('PRIVATE'), 'tls'),
                            (socket.gaierror('PRIVATE'), 'dns'), (ConnectionResetError('PRIVATE'), 'connection-reset'),
                            (ConnectionRefusedError('PRIVATE'), 'connection-refused'),
                            (http.client.RemoteDisconnected('PRIVATE'), 'remote-disconnected'),
                            (OSError('PRIVATE'), 'transport-other')]:
            with self.subTest(kind=kind):
                result = probe.transport_failure(urllib.error.URLError(error))
                self.assertEqual(result, {'kind': kind})
                self.assertNotIn('PRIVATE', json.dumps(result))

    def test_timeout_is_failure(self):
        with patch.object(probe.urllib.request, "urlopen", side_effect=TimeoutError("PRIVATE-DETAIL")):
            result = self.call()
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "transport-or-timeout")

    def test_provider_error_is_not_echoed(self):
        error = urllib.error.HTTPError("https://example.invalid", 403, "PRIVATE-DETAIL", {}, io.BytesIO(b"PRIVATE-BODY"))
        with patch.object(probe.urllib.request, "urlopen", side_effect=error):
            result = self.call()
        self.assertEqual(result["status"], 403)
        self.assertFalse(result["ok"])
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.assertNotIn("SECRET", json.dumps(result))

    def test_other_model_ok_is_not_success(self):
        response = {"candidates": [{"content": {"parts": [{"text": "OK"}]}}], "modelVersion": "other-model"}
        with patch.object(probe.urllib.request, "urlopen") as request:
            request.return_value.__enter__.return_value = io.BytesIO(json.dumps(response).encode())
            result = self.call()
        self.assertTrue(result["exactOK"])
        self.assertFalse(result["ok"])

    def test_malformed_response_is_failure(self):
        with patch.object(probe.urllib.request, "urlopen") as request:
            request.return_value.__enter__.return_value = io.BytesIO(b"PRIVATE-NOT-JSON")
            result = self.call()
        self.assertEqual(result["error"], "invalid-response")
        self.assertNotIn("PRIVATE", json.dumps(result))

    def test_credential_override_cannot_mix_with_gcloud(self):
        with patch.dict(probe.os.environ, {"GOOGLE_APPLICATION_CREDENTIALS": "synthetic-other-file"}, clear=True), \
                patch.object(probe.subprocess, "run") as command:
            with self.assertRaises(RuntimeError):
                probe.credentials()
            command.assert_not_called()

    def test_gcloud_error_does_not_echo_credentials(self):
        result = subprocess.CompletedProcess([], 1, "SECRET-TOKEN", "PRIVATE-LOGIN-URL")
        with patch.dict(probe.os.environ, {"GOOGLE_CLOUD_PROJECT": "synthetic-project"}, clear=True), \
                patch.object(probe.subprocess, "run", return_value=result):
            with self.assertRaises(RuntimeError) as failure:
                probe.credentials()
        self.assertNotIn("SECRET", str(failure.exception))
        self.assertNotIn("PRIVATE", str(failure.exception))


class VertexProposalBoundaries(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(proposal.os.environ, {'QUETZAL_VERTEX_TRANSPORT': 'urllib'})
        self.environment.start(); self.addCleanup(self.environment.stop)

    def request(self):
        return {'system': 'synthetic', 'user': 'synthetic', 'model': probe.MODELS['main'], 'schema': {},
                'config': {'maxOutputTokens': 16384, 'responseMimeType': 'application/json', 'thinkingConfig': {'thinkingLevel': 'LOW'}}}

    def test_incomplete_body_has_safe_diagnostics_and_unknown_usage(self):
        with patch.object(proposal.smoke, 'credentials', return_value=('synthetic-project', 'SECRET-SENTINEL')), \
                patch.object(proposal.urllib.request, 'urlopen') as request:
            request.return_value.__enter__.return_value.read.side_effect = http.client.IncompleteRead(b'PRIVATE-PARTIAL', 100)
            result = proposal.generate(self.request())
        self.assertEqual(result['error'], 'transport-or-timeout')
        self.assertEqual(result['failure'], {'phase': 'response', 'kind': 'incomplete-read', 'receivedBytes': 15, 'expectedRemainingBytes': 100})
        self.assertIsNone(result['usage'])
        self.assertNotIn('SECRET', json.dumps(result)); self.assertNotIn('PRIVATE', json.dumps(result))

    def test_credential_os_error_is_not_mislabeled_as_api_transport(self):
        with patch.object(proposal.smoke, 'credentials', side_effect=FileNotFoundError('PRIVATE-PATH')), \
                patch.object(proposal.urllib.request, 'urlopen') as request:
            result = proposal.generate(self.request())
            request.assert_not_called()
        self.assertEqual(result['error'], 'credentials-or-process')
        self.assertEqual(result['failure']['phase'], 'credentials')
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_curl_credentials_only_in_stdin_and_response_uses_same_parser(self):
        data = {'modelVersion': probe.MODELS['main'], 'candidates': [{'finishReason': 'STOP', 'content': {'parts': [{'text': '{"contexts":[],"records":[]}'}]}}],
                'usageMetadata': {'promptTokenCount': 10, 'candidatesTokenCount': 4, 'thoughtsTokenCount': 2, 'totalTokenCount': 16}}
        with patch.dict(proposal.os.environ, {'QUETZAL_VERTEX_TRANSPORT': 'curl'}), \
                patch.object(proposal.smoke, 'credentials', return_value=('synthetic-project', 'SECRET-SENTINEL')), \
                patch.object(proposal.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, json.dumps(data)+'\n200', 'PRIVATE-ERROR')) as run:
            result = proposal.generate(self.request())
        self.assertTrue(result['ok']); self.assertEqual(result['transport'], 'curl')
        self.assertEqual(result['usage']['totalTokenCount'], 16)
        self.assertIn('SECRET-SENTINEL', run.call_args.kwargs['input'])
        self.assertNotIn('SECRET', str(run.call_args.args)); self.assertNotIn('synthetic-project', str(run.call_args.args))
        self.assertNotIn('PRIVATE', json.dumps(result)); self.assertNotIn('SECRET', json.dumps(result))

    def test_curl_partial_body_and_http_failure_never_parse_as_success(self):
        for code, status, expected in [(18, 200, 'transport-or-timeout'), (0, 403, 'http')]:
            with patch.dict(proposal.os.environ, {'QUETZAL_VERTEX_TRANSPORT': 'curl'}), \
                    patch.object(proposal.smoke, 'credentials', return_value=('synthetic-project', 'SECRET-SENTINEL')), \
                    patch.object(proposal.subprocess, 'run', return_value=subprocess.CompletedProcess([], code, 'PRIVATE-BODY\n'+str(status), 'PRIVATE-ERROR')):
                result = proposal.generate(self.request())
            self.assertFalse(result['ok']); self.assertIsNone(result['usage']); self.assertEqual(result['error'], expected)
            self.assertNotIn('PRIVATE', json.dumps(result)); self.assertNotIn('SECRET', json.dumps(result))

    def test_missing_thought_usage_is_unknown_not_zero(self):
        data = {'modelVersion': probe.MODELS['main'], 'candidates': [{'finishReason': 'STOP', 'content': {'parts': [{'text': '{}'}]}}],
                'usageMetadata': {'promptTokenCount': 10, 'candidatesTokenCount': 4, 'totalTokenCount': 14}}
        with patch.object(proposal.smoke, 'credentials', return_value=('synthetic-project', 'SECRET-SENTINEL')), \
                patch.object(proposal.urllib.request, 'urlopen') as request:
            request.return_value.__enter__.return_value = io.BytesIO(json.dumps(data).encode())
            result = proposal.generate(self.request())
        self.assertTrue(result['ok']); self.assertIsNone(result['usage']['thoughtsTokenCount'])
        self.assertEqual(result['usage']['totalTokenCount'], 14)

    def test_unknown_transport_is_rejected_before_credentials(self):
        with patch.dict(proposal.os.environ, {'QUETZAL_VERTEX_TRANSPORT': 'unknown'}), patch.object(proposal.smoke, 'credentials') as credentials:
            result = proposal.generate(self.request()); credentials.assert_not_called()
        self.assertEqual(result['error'], 'invalid-transport')

    @unittest.skipUnless(os.name == 'posix', 'POSIX 子进程取消边界')
    def test_cancelled_runner_does_not_leave_curl_child(self):
        with tempfile.TemporaryDirectory(prefix='quetzal-curl-cancel-') as directory:
            root = Path(directory); pid_file = root/'child.pid'
            fake_curl = root/'curl'
            fake_curl.write_text(f'#!{sys.executable}\nimport os,time\nfrom pathlib import Path\nPath({str(pid_file)!r}).write_text(str(os.getpid()))\ntime.sleep(30)\n')
            fake_curl.chmod(0o700)
            fake_gcloud = root/'gcloud'
            fake_gcloud.write_text(f'#!{sys.executable}\nprint("SYNTHETIC-TEST-TOKEN")\n'); fake_gcloud.chmod(0o700)
            env = {**os.environ, 'QUETZAL_VERTEX_TRANSPORT': 'curl', 'GOOGLE_CLOUD_PROJECT': 'synthetic-project',
                   'GCLOUD_BIN': str(fake_gcloud), 'PATH': str(root)+os.pathsep+os.environ.get('PATH', '')}
            env.pop('GOOGLE_APPLICATION_CREDENTIALS', None)
            child_pid = None
            process = subprocess.Popen([sys.executable, '-B', str(Path(__file__).with_name('adaptive-vertex-proposal.py'))],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
            try:
                process.stdin.write(json.dumps(self.request())); process.stdin.close(); process.stdin = None
                deadline = time.monotonic()+5
                while not pid_file.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(pid_file.exists(), '模拟 curl 必须确已启动')
                child_pid = int(pid_file.read_text()); process.send_signal(signal.SIGTERM)
                stdout, stderr = process.communicate(timeout=4)
                self.assertNotEqual(process.returncode, 0)
                self.assertNotIn('SYNTHETIC-TEST-TOKEN', stdout+stderr)
                with self.assertRaises(ProcessLookupError): os.kill(child_pid, 0)
                child_pid = None
            finally:
                if process.poll() is None: process.kill(); process.communicate(timeout=4)
                if child_pid:
                    try: os.kill(child_pid, signal.SIGKILL)
                    except ProcessLookupError: pass


if __name__ == "__main__":
    unittest.main()
