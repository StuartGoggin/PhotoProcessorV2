"""Unshipped external predictor adapter for the owned mask-job protocol test.

The real request admission, decode, temporal checks, cache writer and native
process owner run unchanged. Scripted model output is not footage acceptance.
"""
import argparse
import json
from pathlib import Path
import sys
import types

parser = argparse.ArgumentParser()
parser.add_argument("--generate", type=Path, required=True)
parser.add_argument("--runtime-root", type=Path, required=True)
parser.add_argument("--ffmpeg", type=Path, required=True)
parser.add_argument("--threads", type=int, required=True)
args = parser.parse_args()
assert sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode
assert "site" not in sys.modules
request = json.loads(args.generate.read_text(encoding="utf-8"))
mode = args.generate.stem
assert mode in ("adjacent-horse-only", "adjacent-both", "adjacent-stable", "seam-horse-only",
                "absence-horse-only", "absence-both", "absence-stays-absent", "absence-horse-dropout", "absence-rider-only",
                "reverse-absence-horse-only", "reverse-absence-both", "overlap-absence-horse-only",
                "handoff-remains-absent")

import torch


class ScriptedPredictor:
    def __init__(self):
        self.windows = 0

    def init_state(self, directory, **_options):
        count = len(list(Path(directory).glob("*.jpg")))
        if mode.startswith(("seam-", "overlap-", "handoff-")):
            lower = 3 * self.windows
        else:
            lower = request["selection"]["referenceFrame"] if self.windows == 0 else 0
        self.windows += 1
        return {"lower": lower, "count": count, "ordinal": self.windows}

    def add_new_points_or_box(self, state, *, frame_idx, obj_id, **_prompt):
        assert 0 <= frame_idx < state["count"] and obj_id in (1, 2)

    def add_new_mask(self, state, *, frame_idx, obj_id, mask):
        assert 0 <= frame_idx < state["count"] and obj_id in (1, 2)
        assert mask.shape == (96, 160)

    def propagate_in_video(self, state, *, start_frame_idx, max_frame_num_to_track, reverse):
        step = -1 if reverse else 1
        for local in range(start_frame_idx, start_frame_idx + step * (max_frame_num_to_track + 1), step):
            frame = state["lower"] + local
            logits = torch.full((2, 1, 96, 160), -1.0)
            if not (mode == "absence-horse-dropout" and frame == 2):
                logits[0, 0, 30:80, 20:70] = 1.0
            shift = 0
            if mode.startswith("adjacent-") and mode != "adjacent-stable" and frame >= 2:
                shift = 40  # Disjoint rider change; horse alone is corrected.
            if mode == "seam-horse-only" and state["ordinal"] == 2 and frame == 4:
                shift = 14  # IoU 26/54: below seam .6, above adjacent .25.
            absent = ((mode.startswith("absence-") and mode != "absence-horse-dropout" and frame == 2)
                      or (mode == "absence-stays-absent" and frame >= 2)
                      or (mode.startswith("reverse-absence-") and frame == 1)
                      or (mode == "overlap-absence-horse-only" and frame == 3)
                      or (mode == "handoff-remains-absent" and frame >= 3))
            if not absent:
                logits[1, 0, 5:30, 80 + shift:120 + shift] = 1.0
            yield local, [1, 2], logits


builder = types.ModuleType("sam2.build_sam")
builder.build_sam2_video_predictor = lambda *_args, **_kwargs: ScriptedPredictor()
package = types.ModuleType("sam2")
package.__path__ = []
sys.modules["sam2"] = package
sys.modules["sam2.build_sam"] = builder
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src-tauri" / "scripts"))
from subject_mask_job import generate

try:
    result = generate(request, runtime_root=args.runtime_root, ffmpeg=args.ffmpeg,
                      verify_artifacts=lambda _root: None, threads=args.threads)
    print(json.dumps(result), flush=True)
except Exception as error:
    print(json.dumps({"schema": 1, "event": "error", "message": str(error)}), file=sys.stderr)
    raise SystemExit(1) from error
