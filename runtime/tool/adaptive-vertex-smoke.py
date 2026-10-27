"""通过部署者已有的 ADC 验证指定测试模型；不保存凭据、不修改 Quetzal 配置。

GCLOUD_BIN 可指定已有 gcloud 可执行文件；GOOGLE_CLOUD_PROJECT 可指定项目。
未设置项目时仅使用 ADC 的 quota_project_id，不搜索其他账号或尝试重新登录。
这只是连通性检查，不代表记忆语义评测。会产生三次真实模型调用费用。
"""
from __future__ import annotations

import concurrent.futures
import http.client
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

MODELS = {
    "strong": "gemini-4-argon",
    "main": "gemini-3.8-flash",
    "quick": "gemini-3.5-flash-lite",
}


def credentials() -> tuple[str, str]:
    # 此开发探针使用 gcloud 管理的 ADC，不把其他文件的项目与 gcloud 令牌混用。
    if os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        raise RuntimeError("此探针仅使用 gcloud 管理的 ADC，不支持凭据文件覆盖")
    project = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
    if not project:
        adc = Path(os.environ.get("CLOUDSDK_CONFIG", str(Path.home() / ".config/gcloud"))) / "application_default_credentials.json"
        try:
            project = json.loads(adc.read_text()).get("quota_project_id", "")
        except (OSError, ValueError):
            pass
    # 不允许项目字段注入 URL 路径、查询或请求头；不把真实值写入报告。
    if not isinstance(project, str) or not project or any(
            c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in project):
        raise RuntimeError("请配置 GOOGLE_CLOUD_PROJECT 或已有 ADC 的 quota_project_id")
    result = subprocess.run(
        [os.environ.get("GCLOUD_BIN", "gcloud"), "auth", "application-default", "print-access-token", "--quiet"],
        capture_output=True, text=True, timeout=45, check=False,
    )
    if result.returncode or not result.stdout.strip():
        # gcloud 的 stderr 可能含账号或登录地址，不能复制进评测报告。
        raise RuntimeError("已有 ADC 无法取得访问令牌，请在本机检查其有效性")
    return project, result.stdout.strip()


def probe(project: str, token: str, tier: str, model: str) -> dict:
    start = time.monotonic()
    payload = {"contents": [{"role": "user", "parts": [{"text": "Reply with exactly OK."}]}],
               "generationConfig": {"maxOutputTokens": 512}}
    request = urllib.request.Request(
        f"https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/publishers/google/models/{model}:generateContent",
        data=json.dumps(payload).encode(), method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                 "x-goog-user-project": project},
    )
    result = {"tier": tier, "model": model, "ok": False}
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            data = json.load(response)
        candidate = (data.get("candidates") or [{}])[0]
        text = "".join(p.get("text", "") for p in candidate.get("content", {}).get("parts", [])
                       if not p.get("thought"))
        result.update(ok=text.strip() == "OK" and data.get("modelVersion") == model,
                      modelVersion=data.get("modelVersion"), finishReason=candidate.get("finishReason"),
                      exactOK=text.strip() == "OK")
        # 单独记录思考 token；不能把仅可见输出 token 误当全部用量或费用。
        usage = data.get("usageMetadata", {})
        result["usage"] = {k: usage.get(k, 0) for k in (
            "promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount", "totalTokenCount")}
    except urllib.error.HTTPError as error:
        result.update(error="http", status=error.code)
    except (urllib.error.URLError, OSError, http.client.HTTPException):
        result.update(error="transport-or-timeout")
    except (ValueError, TypeError, AttributeError, IndexError):
        result.update(error="invalid-response")
    result["latencyMs"] = round((time.monotonic() - start) * 1000)
    return result


if __name__ == "__main__":
    try:
        project, token = credentials()
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        # 不回显外部异常中的路径、输出或凭据。
        print(json.dumps({"ok": False, "error": "adc-unavailable", "kind": type(error).__name__}))
        raise SystemExit(1)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(probe, project, token, tier, model) for tier, model in MODELS.items()]
        results = [future.result() for future in futures]
    print(json.dumps({"schema": "quetzal-vertex-smoke-v1", "region": "global", "results": results}, indent=2))
    raise SystemExit(0 if all(x["ok"] for x in results) else 1)
