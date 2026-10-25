"""显式运行的验包入口：只替换 GitHub 下载，实际安装隔离 DSH 和 Updater。"""
import argparse
import importlib.util
import io
import json
from pathlib import Path
import sys
from unittest.mock import patch

parser = argparse.ArgumentParser()
parser.add_argument("release", type=Path)
parser.add_argument("directory", type=Path)
args = parser.parse_args()
spec = importlib.util.spec_from_file_location("installer", args.release / "install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
manifest = json.loads((args.release / "release.json").read_text())
# 本地验包允许尚未提交的构建；生产安装器的正式发布校验保持原样。
manifest["dirty"] = False


def response(
    url,
    **kwargs,
):
    if url == f"{installer.RELEASES_URL}/latest/download/release.json":
        return io.BytesIO(json.dumps(manifest).encode())
    asset = manifest["packages"]["updater"]["file"]
    if url == f"{installer.RELEASES_URL}/download/{manifest['tag']}/{asset}":
        return io.BytesIO((args.release / asset).read_bytes())
    raise AssertionError(f"意外的下载地址：{url}")


with patch.object(installer, "urlopen", side_effect=response), \
        patch.object(sys, "argv", ["install.py", "--directory", str(args.directory)]):
    installer.main()
