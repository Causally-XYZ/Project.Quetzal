"""显式 ADC 嵌入对照；仅公开夹具，最多75次调用，无重试、无生产配置变化。"""
import concurrent.futures
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent
MODEL = 'gemini-embedding-001'
DIMENSIONS = 768


def run(work):
    work = Path(work).resolve()
    if work.is_relative_to(HERE.parents[2]):
        raise ValueError('结果必须在仓库外')
    raw = (HERE / 'cases.json').read_bytes()
    cases = json.loads(raw)
    spec = importlib.util.spec_from_file_location('vertex_smoke', HERE.parent / 'adaptive-vertex-smoke.py')
    auth = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(auth)
    transport = os.environ.get('QUETZAL_VERTEX_TRANSPORT', 'urllib')
    if transport not in ('urllib', 'curl'):
        raise ValueError('未知传输')
    transport_spec = importlib.util.spec_from_file_location('vertex_proposal', HERE.parent / 'adaptive-vertex-proposal.py')
    transfer = importlib.util.module_from_spec(transport_spec)
    transport_spec.loader.exec_module(transfer)
    project, token = auth.credentials()
    endpoint = f'https://us-central1-aiplatform.googleapis.com/v1/projects/{project}/locations/us-central1/publishers/google/models/{MODEL}:predict'
    calls = []
    report = {'version': 1, 'kind': 'vertex-embedding-development', 'model': MODEL,
              'modelVersion': None, 'transport': transport, 'requestTimeoutSeconds': 90 if transport == 'curl' else 30,
              'transportScriptHash': hashlib.sha256((HERE.parent / 'adaptive-vertex-proposal.py').read_bytes()).hexdigest(), 'region': 'us-central1', 'dimensions': DIMENSIONS,
              'casesHash': hashlib.sha256(raw).hexdigest(), 'scriptHash': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'calls': calls, 'documents': [], 'queries': [], 'status': 'incomplete'}
    target = work / f'vertex-{time.time_ns()}.json'
    work.mkdir(parents=True, exist_ok=True)

    def embed(task):
        kind, identity, repeat, text = task
        start = time.monotonic()
        result = {'kind': kind, 'id': identity, 'repeat': repeat, 'ok': False,
                  'tokenCount': None, 'billableCharacterCount': None, 'truncated': None}
        payload = {'instances': [{'content': text, 'task_type': 'RETRIEVAL_DOCUMENT' if kind == 'document' else 'RETRIEVAL_QUERY'}],
                   'parameters': {'autoTruncate': False, 'outputDimensionality': DIMENSIONS}}
        req = urllib.request.Request(endpoint, data=json.dumps(payload).encode(), method='POST',
            headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json', 'x-goog-user-project': project})
        try:
            if transport == 'curl':
                body = transfer.read_response(req, 'curl')
            else:
                with urllib.request.urlopen(req, timeout=30) as response:
                    body = response.read(1024 * 1024 + 1)
            if len(body) > 1024 * 1024:
                raise ValueError('response-size')
            data = json.loads(body)
            if len(data['predictions']) != 1:
                raise ValueError('prediction-count')
            embedding = data['predictions'][0]['embeddings']
            values = embedding['values']
            stats = embedding.get('statistics', {})
            result['truncated'] = stats.get('truncated')
            result['tokenCount'] = stats.get('token_count')
            result['billableCharacterCount'] = data.get('metadata', {}).get('billableCharacterCount')
            if len(values) != DIMENSIONS or not all(type(v) in (float, int) and math.isfinite(v) for v in values) or result['truncated'] is not False:
                raise ValueError('embedding-shape')
            norm = math.sqrt(sum(v * v for v in values))
            if not math.isfinite(norm) or norm <= 0:
                raise ValueError('embedding-norm')
            result.update(ok=True, rawNorm=norm, vector=[v / norm for v in values])
        except transfer.CurlFailure as error:
            result.update(error='curl-transfer', status=error.status, exitCode=error.code)
        except urllib.error.HTTPError as error:
            result.update(error='http', status=error.code)
            error.close()
        except (ValueError, TypeError, KeyError, IndexError, AttributeError):
            result.update(error='invalid-response')
        except Exception as error:
            result.update(error='transport', failure=auth.transport_failure(error))
        result['latencyMs'] = round((time.monotonic() - start) * 1000)
        return result

    def record(result):
        vector = result.pop('vector', None)
        calls.append(result)
        if result['ok']:
            report['documents' if result['kind'] == 'document' else 'queries'].append({
                'id': result['id'], 'repeat': result['repeat'], 'vector': vector})
        # 单线程写入已结束调用；完整证据随进度保留，不包含 URL / 凭据 / 供应商错误正文。
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({k: result[k] for k in ['kind', 'id', 'repeat', 'ok', 'latencyMs']}), flush=True)

    documents = [('document', identity, 0, f'{title}\n{text}') for identity, title, text in cases['documents']]
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=4)
    futures = [pool.submit(embed, item) for item in documents]
    failed = False
    try:
        for future in concurrent.futures.as_completed(futures):
            if future.cancelled():
                continue
            result = future.result()
            record(result)
            if not result['ok']:
                failed = True
                for pending in futures:
                    pending.cancel()
    finally:
        pool.shutdown(wait=True, cancel_futures=True)
    if not failed:
        for repeat in range(3):
            for q in cases['queries']:
                result = embed(('query', q['id'], repeat, q['query']))
                record(result)
                if not result['ok']:
                    failed = True
                    break
            if failed:
                break
    report['status'] = 'failed' if failed else 'completed'
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'report': str(target), 'status': report['status'], 'calls': len(calls)}), flush=True)
    return not failed


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[2] != '--live':
        raise SystemExit('用法：python3 -B vertex.py <仓库外目录> --live（产生真实调用费用）')
    try:
        ok = run(sys.argv[1])
    except Exception as error:
        print(json.dumps({'status': 'failed', 'stage': 'setup-or-report', 'kind': type(error).__name__}))
        ok = False
    raise SystemExit(0 if ok else 1)
