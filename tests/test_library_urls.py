"""Library URL index matches scrape post URLs against all stored source URLs."""

from __future__ import annotations

import unittest

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from backend.app.db.models import Base, MediaItem, MediaSourceUrl
from backend.app.services.library_urls import (
    build_library_url_index,
    library_media_id_from_index,
    library_media_id_for_scrape_url,
)


class LibraryUrlIndexTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db: Session = sessionmaker(bind=self.engine, autoflush=False)()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_extra_source_url_matches_without_primary_post_id(self) -> None:
        page = "https://rule34.xxx/index.php?page=post&s=view&id=12345"
        media = MediaItem(
            source_post_id="99999",
            source_url="https://rule34.xxx/index.php?page=post&s=view&id=99999",
            local_path="media/x.jpg",
            media_type="image",
        )
        self.db.add(media)
        self.db.flush()
        self.db.add(MediaSourceUrl(media_id=media.id, url=page))
        self.db.commit()

        index = build_library_url_index(self.db)
        self.assertEqual(library_media_id_from_index(index, page), int(media.id))
        self.assertEqual(library_media_id_for_scrape_url(self.db, page), int(media.id))

    def test_source_url_field_matches(self) -> None:
        url = "https://example.test/post/42"
        media = MediaItem(
            source_post_id="42",
            source_url=url,
            local_path="media/y.jpg",
            media_type="image",
        )
        self.db.add(media)
        self.db.commit()

        self.assertEqual(
            library_media_id_for_scrape_url(self.db, url),
            int(media.id),
        )


if __name__ == "__main__":
    unittest.main()