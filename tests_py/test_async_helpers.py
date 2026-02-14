import unittest
from unittest.mock import patch
from pathlib import Path
import tempfile
from bot_py.helpers import async_exists, get_library_path

class TestAsyncHelpers(unittest.IsolatedAsyncioTestCase):
    async def test_async_exists(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            f = tmp_path / "test.txt"
            f.touch()
            self.assertTrue(await async_exists(f))
            self.assertFalse(await async_exists(tmp_path / "nonexistent"))

    async def test_get_library_path(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)

            with patch('bot_py.helpers.Path.cwd', return_value=tmp_path):
                # Create structure: library/game1/en_usd_preview.html
                (tmp_path / "library" / "game1").mkdir(parents=True)
                (tmp_path / "library" / "game1" / "en_usd_preview.html").touch()

                path = await get_library_path("game1", "en_usd", True)
                self.assertIsNotNone(path)
                self.assertTrue(path.endswith("en_usd_preview.html"))

                path_none = await get_library_path("game1", "en_usd", False)
                self.assertIsNone(path_none)
