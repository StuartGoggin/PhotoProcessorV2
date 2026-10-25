"""Public job-planning tests: no model, media or mock inference is involved."""
import importlib.util
from pathlib import Path
import unittest
import copy
import inspect

module_path = Path(__file__).resolve().parents[1] / "src-tauri/scripts/subject_masks_contract.py"
spec = importlib.util.spec_from_file_location("subject_masks_contract", module_path)
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)


class WindowOwnership(unittest.TestCase):
    def test_later_reference_has_disjoint_directional_ownership_without_missing_opening_frames(self):
        windows = contract.directional_windows(100, reference=37, window_frames=16, overlap_frames=4)
        owned = [index for window in windows for index in window.owned]
        self.assertEqual(sorted(owned), list(range(100)))
        self.assertEqual(len(set(owned)), 100)
        for window in windows:
            self.assertLessEqual(len(window.frames), 16)
            self.assertTrue(set(window.owned).issubset(window.frames))
            self.assertEqual(len(set(window.frames)), len(window.frames))

    def test_short_tail_and_long_clips_have_one_owner_per_frame(self):
        for count in (0, 1, 15, 64, 65, 100, 1000, 100_000):
            windows = contract.plan_windows(count, window_frames=64, overlap_frames=16)
            owned = [frame for window in windows for frame in range(window.owned_start, window.owned_end)]
            self.assertEqual(owned, list(range(count)))
            for window in windows:
                self.assertLessEqual(window.end - window.start, 64)
                self.assertLessEqual(window.start, window.owned_start)
                self.assertLessEqual(window.owned_end, window.end)

    def test_invalid_budgets_are_rejected_before_decode(self):
        for count, frames, overlap in ((-1, 64, 16), (1_800_001, 64, 16), (50, 0, 0), (50, 128, 16), (50, 64, 1), (50, 64, 64)):
            with self.assertRaises(ValueError):
                list(contract.plan_windows(count, window_frames=frames, overlap_frames=overlap))

    def test_planner_is_lazy_for_maximum_length_small_stride(self):
        windows = contract.plan_windows(1_800_000, window_frames=4, overlap_frames=2)
        self.assertTrue(inspect.isgenerator(windows))
        self.assertEqual(next(windows), contract.MaskWindow(0, 4, 0, 2))


class CorrectableSelection(unittest.TestCase):
    def selection(self):
        return {"version": 1, "baseIdentity": "a" * 32, "frameCount": 100,
                "anchors": [{"frame": 0, "object": "horse", "box": [0.2, 0.3, 0.8, 0.9]},
                            {"frame": 0, "object": "rider", "box": [0.4, 0.1, 0.6, 0.5]},
                            {"frame": 48, "object": "horse", "points": [{"x": 0.5, "y": 0.6, "include": True}]}]}

    def test_recipe_tracks_selection_not_stabilization_and_is_an_immutable_snapshot(self):
        saved = self.selection()
        recipe = contract.selection_recipe(saved, base_identity="a" * 32, frame_count=100, width=3840, height=2160)
        before = contract.mask_identity(recipe)
        saved["anchors"][0]["box"][0] = 0.1
        self.assertEqual(contract.mask_identity(recipe), before)
        updated = contract.selection_recipe(saved, base_identity="a" * 32, frame_count=100, width=3840, height=2160)
        self.assertNotEqual(contract.mask_identity(updated), before)

    def test_both_objects_and_exact_base_frame_identity_are_required(self):
        for mutate in (
            lambda value: value.update(baseIdentity="b" * 32),
            lambda value: value.update(frameCount=99),
            lambda value: value["anchors"].pop(1),
            lambda value: value["anchors"].append(copy.deepcopy(value["anchors"][0])),
            lambda value: value["anchors"][0].update(frame=True),
            lambda value: value["anchors"][0].update(frame=100),
            lambda value: value["anchors"][0].update(box=[0.8, 0.3, 0.2, 0.9]),
            lambda value: value["anchors"][0].update(box=[-1, 0, 1, 1]),
            lambda value: value["anchors"][0].update(object="background"),
            lambda value: value["anchors"][2]["points"][0].update(x=float("nan")),
            lambda value: value["anchors"][2]["points"][0].update(include="yes"),
        ):
            saved = self.selection()
            mutate(saved)
            with self.assertRaises(ValueError):
                contract.selection_recipe(saved, base_identity="a" * 32, frame_count=100, width=3840, height=2160)

    def test_reference_may_be_chosen_after_an_empty_opening(self):
        saved = self.selection()
        saved["anchors"][0]["frame"] = saved["anchors"][1]["frame"] = 10
        recipe = contract.selection_recipe(saved, base_identity="a" * 32, frame_count=100, width=3840, height=2160)
        self.assertEqual(recipe[-1][0][0], 10)

    def test_explicit_later_reference_preserves_an_earlier_single_object_correction(self):
        saved = self.selection()
        saved['anchors'][0]['frame'] = saved['anchors'][1]['frame'] = 10
        saved['anchors'][2]['frame'] = 2
        saved['referenceFrame'] = 10
        recipe = contract.selection_recipe(saved, base_identity='a'*32, frame_count=100, width=3840, height=2160)
        self.assertEqual(contract.reference_frame(saved), 10)
        self.assertEqual(recipe[-2], 10)
        for reference in (True, 2, 100):
            saved['referenceFrame'] = reference
            with self.assertRaises(ValueError):
                contract.selection_recipe(saved, base_identity='a'*32, frame_count=100, width=3840, height=2160)

    def test_unknown_selection_anchor_or_point_fields_are_rejected(self):
        for mutate in (
            lambda value: value.update(extra='ignored'),
            lambda value: value['anchors'][0].update(extra='ignored'),
            lambda value: value['anchors'][2]['points'][0].update(extra='ignored'),
        ):
            saved = self.selection(); mutate(saved)
            with self.assertRaises(ValueError):
                contract.selection_recipe(saved, base_identity='a'*32, frame_count=100, width=3840, height=2160)

    def test_mask_windows_and_cache_have_explicit_admission_budgets(self):
        budget = contract.mask_budget(width=3840, height=2160, window_frames=64, overlap_frames=16)
        self.assertGreaterEqual(budget["admissionMemoryBytes"], 1024 ** 3)
        self.assertLessEqual(budget["admissionMemoryBytes"], 4 * 1024 ** 3)
        for width, height, frames, overlap in ((0, 2160, 64, 16), (7680, 4320, 64, 16), (3840, 2160, 256, 16), (3840, 2160, 64, 64)):
            with self.assertRaises(ValueError):
                contract.mask_budget(width=width, height=height, window_frames=frames, overlap_frames=overlap)

    def test_generation_window_profile_changes_mask_identity(self):
        saved = self.selection()
        default = contract.selection_recipe(saved, base_identity="a"*32, frame_count=100, width=3840, height=2160)
        smaller = contract.selection_recipe(saved, base_identity="a"*32, frame_count=100, width=3840, height=2160,
                                            window_frames=16, overlap_frames=4)
        self.assertNotEqual(contract.mask_identity(default), contract.mask_identity(smaller))

    def test_object_reacquisition_checks_have_a_distinct_generation_identity(self):
        recipe = contract.selection_recipe(self.selection(), base_identity="a"*32,
                                           frame_count=100, width=3840, height=2160)
        self.assertEqual(recipe[7][5], "fixed-two-id-object-reacquisition-seam-v3")
        for old_policy in ("fixed-two-id-held-out-seam-v1", "fixed-two-id-object-corrections-seam-v2"):
            old_generation = (*recipe[7][:5], old_policy, *recipe[7][6:])
            old_recipe = (*recipe[:7], old_generation, *recipe[8:])
            self.assertNotEqual(contract.mask_identity(recipe), contract.mask_identity(old_recipe))


if __name__ == "__main__":
    unittest.main()
