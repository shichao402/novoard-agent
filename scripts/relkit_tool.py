#!/usr/bin/env python3
"""Download and verify one relkit tool from the project's server.

This is the host-side twin of relkit's own `scripts/ci/relkit-tool-verify.sh`:
the server is the only place a tool comes from, the project's root public key
is the only thing trusted, and `ssh-keygen -Y verify` is the only verifier
(requirement 12). Nothing here pins a version, a digest, or a bundle URL --
asking for `current/<component>/<platform>` is what lets the tool set move
forward without touching any host repository.

The three steps are the whole contract:
  1. read `relkit.project.json` for the server and root public key,
  2. download `<component>/<platform>` plus its `.sig`,
  3. verify the signature, then hand the path to the caller.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROJECT_FILE = "relkit.project.json"
NAMESPACE = "relkit-tool"
PRINCIPAL = "relkit-root"


class ToolFetchError(RuntimeError):
    """A failure the operator can act on."""


def load_project(project_root: Path) -> dict:
    path = project_root / PROJECT_FILE
    if not path.is_file():
        raise ToolFetchError(f"{path} is missing; the server and root key are not declared")
    try:
        project = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ToolFetchError(f"{path} is not valid JSON: {error}") from error
    if project.get("schema") != "relkit.project/1":
        raise ToolFetchError(f"{path} schema is {project.get('schema')!r}, expected relkit.project/1")
    for field in ("server", "rootPublicKey"):
        if not str(project.get(field) or "").strip():
            raise ToolFetchError(f"{path} has no {field}")
    return project


def binary_name(component: str, platform: str) -> str:
    """Return the file name the server publishes for a component.

    The names follow the registry's binary prefixes, which is why this is a
    table rather than a guess: a host that invents a name downloads a 404.
    """
    prefixes = {
        "cli": "relkit",
        "updater": "relkit-updater",
        "ops": "relkit-ops",
    }
    if component == "sdk-dart":
        return "relkit-sdk-dart.zip"
    if component == "sdk-rust":
        return "relkit-sdk-rust.zip"
    prefix = prefixes.get(component)
    if prefix is None:
        raise ToolFetchError(f"unknown tool component {component!r}")
    suffix = ".exe" if platform.startswith("windows-") else ""
    return f"{prefix}-{platform}{suffix}"


def download(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            destination.write_bytes(response.read())
    except urllib.error.HTTPError as error:
        raise ToolFetchError(f"GET {url} returned {error.code}") from error
    except urllib.error.URLError as error:
        raise ToolFetchError(f"GET {url} failed: {error.reason}") from error


def find_ssh_keygen() -> str:
    """Locate the ssh-keygen that ships with Git for Windows / macOS / Linux.

    Requirement 12.3: verification must not depend on a relkit-provided
    verifier, so the build machine's own binary is the only acceptable tool.
    """
    found = shutil.which("ssh-keygen")
    if found:
        return found
    if os.name == "nt":
        for candidate in (
            Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Git" / "usr" / "bin" / "ssh-keygen.exe",
            Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Git" / "bin" / "ssh-keygen.exe",
        ):
            if candidate.is_file():
                return str(candidate)
    raise ToolFetchError(
        "ssh-keygen is not on PATH; requirement 12.3 verifies tools with the "
        "build machine's own ssh-keygen (Git for Windows / macOS both ship one)"
    )


def verify(public_key: str, tool_path: Path, signature_path: Path, work_dir: Path) -> None:
    allowlist = work_dir / "relkit_allowed_signers"
    # `*` as the principal is deliberate: the signed blob carries no principal,
    # so naming the key id here makes ssh-keygen reject an otherwise valid
    # signature with "Could not verify signature."
    allowlist.write_text(f"* {public_key}\n", encoding="ascii")
    command = [
        find_ssh_keygen(),
        "-Y", "verify",
        "-f", str(allowlist),
        "-I", PRINCIPAL,
        "-n", NAMESPACE,
        "-s", str(signature_path),
    ]
    with tool_path.open("rb") as payload:
        result = subprocess.run(
            command,
            stdin=payload,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    if result.returncode != 0:
        detail = (result.stderr or b"").decode("utf-8", "replace").strip()
        raise ToolFetchError(f"signature verification failed for {tool_path.name}: {detail}")


def fetch(
    project_root: Path,
    component: str,
    platform: str,
    out_dir: Path,
    out_name: str = "",
    extract_to: Path = None,
) -> Path:
    project = load_project(project_root)
    server = str(project["server"]).rstrip("/")
    public_key = str(project["rootPublicKey"]).strip()
    name = binary_name(component, platform)
    base = f"{server}/v1/tools/current/{component}/{platform}"
    out_dir.mkdir(parents=True, exist_ok=True)
    # The server name is the download name; the local name is what the build
    # already expects. They only diverge where a host packages a tool under a
    # fixed name (Windows updater ships as relkit-updater.exe).
    tool_path = out_dir / (out_name or name)
    signature_path = out_dir / f"{name}.sig"
    download(base, tool_path)
    download(f"{base}/signature", signature_path)
    verify(public_key, tool_path, signature_path, out_dir)
    # The signature is a build-time artifact; a stale .sig next to a tool is
    # what makes a later run look verified when it is not.
    try:
        signature_path.unlink()
    except OSError:
        pass
    if extract_to is not None:
        # Unpack only after the signature check: a zip that fails verification
        # must never reach the directory the build links against.
        import zipfile

        if extract_to.exists():
            shutil.rmtree(extract_to, ignore_errors=True)
        extract_to.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(tool_path) as archive:
            archive.extractall(extract_to)
    return tool_path


def main(argv):
    parser = argparse.ArgumentParser(description="download and verify a relkit tool")
    parser.add_argument(
        "--component",
        required=True,
        choices=("cli", "updater", "ops", "sdk-dart", "sdk-rust"),
    )
    parser.add_argument("--platform", required=True)
    parser.add_argument("--out-dir", default="")
    parser.add_argument("--out-name", default="", help="local file name to write (default: the server's)")
    parser.add_argument(
        "--extract-to",
        default="",
        help="unpack the verified zip into this directory (sdk-dart / sdk-rust)",
    )
    parser.add_argument("--project-root", default=str(ROOT))
    args = parser.parse_args(argv)
    project_root = Path(args.project_root).resolve()
    out_dir = Path(args.out_dir) if args.out_dir else project_root / ".relkit" / "tools"
    if not out_dir.is_absolute():
        out_dir = project_root / out_dir
    extract_to = None
    if args.extract_to:
        extract_to = Path(args.extract_to)
        if not extract_to.is_absolute():
            extract_to = project_root / extract_to
    try:
        path = fetch(
            project_root,
            args.component,
            args.platform,
            out_dir,
            args.out_name,
            extract_to,
        )
    except ToolFetchError as error:
        print(f"relkit tool fetch failed: {error}", file=sys.stderr)
        return 1
    print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
