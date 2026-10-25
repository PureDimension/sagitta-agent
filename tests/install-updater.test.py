import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/install-updater.py"
spec = importlib.util.spec_from_file_location("installer", SCRIPT)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(
        self,
    ):
        self.archive = b"release archive fixture"
        self.release = {"tag": "v0.1.0", "dirty": False, "dsh": "0.2.1-rc.2", "packages": {
            "updater": {"file": "sagitta-updater-0.1.0.tgz",
                        "sha256": hashlib.sha256(self.archive).hexdigest()},
        }}

    def response(
        self,
        url,
        **kwargs,
    ):
        self.assertEqual(kwargs["timeout"], 120)
        body = json.dumps(self.release).encode() if url.endswith("release.json") else self.archive
        return io.BytesIO(body)

    def test_install_and_reinstall_preserve_data(
        self,
    ):
        with TemporaryDirectory() as temporary:
            root = Path(temporary).resolve() / "Sagitta with spaces"
            with patch("sys.argv", ["install.py", "--directory", str(root)]), \
                    patch.object(installer, "urlopen", side_effect=self.response), \
                    patch.object(installer, "run", return_value="0.2.1-rc.2\n") as command:
                installer.main()
                install = command.call_args
                self.assertEqual(install.args[0][2:6], ["plugin", "--profile", "web", "add"])
                self.assertEqual(install.kwargs["env"]["DSH_HOME"], str(root / "home"))
                self.assertEqual(install.kwargs["env"]["DSH_AGENTS_HOME"], str(root / "agents"))
                filename = Path(install.args[0][6])
                self.assertEqual(filename.read_bytes(), self.archive)
                user_file = root / "home/keep.txt"
                user_file.write_text("保留用户数据")
                installer.main()
                self.assertEqual(user_file.read_text(), "保留用户数据")
                self.assertEqual(json.loads((root / "runtime/package.json").read_text())["name"], "sagitta-environment")
                self.assertTrue((root / ("sagitta.cmd" if os.name == "nt" else "sagitta.sh")).is_file())

    def test_invalid_release_does_not_install(
        self,
    ):
        for failure in ["version", "hash", "dirty", "path"]:
            with self.subTest(failure=failure), TemporaryDirectory() as directory, \
                    patch("sys.argv", ["install.py", "--directory", directory]), \
                    patch.object(installer, "urlopen", side_effect=self.response), \
                    patch.object(installer, "run", return_value="24.0.0") as command:
                self.setUp()
                if failure == "version":
                    self.release["dsh"] = "latest"
                elif failure == "hash":
                    self.release["packages"]["updater"]["sha256"] = "0" * 64
                elif failure == "dirty":
                    self.release["dirty"] = True
                else:
                    self.release["packages"]["updater"]["file"] = "../updater.tgz"
                with self.assertRaises(RuntimeError):
                    installer.main()
                self.assertEqual(command.call_count, 3, "仅检查 node/npm/pnpm")
                self.assertEqual(list(Path(directory).iterdir()), [])

    def test_reject_unknown_directory_and_missing_prerequisite(
        self,
    ):
        with TemporaryDirectory() as directory, patch("sys.argv", ["install.py", "--directory", directory]), \
                patch.object(installer, "urlopen") as fetch, patch.object(installer.shutil, "which", return_value=None):
            with self.assertRaises(FileNotFoundError):
                installer.main()
            (Path(directory) / "user.txt").touch()
            with self.assertRaisesRegex(RuntimeError, "目标目录非空"):
                installer.main()
            fetch.assert_not_called()

    def test_install_failure_does_not_create_launcher(
        self,
    ):
        with TemporaryDirectory() as directory, patch("sys.argv", ["install.py", "--directory", directory]), \
                patch.object(installer, "urlopen", side_effect=self.response), \
                patch.object(installer, "run", side_effect=["24", "11", "11", subprocess.CalledProcessError(1, "npm")]):
            with self.assertRaises(subprocess.CalledProcessError):
                installer.main()
            self.assertFalse((Path(directory) / "sagitta.sh").exists())

    @unittest.skipIf(os.name == "nt", "POSIX 启动器实测")
    def test_launcher_preserves_working_directory_and_forwards_arguments(
        self,
    ):
        with TemporaryDirectory() as temporary:
            root = Path(temporary) / "Sagitta spaces"
            binary = root / "runtime/node_modules/.bin/dsh"
            binary.parent.mkdir(parents=True)
            binary.write_text('#!/bin/sh\nprintf "%s\\n" "$DSH_HOME" "$DSH_AGENTS_HOME" "$PWD" "$@"\n')
            binary.chmod(0o755)
            launcher = installer.write_launcher(root)
            output = subprocess.check_output([str(launcher), "--port", "1234"], cwd=temporary, text=True).splitlines()
            self.assertEqual(output, [str(root / "home"), str(root / "agents"), str(Path(temporary).resolve()), "web", "--port", "1234"])


if __name__ == "__main__":
    unittest.main()
