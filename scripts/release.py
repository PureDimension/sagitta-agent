import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
REPOSITORY = "PureDimension/sagitta-agent"


def run(
    arguments,
    directory=ROOT,
    capture=False,
):
    executable = shutil.which(arguments[0])
    if executable is None:
        raise FileNotFoundError(f"找不到 {arguments[0]}，请先安装并加入 PATH。")
    result = subprocess.run(
        [executable, *arguments[1:]], cwd=directory, check=True, text=True,
        stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout.strip() if capture else None


def main():
    parser = argparse.ArgumentParser(description="本地编译并打包 Sagitta；显式选择发布到 GitHub Release。")
    parser.add_argument("--publish", action="store_true", help="上传并发布；要求工作树干净且远程版本标签指向 HEAD")
    args = parser.parse_args()
    manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    updater = ROOT / "plugins/updater"
    updater_manifest = json.loads((updater / "package.json").read_text(encoding="utf-8"))
    tag = f"v{manifest['version']}"
    commit = run(["git", "rev-parse", "HEAD"], capture=True)
    dirty = bool(run(["git", "status", "--porcelain"], capture=True))
    if manifest["engines"]["dsh"] != updater_manifest["engines"]["dsh"]:
        raise RuntimeError("业务包和 Updater 声明的 DSH 版本必须一致。")

    # 发布产物必须能追溯到已提交、已推送的同一版本；本地验包允许未提交修改。
    if args.publish:
        if dirty:
            raise RuntimeError("请先提交并审查工作树，再发布 Release。")
        remote = run(["git", "ls-remote", f"https://github.com/{REPOSITORY}.git",
                      f"refs/tags/{tag}", f"refs/tags/{tag}^{{}}"], capture=True)
        references = dict(line.split()[::-1] for line in remote.splitlines())
        tagged_commit = references.get(f"refs/tags/{tag}^{{}}", references.get(f"refs/tags/{tag}"))
        if tagged_commit != commit:
            raise RuntimeError(f"请先将指向当前 HEAD 的 {tag} 标签推送到 GitHub。")

    output = ROOT / ".runtime/releases" / tag
    output.mkdir(parents=True, exist_ok=True)
    # 清理编译目录，避免已经删除的源码以旧 JS 文件的形式残留在发布包中。
    for relative in ["shared/dist", "plugins/task/dist", "plugins/memory/dist", "plugins/updater/dist"]:
        directory = ROOT / relative
        if directory.exists():
            shutil.rmtree(directory)

    packages = {}
    for name, directory in [("runtime", ROOT), ("updater", updater)]:
        print(f"编译并打包 {name}", flush=True)
        run(["npm", "run", "build", "--ignore-scripts"], directory)
        result = json.loads(run(["npm", "pack", "--ignore-scripts", "--json",
                                 "--pack-destination", str(output)], directory, capture=True))[0]
        archive = output / result["filename"]
        packages[name] = {"file": archive.name, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}

    release_file = output / "release.json"
    release_file.write_text(json.dumps({
        "tag": tag, "commit": commit, "dirty": dirty,
        "dsh": manifest["engines"]["dsh"], "packages": packages,
    }, indent=2) + "\n", encoding="utf-8")
    installer = output / "install.py"
    shutil.copyfile(ROOT / "scripts/install-updater.py", installer)
    print(f"发布产物：{output}", flush=True)
    if args.publish:
        notes = output / "notes.md"
        notes.write_text(f"Sagitta {tag}\n\n对应提交：{commit}\n所需 DSH：{manifest['engines']['dsh']}\n\n"
                         '下载 install.py，运行 python3 install.py --directory "/你的路径/Sagitta"。\n'
                         "Windows 使用 py -3 install.py --directory D:\\Sagitta。随后运行安装目录内的 sagitta.sh / sagitta.cmd。\n"
                         "需要 Node.js、npm、pnpm 和 Python 3；安装器局部安装指定版本 DSH。已有安装再次指定同一目录即可更新。\n\n"
                         "此为实验版本，包含任务插件和 Updater；记忆插件暂为空壳。启动后选择 Sagitta 预设，"
                         "为任务插件配置本地数据库目录或已有 PostgreSQL 连接，保存后重启。\n\n"
                         "验收平台为 macOS ARM；Windows/Linux 尚未实机验证。首版以单实例使用为验收范围，"
                         "多个实例共用数据库时临时任务到期提醒存在竞争丢失问题。启动时 GitHub 检查失败会阻止 Sagitta 就绪。\n",
                         encoding="utf-8")
        run(["gh", "release", "create", tag, str(release_file), str(installer),
             *(str(output / package["file"]) for package in packages.values()),
             "--repo", REPOSITORY, "--verify-tag", "--title", f"Sagitta {tag}",
             "--notes-file", str(notes), "--latest"])


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"构建或发布失败：{error}", file=sys.stderr)
        sys.exit(1)
