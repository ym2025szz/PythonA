#!/usr/bin/env python3
"""Fetch build-time inputs and verify every byte against the repository lock.

This is a developer workstation helper. It is not packaged into the Android app.
"""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
RELEASE = "https://github.com/ym2025szz/PythonA/releases/download/v0.5.0"


def verify(path, size, digest):
    if not path.is_file() or path.stat().st_size != size:
        return False
    checksum = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest() == digest.lower()


def ensure(path, url, size, digest, verify_only):
    if verify(path, size, digest):
        print("Verified:", path.relative_to(ROOT))
        return
    if verify_only:
        raise RuntimeError(f"Missing or checksum mismatch: {path.relative_to(ROOT)}")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".download")
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "PythonA-build-inputs/0.5.0"})
        with urllib.request.urlopen(request, timeout=60) as source, temporary.open("wb") as output:
            total = 0
            while chunk := source.read(1024 * 1024):
                total += len(chunk)
                if total > size:
                    raise RuntimeError(f"Download exceeds locked size: {path.name}")
                output.write(chunk)
        if not verify(temporary, size, digest):
            raise RuntimeError(f"Downloaded input failed SHA-256 verification: {path.name}")
        temporary.replace(path)
        print("Downloaded and verified:", path.relative_to(ROOT))
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-only", action="store_true", help="Check local inputs without network access")
    options = parser.parse_args()
    lock = json.loads((ROOT / "runtime-dependencies.lock.json").read_text(encoding="utf-8"))
    for artifact in lock["artifacts"]:
        if artifact.get("mavenCoordinate"):
            continue  # Gradle resolves these using its dependency verification metadata.
        name = artifact["filename"]
        if Path(name).name != name or "/" in name or "\\" in name:
            raise RuntimeError("Invalid locked filename")
        ensure(ROOT / ".runtime-cache" / name, artifact["url"], artifact["size"], artifact["sha256"], options.verify_only)
    dsh = lock["embeddedDsh"]
    name = "dsh-runtime-rootfs.bin"
    if dsh["asset"] != name:
        raise RuntimeError("Unexpected DSH asset name")
    ensure(ROOT / "android/app/src/main/assets" / name, f"{RELEASE}/{name}", dsh["size"], dsh["sha256"], options.verify_only)


if __name__ == "__main__":
    main()
