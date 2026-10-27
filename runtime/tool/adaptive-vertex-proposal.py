"""开发用单次 ADC JSON 提案调用；stdin 为合成评测请求，stdout 为结果。不是生产模型路由。"""
from __future__ import annotations
import http.client
import importlib.util
import json
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location('vertex_smoke', Path(__file__).with_name('adaptive-vertex-smoke.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


def generate(request: dict) -> dict:
    if not isinstance(request, dict) or set(request) != {'system', 'user', 'model', 'schema', 'config'} or not isinstance(request['schema'], dict) or request['model'] not in smoke.MODELS.values() or any(
            not isinstance(request[k], str) or not request[k] for k in ('system', 'user')):
        return {'ok': False, 'error': 'invalid-request'}
    config = request['config']
    if not isinstance(config, dict) or set(config) != {'maxOutputTokens', 'responseMimeType', 'thinkingConfig'} or not isinstance(config['maxOutputTokens'], int) or not 1 <= config['maxOutputTokens'] <= 65536 or config['responseMimeType'] != 'application/json' or not isinstance(config['thinkingConfig'], dict) or set(config['thinkingConfig']) != {'thinkingLevel'} or config['thinkingConfig']['thinkingLevel'] not in ('LOW', 'MEDIUM', 'HIGH', 'MINIMAL') or config['thinkingConfig']['thinkingLevel'] == 'MINIMAL' and request['model'] != 'gemini-3.5-flash-lite':
        return {'ok': False, 'error': 'invalid-request'}
    started = time.monotonic()
    result = {'ok': False, 'model': request['model'], 'usage': None, 'config': config}
    try:
        project, token = smoke.credentials()
        payload = {'systemInstruction': {'parts': [{'text': request['system']}]},
                   'contents': [{'role': 'user', 'parts': [{'text': request['user']}]}],
                   'generationConfig': {**result['config'], 'responseSchema': request['schema']}}
        req = urllib.request.Request(
            f"https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/publishers/google/models/{request['model']}:generateContent",
            data=json.dumps(payload).encode(), method='POST',
            headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json', 'x-goog-user-project': project})
        with urllib.request.urlopen(req, timeout=90) as response:
            raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError('oversized response')
        data = json.loads(raw)
        candidate = (data.get('candidates') or [{}])[0]
        content = ''.join(p.get('text', '') for p in candidate.get('content', {}).get('parts', []) if not p.get('thought'))
        result.update(modelVersion=data.get('modelVersion'), finishReason=candidate.get('finishReason'), text=content)
        usage = data.get('usageMetadata')
        if usage is not None:
            result['usage'] = {k: usage.get(k, 0) for k in ('promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount')}
        if result['modelVersion'] != request['model'] or result['finishReason'] != 'STOP':
            result['error'] = 'model-or-finish-mismatch'
        else:
            result['proposal'] = json.loads(content)
            result['ok'] = True
    except urllib.error.HTTPError as error:
        result.update(error='http', status=error.code)
        error.close()  # 避免 HTTPError 析构警告回显供应商错误正文。
    except (urllib.error.URLError, OSError, http.client.HTTPException):
        result['error'] = 'transport-or-timeout'
    except (ValueError, TypeError, AttributeError, IndexError, KeyError):
        result['error'] = 'invalid-response'
    except Exception:
        result['error'] = 'credentials-or-process'
    result['latencyMs'] = round((time.monotonic() - started) * 1000)
    return result


if __name__ == '__main__':
    try:
        raw = sys.stdin.read(256 * 1024 + 1)
        if len(raw.encode()) > 256 * 1024:
            raise ValueError('oversized input')
        result = generate(json.loads(raw))
    except Exception:
        result = {'ok': False, 'error': 'invalid-request'}
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result['ok'] else 1)
