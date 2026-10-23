"""macOS/Homebrew：下载 PostgreSQL，按需启动独立实例并初始化任务数据库。"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
FORMULA = "postgresql@18"


def run(
    args,
    env=None,
):
    return subprocess.check_output(args, env=env, text=True).strip()


def install(
    directory,
    port,
):
    if sys.platform != "darwin" or shutil.which("brew") is None:
        raise RuntimeError("当前安装入口支持已安装 Homebrew 的 macOS。")
    brew_env = dict(os.environ, HOMEBREW_NO_AUTO_UPDATE="1", HOMEBREW_NO_INSTALL_CLEANUP="1")
    prefix = Path(run(["brew", "--prefix"], brew_env))
    binaries = prefix / "opt" / FORMULA / "bin"
    if not (binaries / "pg_ctl").exists():
        subprocess.run(["brew", "install", FORMULA], env=brew_env, check=True)
    pgdata = directory / "pgdata"
    config_file = directory / "connection.json"
    if config_file.exists():
        config = json.loads(config_file.read_text())
    else:
        if pgdata.exists():
            raise RuntimeError("已有数据目录但缺少连接配置，请先核对原配置。")
        config = {"host": "127.0.0.1", "port": port, "user": "sagitta",
                  "password": secrets.token_urlsafe(32), "database": "sagitta_tasks"}
        config_file.write_text(json.dumps(config, indent=2) + "\n")
    # 凭据只保存在本机，initdb 通过临时文件读取，避免出现在命令参数中。
    if not (pgdata / "PG_VERSION").exists():
        with tempfile.NamedTemporaryFile(mode="w", dir=directory) as password_file:
            password_file.write(config["password"] + "\n")
            password_file.flush()
            run([str(binaries / "initdb"), "-D", str(pgdata), "-U", config["user"],
                 "--auth=scram-sha-256", "--encoding=UTF8", "--locale=C",
                 f"--pwfile={password_file.name}"])
        with (pgdata / "postgresql.conf").open("a") as settings:
            settings.write(f"\nlisten_addresses = '127.0.0.1'\nport = {config['port']}\n")
            settings.write("unix_socket_directories = ''\n")
    control = [str(binaries / "pg_ctl"), "-D", str(pgdata)]
    status = subprocess.run([*control, "status"], stdout=subprocess.DEVNULL).returncode
    if status == 3:
        run([*control, "-l", str(directory / "postgres.log"), "-w", "-t", "30", "start"])
    elif status != 0:
        raise RuntimeError(f"数据库状态检查失败：{status}")
    env = dict(os.environ, PGPASSWORD=config["password"], PGCONNECT_TIMEOUT="5")
    client = [str(binaries / "psql"), "-X", "-w", "-h", config["host"],
              "-p", str(config["port"]), "-U", config["user"], "-v", "ON_ERROR_STOP=1"]
    actual = run([*client, "-d", "postgres", "-Atc", "SHOW data_directory"], env)
    if Path(actual).resolve() != pgdata.resolve():
        raise RuntimeError("连接到了其他数据库实例，停止初始化。")
    exists = run([*client, "-d", "postgres", "-Atc",
                  "SELECT 1 FROM pg_database WHERE datname = 'sagitta_tasks'"], env)
    if not exists:
        run([*client, "-d", "postgres", "-c", "CREATE DATABASE sagitta_tasks"], env)
    run([*client, "-d", config["database"], "-f",
         str(ROOT / "plugins/task/migrations/001-initial.sql")], env)
    version = run([*client, "-d", config["database"], "-Atc",
                   "SELECT max(version) FROM schema_migrations"], env)
    if version != "1":
        raise RuntimeError(f"数据库结构版本为 {version}，当前安装脚本仅支持 1。")
    print(f"任务数据库已就绪：{config['host']}:{config['port']}/{config['database']}")
    print(f"本地连接配置：{config_file}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path.home() / ".local/share/sagitta/task-db")
    parser.add_argument("--port", type=int, default=55432)
    args = parser.parse_args()
    os.umask(0o077)
    directory = args.directory.expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    # 同一目录的安装串行执行；已初始化的实例可直接复用。
    with (directory / "install.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        install(directory, args.port)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"任务数据库安装失败：{error}", file=sys.stderr)
        sys.exit(1)
