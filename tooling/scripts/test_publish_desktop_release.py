import base64
import contextlib
import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import yaml


spec = importlib.util.spec_from_file_location(
    "publisher", Path(__file__).with_name("publish-desktop-release.py")
)
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class PublishReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.version = "0.7.1"
        self.payloads = {
            "syrnike13 Setup 0.7.1.exe": b"windows installer",
            "syrnike13 Setup 0.7.1.exe.blockmap": b"windows blockmap",
            "syrnike13-0.7.1-mac.zip": b"mac updater",
            "syrnike13-0.7.1.dmg": b"mac installer",
            "syrnike13-0.7.1.AppImage": b"linux installer",
        }
        manifests = {
            "latest.yml": ["syrnike13 Setup 0.7.1.exe"],
            "latest-mac.yml": ["syrnike13-0.7.1-mac.zip", "syrnike13-0.7.1.dmg"],
            "latest-linux.yml": ["syrnike13-0.7.1.AppImage"],
        }
        self.contents = {name.replace(" ", "."): body for name, body in self.payloads.items()}
        for feed, names in manifests.items():
            self.contents[feed] = yaml.safe_dump({
                "version": self.version,
                "path": names[0],
                "files": [{
                    "url": name,
                    "size": len(self.payloads[name]),
                    "sha512": base64.b64encode(hashlib.sha512(self.payloads[name]).digest()).decode(),
                } for name in names],
            }).encode()
        self.release = {
            "tag_name": f"v{self.version}", "draft": False, "prerelease": False,
            "assets": [{
                "name": name, "state": "uploaded", "size": len(body),
                "digest": f"sha256:{hashlib.sha256(body).hexdigest()}",
                "browser_download_url": f"https://github.com/example/app/releases/download/v0.7.1/{name}",
            } for name, body in self.contents.items()],
        }
        self.downloads = []

    def transport(self, command, check):
        name = command[-1].rsplit("/", 1)[-1]
        self.downloads.append(name)
        Path(command[command.index("--output") + 1]).write_bytes(self.contents[name])

    def publish(self):
        with patch.object(publisher.subprocess, "run", side_effect=self.transport):
            with contextlib.redirect_stdout(io.StringIO()):
                publisher.publish(self.release, self.directory, self.version)

    def test_publishes_verified_payloads_with_original_windows_names_and_aliases(self):
        self.publish()
        for name, body in self.payloads.items():
            self.assertEqual((self.directory / name).read_bytes(), body)
        self.assertEqual((self.directory / "syrnike13-setup.exe").read_bytes(), b"windows installer")
        self.assertEqual((self.directory / "syrnike13.dmg").read_bytes(), b"mac installer")
        self.assertEqual((self.directory / "syrnike13.AppImage").read_bytes(), b"linux installer")
        for feed in publisher.FEEDS:
            self.assertEqual((self.directory / feed).read_bytes(), self.contents[feed])

    def test_reuses_only_existing_files_with_matching_size_and_hash(self):
        self.publish()
        self.downloads.clear()
        (self.directory / "syrnike13-0.7.1.AppImage").write_bytes(b"corrupt installer")
        self.publish()
        self.assertCountEqual(self.downloads, [*publisher.FEEDS, "syrnike13-0.7.1.AppImage"])

    def test_corrupt_download_does_not_change_public_feeds_or_aliases(self):
        self.publish()
        before = {feed: (self.directory / feed).read_bytes() for feed in publisher.FEEDS}
        (self.directory / "syrnike13-0.7.1.AppImage").unlink()
        self.contents["syrnike13-0.7.1.AppImage"] = b"corrupt installer"
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            self.publish()
        for feed, body in before.items():
            self.assertEqual((self.directory / feed).read_bytes(), body)
        self.assertFalse((self.directory / "syrnike13-0.7.1.AppImage").exists())

    def test_manifest_hash_mismatch_does_not_publish_any_payload(self):
        manifest = yaml.safe_load(self.contents["latest.yml"])
        manifest["files"][0]["sha512"] = base64.b64encode(bytes(64)).decode()
        self.contents["latest.yml"] = yaml.safe_dump(manifest).encode()
        asset = next(asset for asset in self.release["assets"] if asset["name"] == "latest.yml")
        asset["size"] = len(self.contents["latest.yml"])
        asset["digest"] = f"sha256:{hashlib.sha256(self.contents['latest.yml']).hexdigest()}"
        with self.assertRaisesRegex(ValueError, "SHA-512 mismatch"):
            self.publish()
        self.assertEqual([p.name for p in self.directory.iterdir()], [".publish.lock"])

    def test_missing_manifest_target_fails_before_publishing(self):
        self.release["assets"] = [a for a in self.release["assets"] if not a["name"].endswith(".AppImage")]
        with self.assertRaisesRegex(ValueError, "Missing manifest target"):
            self.publish()
        self.assertFalse((self.directory / "latest.yml").exists())

    def test_rejects_wrong_release_and_traversal(self):
        self.release["tag_name"] = "v0.7.0"
        with self.assertRaisesRegex(ValueError, "matching the requested version"):
            self.publish()
        for name in ("../latest.yml", "/tmp/latest.yml", "..", "a\\b", "a\nb"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                publisher.filename(name)


if __name__ == "__main__":
    unittest.main()
