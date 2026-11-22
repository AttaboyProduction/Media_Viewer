"""Deleted media database ids must not be reused for new files."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from backend.app.db.models import Base, MediaItem
from backend.app.services.local_import import link_one_file
from backend.app.services.media_service import delete_media


class MediaIdAutoincrementTests(unittest.TestCase):
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

    def _jpg(self, name: str, content: bytes) -> Path:
        path = self.root / name
        path.write_bytes(content)
        return path

    def test_create_all_emits_autoincrement(self) -> None:
        sql = self.db.execute(
            text("SELECT sql FROM sqlite_master WHERE type='table' AND name='media_items'")
        ).scalar()
        self.assertIn("AUTOINCREMENT", (sql or "").upper())

    def test_deleted_id_is_not_reused(self) -> None:
        first_path = self._jpg("a.jpg", b"first")
        second_path = self._jpg("b.jpg", b"second")
        first, skip = link_one_file(self.db, first_path)
        self.db.commit()
        self.assertIsNone(skip)
        assert first is not None
        deleted_id = first.id
        delete_media(self.db, deleted_id)
        self.db.commit()

        second, skip2 = link_one_file(self.db, second_path)
        self.db.commit()
        self.assertIsNone(skip2)
        assert second is not None
        self.assertNotEqual(second.id, deleted_id)
        self.assertGreater(second.id, deleted_id)


class MediaIdMigrationTests(unittest.TestCase):
    def test_legacy_table_is_rebuilt_with_autoincrement(self) -> None:
        from backend import init_db as init_db_mod

        engine = create_engine("sqlite:///:memory:")
        with engine.begin() as conn:
            conn.execute(
                text(
                    """
                    CREATE TABLE media_items (
                        id INTEGER NOT NULL PRIMARY KEY,
                        source_post_id VARCHAR(32) NOT NULL UNIQUE,
                        source_url VARCHAR(512) NOT NULL,
                        local_path VARCHAR(1024) NOT NULL,
                        storage_kind VARCHAR(16) NOT NULL DEFAULT 'managed',
                        media_type VARCHAR(16) NOT NULL,
                        is_discarded BOOLEAN NOT NULL DEFAULT 0,
                        scraped_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
            )
            conn.execute(
                text(
                    """
                    INSERT INTO media_items (
                        id, source_post_id, source_url, local_path, media_type, is_discarded
                    ) VALUES
                    (1, 'a', 'https://example/a', 'media/image/a.jpg', 'image', 0),
                    (3, 'c', 'https://example/c', 'media/image/c.jpg', 'image', 0)
                    """
                )
            )

        original_engine = init_db_mod.engine
        try:
            init_db_mod.engine = engine
            init_db_mod._ensure_media_items_autoincrement()
        finally:
            init_db_mod.engine = original_engine

        with engine.connect() as conn:
            sql = conn.execute(
                text("SELECT sql FROM sqlite_master WHERE type='table' AND name='media_items'")
            ).scalar()
            self.assertIn("AUTOINCREMENT", (sql or "").upper())
            ids = [row[0] for row in conn.execute(text("SELECT id FROM media_items ORDER BY id"))]
            self.assertEqual(ids, [1, 3])
            seq = conn.execute(
                text("SELECT seq FROM sqlite_sequence WHERE name='media_items'")
            ).scalar()
            self.assertEqual(seq, 3)

            conn.execute(text("DELETE FROM media_items WHERE id=3"))
            conn.commit()
            conn.execute(
                text(
                    """
                    INSERT INTO media_items (
                        source_post_id, source_url, local_path, media_type, is_discarded
                    ) VALUES ('d', 'https://example/d', 'media/image/d.jpg', 'image', 0)
                    """
                )
            )
            conn.commit()
            new_id = conn.execute(
                text("SELECT id FROM media_items WHERE source_post_id='d'")
            ).scalar()
            self.assertEqual(new_id, 4)
        engine.dispose()
