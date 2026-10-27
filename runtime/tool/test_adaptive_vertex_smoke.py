"""ADC 探针的失败边界；只用合成哨兵，不联网、不读取已有凭据。"""
import http.client
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location("vertex_probe", Path(__file__).with_name("adaptive-vertex-smoke.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class VertexSmokeBoundaries(unittest.TestCase):
    def call(self):
        return probe.probe("synthetic-project", "SECRET-SENTINEL", "quick", probe.MODELS["quick"])

    def test_partial_response_is_failure(self):
        with patch.object(probe.urllib.request, "urlopen", side_effect=http.client.IncompleteRead(b"PRIVATE-PARTIAL")):
            result = self.call()
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "transport-or-timeout")
        self.assertNotIn("PRIVATE", json.dumps(result))

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


if __name__ == "__main__":
    unittest.main()
