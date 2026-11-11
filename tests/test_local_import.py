"""Local link-in-place import: identity, skip, delete, serving URL."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from backend.app.db.models import Base, MediaItem
from backend.app.services.local_import import link_one_file
from backend.app.services.local_media import (
    STORAGE_LINKED,
    STORAGE_MANAGED,
    iter_media_files,
    linked_source_post_id,
    media_type_for_path,
)
from backend.app.services.media_service import (
    absolute_path_for_media,
    delete_linked_media_file,
    delete_media,
    media_file_url_for,
    media_storage_kind,
)


class LocalMediaHelpersTests(unittest.TestCase):
    def test_linked_source_post_id_stable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.jpg"
            path.write_bytes(b"x")
            a = linked_source_post_id(path)
            b = linked_source_post_id(path.resolve())
            self.assertEqual(a, b)
            self.assertTrue(a.startswith("loc_"))
            self.assertLessEqual(len(a), 32)

    def test_media_type_for_path(self) -> None:
        self.assertEqual(media_type_for_path(Path("x.PNG")), "image")
        self.assertEqual(media_type_for_path(Path("x.gif")), "gif")
        self.assertEqual(media_type_for_path(Path("x.mp4")), "video")
        self.assertIsNone(media_type_for_path(Path("x.txt")))

    def test_iter_media_files_recursive(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.jpg").write_bytes(b"a")
            nested = root / "sub"
            nested.mkdir()
            (nested / "b.png").write_bytes(b"b")
            (nested / "skip.txt").write_text("nope", encoding="utf-8")
            flat = iter_media_files([str(root)], recursive=False)
            deep = iter_media_files([str(root)], recursive=True)
            self.assertEqual(len(flat), 1)
            self.assertEqual(len(deep), 2)


class LocalImportDbTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db: Session = sessionmaker(bind=self.engine, autoflush=False)()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()
        self.tmp.cleanup()

    def _make_jpg(self, name: str, content: bytes = b"jpeg-bytes") -> Path:
        path = self.root / name
        path.write_bytes(content)
        return path

    def test_link_one_file_inserts_linked_row(self) -> None:
        path = self._make_jpg("one.jpg")
        media, skip = link_one_file(self.db, path)
        self.db.commit()
        self.assertIsNone(skip)
        assert media is not None
        self.assertEqual(media.storage_kind, STORAGE_LINKED)
        self.assertEqual(Path(media.local_path), path.resolve())
        self.assertTrue(media.source_url.startswith("file:"))
        self.assertEqual(media_file_url_for(media), f"/api/media/{media.id}/file")
        self.assertEqual(absolute_path_for_media(media), path.resolve())

    def test_link_one_file_skips_already_have(self) -> None:
        path = self._make_jpg("dup.jpg")
        first, skip1 = link_one_file(self.db, path)
        self.db.commit()
        self.assertIsNone(skip1)
        second, skip2 = link_one_file(self.db, path)
        self.assertEqual(skip2, "already_have")
        self.assertEqual(first.id, second.id)

    def test_link_one_file_skips_duplicate_hash(self) -> None:
        a = self._make_jpg("a.jpg", b"same")
        b = self._make_jpg("b.jpg", b"same")
        first, skip1 = link_one_file(self.db, a)
        self.db.commit()
        self.assertIsNone(skip1)
        second, skip2 = link_one_file(self.db, b)
        self.assertEqual(skip2, "duplicate_hash")
        self.assertEqual(first.id, second.id)

    def test_library_delete_keeps_linked_file(self) -> None:
        path = self._make_jpg("keep.jpg")
        media, _ = link_one_file(self.db, path)
        self.db.commit()
        assert media is not None
        media_id = media.id
        delete_media(self.db, media_id)
        self.db.commit()
        self.assertTrue(path.is_file())
        self.assertIsNone(self.db.query(MediaItem).filter(MediaItem.id == media_id).first())

    def test_delete_linked_media_file_removes_disk(self) -> None:
        path = self._make_jpg("gone.jpg")
        media, _ = link_one_file(self.db, path)
        self.db.commit()
        assert media is not None
        media_id = media.id
        delete_linked_media_file(self.db, media_id)
        self.db.commit()
        self.assertFalse(path.exists())
        self.assertIsNone(self.db.query(MediaItem).filter(MediaItem.id == media_id).first())

    def test_delete_linked_rejects_managed(self) -> None:
        media = MediaItem(
            source_post_id="1",
            source_url="https://example/post/1",
            local_path="media/image/1.jpg",
            storage_kind=STORAGE_MANAGED,
            media_type="image",
        )
        self.db.add(media)
        self.db.commit()
        with self.assertRaises(ValueError):
            delete_linked_media_file(self.db, media.id)

    def test_managed_url_unchanged(self) -> None:
        media = MediaItem(
            source_post_id="2",
            source_url="https://example/post/2",
            local_path="media/image/2.jpg",
            storage_kind=STORAGE_MANAGED,
            media_type="image",
        )
        self.assertEqual(media_storage_kind(media), STORAGE_MANAGED)
        self.assertEqual(media_file_url_for(media), "/media/image/2.jpg")


if __name__ == "__main__":
    unittest.main()
