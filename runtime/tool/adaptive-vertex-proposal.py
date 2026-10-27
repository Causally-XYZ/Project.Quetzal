"""开发用单次 ADC JSON 提案调用；stdin 为合成评测请求，stdout 为结果。不是生产模型路由。"""
from __future__ import annotations
import http.client
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location('vertex_smoke', Path(__file__).with_name('adaptive-vertex-smoke.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class CurlFailure(Exception):
    def __init__(self, code: int, status: int | None):
        self.code, self.status = code, status


class RequestCancelled(Exception):
    pass


def read_response(req: urllib.request.Request, transport: str) -> bytes:
    if transport == 'urllib':
        with urllib.request.urlopen(req, timeout=90) as response:
            return response.read(1024 * 1024 + 1)
    # 仅开发对照；凭据和 URL 经 stdin，不能进入命令行、临时文件或错误报告。
    quote = lambda value: json.dumps(value, ensure_ascii=False)
    config = '\n'.join(['url = ' + quote(req.full_url),
                        *['header = ' + quote(k + ': ' + v) for k, v in req.header_items()],
                        'data-binary = ' + quote(req.data.decode())])
    response = subprocess.run(['curl', '--silent', '--show-error', '--http1.1', '--connect-timeout', '15',
                               '--max-time', '90', '--max-filesize', '1048576', '--write-out', '\n%{http_code}', '--config', '-'],
                              input=config, text=True, capture_output=True, timeout=100)
    body, _, code = response.stdout.rpartition('\n')
    status = int(code) if len(code) == 3 and code.isdigit() else None
    if response.returncode or status != 200:
        raise CurlFailure(response.returncode, status)
    return body.encode()


def generate(request: dict) -> dict:
    if not isinstance(request, dict) or set(request) != {'system', 'user', 'model', 'schema', 'config'} or not isinstance(request['schema'], dict) or request['model'] not in smoke.MODELS.values() or any(
            not isinstance(request[k], str) or not request[k] for k in ('system', 'user')):
        return {'ok': False, 'error': 'invalid-request'}
    config = request['config']
    transport = os.environ.get('QUETZAL_VERTEX_TRANSPORT', 'urllib')
    if transport not in ('urllib', 'curl'):
        return {'ok': False, 'error': 'invalid-transport'}
    if not isinstance(config, dict) or set(config) != {'maxOutputTokens', 'responseMimeType', 'thinkingConfig'} or not isinstance(config['maxOutputTokens'], int) or not 1 <= config['maxOutputTokens'] <= 65536 or config['responseMimeType'] != 'application/json' or not isinstance(config['thinkingConfig'], dict) or set(config['thinkingConfig']) != {'thinkingLevel'} or config['thinkingConfig']['thinkingLevel'] not in ('LOW', 'MEDIUM', 'HIGH', 'MINIMAL') or config['thinkingConfig']['thinkingLevel'] == 'MINIMAL' and request['model'] != 'gemini-3.5-flash-lite':
        return {'ok': False, 'error': 'invalid-request'}
    started = time.monotonic()
    result = {'ok': False, 'model': request['model'], 'usage': None, 'config': config, 'transport': transport}
    phase = 'credentials'
    try:
        project, token = smoke.credentials()
        phase = 'request'
        payload = {'systemInstruction': {'parts': [{'text': request['system']}]},
                   'contents': [{'role': 'user', 'parts': [{'text': request['user']}]}],
                   'generationConfig': {**result['config'], 'responseSchema': request['schema']}}
        req = urllib.request.Request(
            f"https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/publishers/google/models/{request['model']}:generateContent",
            data=json.dumps(payload).encode(), method='POST',
            headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json', 'x-goog-user-project': project})
        phase = 'http'
        raw = read_response(req, transport)
        if len(raw) > 1024 * 1024:
            raise ValueError('oversized response')
        data = json.loads(raw)
        candidate = (data.get('candidates') or [{}])[0]
        content = ''.join(p.get('text', '') for p in candidate.get('content', {}).get('parts', []) if not p.get('thought'))
        result.update(modelVersion=data.get('modelVersion'), finishReason=candidate.get('finishReason'), text=content)
        usage = data.get('usageMetadata')
        if usage is not None:
            result['usage'] = {k: usage.get(k) for k in ('promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount')}
        if result['modelVersion'] != request['model'] or result['finishReason'] != 'STOP':
            result['error'] = 'model-or-finish-mismatch'
        else:
            result['proposal'] = json.loads(content)
            result['ok'] = True
    except RequestCancelled:
        result.update(error='cancelled', failure={'phase': phase, 'kind': 'cancelled'})
    except urllib.error.HTTPError as error:
        result.update(error='http', status=error.code)
        error.close()  # 避免 HTTPError 析构警告回显供应商错误正文。
    except CurlFailure as error:
        result.update(error='http' if error.code == 0 else 'transport-or-timeout', status=error.status,
                      failure={'phase': phase, 'kind': 'curl-transfer', 'exitCode': error.code})
    except subprocess.TimeoutExpired:
        result.update(error='credentials-or-process' if phase == 'credentials' else 'transport-or-timeout',
                      failure={'phase': phase, 'kind': 'process-timeout'})
    except (urllib.error.URLError, OSError, http.client.HTTPException) as error:
        detail = smoke.transport_failure(error)
        result.update(error='credentials-or-process' if phase == 'credentials' else 'transport-or-timeout',
                      failure={'phase': 'response' if detail['kind'] == 'incomplete-read' else phase, **detail})
    except (ValueError, TypeError, AttributeError, IndexError, KeyError):
        result['error'] = 'invalid-response'
    except Exception:
        result['error'] = 'credentials-or-process'
    result['latencyMs'] = round((time.monotonic() - started) * 1000)
    return result


if __name__ == '__main__':
    # execFile 的取消须让 subprocess.run 退出清理路径，不能把 curl 留作孤儿请求。
    def interrupted(_signal, _frame):
        raise RequestCancelled()
    signal.signal(signal.SIGTERM, interrupted)
    try:
        raw = sys.stdin.read(256 * 1024 + 1)
        if len(raw.encode()) > 256 * 1024:
            raise ValueError('oversized input')
        result = generate(json.loads(raw))
    except Exception:
        result = {'ok': False, 'error': 'invalid-request'}
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result['ok'] else 1)
