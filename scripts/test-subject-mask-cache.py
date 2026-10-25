"""Exercise the public compressed mask artifact, not predictor internals."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

source = Path(__file__).resolve().parents[1] / "src-tauri/scripts/subject_mask_cache.py"
spec = importlib.util.spec_from_file_location("mask_cache", source)
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


class CacheContract(unittest.TestCase):
    def test_exact_frame_ownership_survives_compression_and_empty_subject_frames(self):
        with tempfile.TemporaryDirectory() as folder:
            artifact = Path(folder) / "masks.pgmask"
            frames = [bytes([0, 0, 255, 255, 255, 0]), bytes(6), bytes([64, 64, 64, 255, 255, 0])]
            receipt = cache.write_masks(artifact, width=3, height=2, frame_count=3, frames=iter(frames))
            self.assertEqual(list(cache.read_masks(artifact, width=3, height=2, frame_count=3)), frames)
            self.assertEqual(receipt["frames"], 3)
            self.assertEqual(receipt["bytes"], artifact.stat().st_size)
            with self.assertRaises(FileExistsError):
                cache.write_masks(artifact, width=3, height=2, frame_count=3, frames=iter(frames))

    def test_partial_over_budget_and_trailing_masks_never_receive_success_receipts(self):
        with tempfile.TemporaryDirectory() as folder:
            for label, count, frames, budget in [("short", 2, [bytes(6)], 1024),
                                                ("long", 1, [bytes(6), bytes(6)], 1024),
                                                ("budget", 1, [bytes(6)], 10)]:
                with self.assertRaises(ValueError, msg=label):
                    cache.write_masks(Path(folder) / label, width=3, height=2,
                                      frame_count=count, frames=iter(frames), maximum_bytes=budget)
            good = Path(folder) / "good"
            cache.write_masks(good, width=3, height=2, frame_count=1, frames=iter([bytes(6)]))
            damaged = Path(folder) / "damaged"
            damaged.write_bytes(good.read_bytes() + b"extra")
            with self.assertRaises(ValueError):
                list(cache.read_masks(damaged, width=3, height=2, frame_count=1))
            with self.assertRaises(ValueError):
                list(cache.read_masks(good, width=4, height=2, frame_count=1))


if __name__ == "__main__":
    unittest.main()
