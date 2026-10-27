"""仅下载固定公开模型到仓库外；摘要不符拒绝使用，不接触任何用户资料。"""
import hashlib
import json
import os
from pathlib import Path
import sys
import subprocess

HERE = Path(__file__).resolve().parent
PIN = json.loads((HERE.parent.parent / 'components/adaptive-retrieval/model.json').read_text())


def check(path, entry):
    if not path.is_file() or path.stat().st_size != entry['size']:
        return False
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest() if 'sha256' in entry else hashlib.sha1(
        b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
    return digest == entry.get('sha256', entry.get('git'))


def prepare(work):
    work = Path(work).resolve()
    if work.is_relative_to(HERE.parents[2]):
        raise ValueError('模型与运行结果必须放在仓库外')
    target = work / 'model'
    target.mkdir(parents=True, exist_ok=True)
    for entry in PIN['files']:
        path = target / entry['path']
        if check(path, entry):
            print('已核对', entry['path'], flush=True)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        part = path.with_suffix(path.suffix + '.part')
        if part.exists() and part.stat().st_size >= entry['size'] and not check(part, entry):
            part.unlink()
        if not check(part, entry):
            url = f"https://huggingface.co/{PIN['id']}/resolve/{PIN['revision']}/{entry['path']}"
            result = subprocess.run(['curl', '-q', '--fail', '--location', '--silent',
                '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '15',
                '--speed-limit', '1', '--speed-time', '60', '--max-time', '600',
                '--max-filesize', str(entry['size']), '--continue-at', '-', '--output', str(part), url],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if result.returncode:
                raise RuntimeError(f"下载失败：{entry['path']}，curl={result.returncode}；部分文件保留供续传")
        if not check(part, entry):
            part.unlink(missing_ok=True)
            raise ValueError('模型文件不完整或摘要不符，已清除部分文件')
        os.replace(part, path)
        print('已下载并核对', entry['path'], flush=True)


if __name__ == '__main__':
    prepare(sys.argv[1])
