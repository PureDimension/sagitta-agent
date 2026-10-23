import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent


def run(
    args,
    capture=False,
):
    executable = shutil.which(args[0])
    if executable is None:
        raise FileNotFoundError(f"找不到 {args[0]}，请先安装并加入 PATH。")
    result = subprocess.run(
        [executable, *args[1:]], cwd=ROOT, check=True, text=True,
        stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout


def main():
    manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    required = manifest["engines"]["dsh"]
    installed = run(["dsh", "--version"], capture=True).strip()
    if installed != required:
        raise RuntimeError(f"需要 DSH {required}，当前为 {installed}。请先手动安装匹配版本。")
    for command in [
        ["npm", "--prefix", "plugins/updater", "install", "--include=dev",
         "--ignore-scripts", "--package-lock=false", "--no-audit", "--no-fund"],
        ["npm", "--prefix", "plugins/updater", "run", "build", "--ignore-scripts"],
        ["dsh", "plugin", "--profile", "web", "add", "file:./plugins/updater"],
    ]:
        print(" ".join(command), flush=True)
        run(command)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Updater 安装失败：{error}", file=sys.stderr)
        sys.exit(1)
