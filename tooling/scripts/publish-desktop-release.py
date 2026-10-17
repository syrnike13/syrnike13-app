#!/usr/bin/env python3
"""Pull a public GitHub release over HTTPS, verify it, then publish its feed.

Requires Python 3, PyYAML (Ubuntu: python3-yaml), and curl on the server.
GitHub release metadata is read from stdin; no GitHub token reaches the server.
"""

import base64
from concurrent.futures import ThreadPoolExecutor
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.parse import unquote, urlparse

import yaml


FEEDS = ("latest.yml", "latest-mac.yml", "latest-linux.yml")
SUFFIXES = (".exe", ".zip", ".dmg", ".AppImage", ".7z", ".blockmap")


def filename(value):
    if not isinstance(value, str) or not value or value in (".", ".."):
        raise ValueError(f"Invalid release filename: {value!r}")
    if Path(value).name != value or "\\" in value or any(ord(c) < 32 for c in value):
        raise ValueError(f"Invalid release filename: {value!r}")
    return value


def digest(path, algorithm):
    hasher = hashlib.new(algorithm)
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.digest()


def matches(path, asset):
    return (
        path.is_file()
        and not path.is_symlink()
        and path.stat().st_size == asset["size"]
        and digest(path, "sha256").hex() == asset["digest"].removeprefix("sha256:")
    )


def download(asset, target):
    print(f"Downloading {target.name} ({asset['size']} bytes) over HTTPS", flush=True)
    subprocess.run(
        [
            "curl", "--fail", "--location", "--silent", "--show-error",
            "--proto", "=https", "--proto-redir", "=https",
            "--retry", "3", "--retry-delay", "2", "--connect-timeout", "15",
            "--max-time", "900", "--speed-limit", "8192", "--speed-time", "60",
            "--output", str(target), asset["browser_download_url"],
        ],
        check=True,
    )
    if not matches(target, asset):
        raise ValueError(f"Release size/SHA-256 mismatch: {target.name}")
    target.chmod(0o644)


def publish(release, directory, version):
    if release["tag_name"] != f"v{version}" or release["draft"] or release["prerelease"]:
        raise ValueError("Expected a published stable release matching the requested version")

    assets = {}
    for asset in release["assets"]:
        name = filename(asset["name"])
        if name not in FEEDS and not name.endswith(SUFFIXES):
            continue
        url = urlparse(asset["browser_download_url"])
        if url.scheme != "https" or url.netloc != "github.com":
            raise ValueError(f"Expected a GitHub HTTPS asset URL: {name}")
        checksum = asset.get("digest", "") or ""
        if (
            asset["state"] != "uploaded" or asset["size"] <= 0
            or not checksum.startswith("sha256:") or len(checksum) != 71
        ):
            raise ValueError(f"Missing uploaded asset size/SHA-256: {name}")
        bytes.fromhex(checksum[7:])
        if name in assets:
            raise ValueError(f"Duplicate release asset: {name}")
        assets[name] = asset
    for feed in FEEDS:
        if feed not in assets:
            raise ValueError(f"Missing update manifest: {feed}")

    directory.mkdir(parents=True, exist_ok=True)
    with (directory / ".publish.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with tempfile.TemporaryDirectory(prefix=".release-", dir=directory) as staging:
            stage = Path(staging)
            manifests = {}
            destinations = {name: name for name in assets}
            for feed in FEEDS:
                download(assets[feed], stage / feed)
                manifest = yaml.safe_load((stage / feed).read_text())
                if manifest["version"] != version or manifest.get("stagingPercentage", 100) != 100:
                    raise ValueError(f"Unexpected version or rollout percentage in {feed}")
                if not manifest.get("files"):
                    raise ValueError(f"No release files in {feed}")
                for entry in manifest["files"]:
                    name = filename(unquote(entry["url"]))
                    # GitHub normalizes spaces in uploaded release asset names.
                    asset_name = name.replace(" ", ".")
                    if asset_name not in assets:
                        raise ValueError(f"Missing manifest target: {name}")
                    destinations[asset_name] = name
                    if f"{asset_name}.blockmap" in assets:
                        destinations[f"{asset_name}.blockmap"] = f"{name}.blockmap"
                if manifest.get("path") not in [unquote(entry["url"]) for entry in manifest["files"]]:
                    raise ValueError(f"Manifest path is not in its file list: {feed}")
                manifests[feed] = manifest

            if len(set(destinations.values())) != len(destinations):
                raise ValueError("Release asset destinations collide")
            payloads = [name for name in assets if name not in FEEDS]

            def prepare(name):
                target = directory / destinations[name]
                if matches(target, assets[name]):
                    print(f"Already verified: {target.name}", flush=True)
                    return name, target
                target = stage / destinations[name]
                download(assets[name], target)
                return name, target

            with ThreadPoolExecutor(max_workers=3) as executor:
                prepared = dict(executor.map(prepare, payloads))

            for manifest in manifests.values():
                for entry in manifest["files"]:
                    name = filename(unquote(entry["url"]))
                    target = prepared[name.replace(" ", ".")]
                    checksum = base64.b64decode(entry["sha512"], validate=True)
                    if target.stat().st_size != entry["size"] or digest(target, "sha512") != checksum:
                        raise ValueError(f"Manifest size/SHA-512 mismatch: {name}")

            aliases = {
                "syrnike13-setup.exe": manifests["latest.yml"]["path"],
                "syrnike13.AppImage": manifests["latest-linux.yml"]["path"],
                "syrnike13.dmg": next(
                    unquote(entry["url"]) for entry in manifests["latest-mac.yml"]["files"]
                    if entry["url"].endswith(".dmg")
                ),
            }
            # Every target and checksum is validated before changing public files.
            for name, target in prepared.items():
                if target.parent == stage:
                    os.replace(target, directory / destinations[name])
            for alias, target in aliases.items():
                (stage / alias).symlink_to(filename(target))
                os.replace(stage / alias, directory / alias)
            # Clients cannot see a new feed before all its payloads are in place.
            for feed in FEEDS:
                os.replace(stage / feed, directory / feed)
            print(f"Published and verified desktop release {version}", flush=True)


if __name__ == "__main__":
    publish(json.load(sys.stdin), Path(sys.argv[1]).resolve(), sys.argv[2])
