import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from urllib.parse import quote
from urllib.request import urlopen

RELEASES_URL = "https://github.com/PureDimension/sagitta-agent/releases"
PROFILE = "web"


def run(
    args,
    capture=False,
    env=None,
):
    executable = shutil.which(args[0])
    if executable is None:
        raise FileNotFoundError(f"找不到 {args[0]}，请先安装并加入 PATH。")
    result = subprocess.run(
        [executable, *args[1:]], check=True, text=True, env=env,
        stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout


def download(
    url,
):
    # urllib 使用系统证书校验及标准代理配置；脚本可脱离源码仓库运行。
    with urlopen(url, timeout=120) as response:
        return response.read()


def write_launcher(
    directory,
):
    if os.name == "nt":
        launcher = directory / "sagitta.cmd"
        source = '''@echo off
setlocal
set "base=%~dp0"
set "DSH_HOME=%base%home"
set "DSH_AGENTS_HOME=%base%agents"
set "PATH=%base%runtime\\node_modules\\.bin;%PATH%"
call "%base%runtime\\node_modules\\.bin\\dsh.cmd" web %*
exit /b %errorlevel%
'''
    else:
        launcher = directory / "sagitta.sh"
        source = '''#!/bin/sh
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
export DSH_HOME="$base/home"
export DSH_AGENTS_HOME="$base/agents"
export PATH="$base/runtime/node_modules/.bin:$PATH"
exec "$base/runtime/node_modules/.bin/dsh" web "$@"
'''
    launcher.write_text(source, encoding="utf-8")
    launcher.chmod(0o755)
    return launcher


def main():
    parser = argparse.ArgumentParser(description="在独立目录安装 Sagitta、指定版本 DSH 和 Updater。")
    parser.add_argument("--directory", required=True, type=Path, help="首次安装使用空目录；再次指定同一目录升级")
    directory = parser.parse_args().directory.expanduser().resolve()
    runtime = directory / "runtime"
    manifest_path = runtime / "package.json"
    if directory.exists() and any(directory.iterdir()):
        if not manifest_path.is_file() or json.loads(manifest_path.read_text())["name"] != "sagitta-environment":
            raise RuntimeError("目标目录非空且不是 Sagitta 安装目录，请选择空目录。")
    for command in ["node", "npm", "pnpm"]:
        print(f"{command}：{run([command, '--version'], capture=True).strip()}", flush=True)

    print("检查 Sagitta 最新正式 Release", flush=True)
    release = json.loads(download(f"{RELEASES_URL}/latest/download/release.json"))
    tag = release["tag"]
    asset = release["packages"]["updater"]
    if (release.get("dirty") is not False or not re.fullmatch(r"v[^/\\]+", tag)
            or not re.fullmatch(r"sagitta-updater-[\w.+-]+\.tgz", asset["file"])
            or not re.fullmatch(r"[a-f0-9]{64}", asset["sha256"])):
        raise RuntimeError("Release 清单不符合正式发布格式。")
    required = release["dsh"]
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[\w.-]+)?", required):
        raise RuntimeError("Release 必须指定一个精确的 DSH 版本。")

    print(f"下载 {tag} 的 Updater 预编译包", flush=True)
    archive = download(f"{RELEASES_URL}/download/{quote(tag, safe='')}/{asset['file']}")
    if hashlib.sha256(archive).hexdigest() != asset["sha256"]:
        raise RuntimeError("Updater 包 SHA-256 不匹配，已停止安装。")

    runtime.mkdir(parents=True, exist_ok=True)
    if not manifest_path.exists():
        manifest_path.write_text(json.dumps({"name": "sagitta-environment", "private": True}) + "\n", encoding="utf-8")
    print(f"局部安装 DSH {required}：{runtime}；由 npm 校验 Node.js 引擎要求", flush=True)
    run(["npm", "install", "--prefix", str(runtime), "--save-exact", "--engine-strict",
         "--no-audit", "--no-fund", f"@deepseek-ai/dsh@{required}"])
    dsh = ["node", str(runtime / "node_modules/@deepseek-ai/dsh/lib/bin.js")]
    installed = run([*dsh, "--version"], capture=True).strip()
    if installed != required:
        raise RuntimeError(f"局部 DSH 版本不匹配：要求 {required}，实际 {installed}。")

    # 子进程只使用本目录的数据和插件；本地 tgz 路径会被 pnpm 保存，必须持久保留。
    environment = dict(os.environ, DSH_HOME=str(directory / "home"), DSH_AGENTS_HOME=str(directory / "agents"))
    environment["PATH"] = str(runtime / "node_modules/.bin") + os.pathsep + os.environ.get("PATH", "")
    (directory / "agents").mkdir(exist_ok=True)
    cache = directory / "home/profiles" / PROFILE / "sagitta-releases" / tag
    cache.mkdir(parents=True, exist_ok=True)
    filename = cache / asset["file"]
    with TemporaryDirectory(dir=cache) as temporary:
        pending = Path(temporary) / asset["file"]
        pending.write_bytes(archive)
        pending.replace(filename)

    print(f"校验通过，通过 DSH 安装到 {PROFILE} profile；包缓存：{filename}", flush=True)
    run([*dsh, "plugin", "--profile", PROFILE, "add", str(filename),
         "--save-exact", "--ignore-scripts", "--config.auto-install-peers=false"], env=environment)
    launcher = write_launcher(directory)
    print(f"Sagitta 环境安装完成。启动入口：{launcher}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Updater 安装失败：{error}", file=sys.stderr)
        sys.exit(1)
