"""Bounded, versioned subject-mask jobs; independent of the selected model runtime."""
from typing import NamedTuple
import hashlib
import json
import math
import re

MASK_ENGINE = "sam2.1-tiny-two-object-window-v1"
MODEL_SHA256 = "7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69"


class MaskWindow(NamedTuple):
    start: int
    end: int
    owned_start: int
    owned_end: int


class DirectionalWindow(NamedTuple):
    frames: tuple[int, ...]
    owned: tuple[int, ...]
    reverse: bool


def directional_windows(frame_count: int, *, reference: int, window_frames: int = 64, overlap_frames: int = 16):
    """Lazy finite windows around a shared reference, owning that reference once."""
    if type(reference) is not int or not 0 <= reference < frame_count:
        raise ValueError("Subject reference frame is outside the exact picture schedule")
    for reverse, count in ((False, frame_count - reference), (True, reference + 1)):
        for window in plan_windows(count, window_frames=window_frames, overlap_frames=overlap_frames):
            def global_index(relative):
                return reference - relative if reverse else reference + relative
            frames = tuple(global_index(index) for index in range(window.start, window.end))
            owned = tuple(global_index(index) for index in range(window.owned_start, window.owned_end)
                          if not (reverse and index == 0))
            if owned:
                yield DirectionalWindow(frames, owned, reverse)


def _window_budget(frame_count, window_frames, overlap_frames):
    if (type(frame_count) is not int or not 0 <= frame_count <= 1_800_000
            or type(window_frames) is not int or not 4 <= window_frames <= 64
            or type(overlap_frames) is not int or not 2 <= overlap_frames < window_frames):
        raise ValueError("Invalid bounded subject-mask window budget")


def plan_windows(frame_count: int, *, window_frames: int = 64, overlap_frames: int = 16):
    """Lazy disjoint ownership and bounded lookahead, including long small-stride clips."""
    _window_budget(frame_count, window_frames, overlap_frames)
    start = 0
    while start < frame_count:
        end = min(start + window_frames, frame_count)
        owned_end = end if end == frame_count else end - overlap_frames
        yield MaskWindow(start, end, start, owned_end)
        start = owned_end


def mask_budget(*, width: int, height: int, window_frames: int = 64, overlap_frames: int = 16) -> dict:
    """Conservative admission estimate, not a measured or enforced RSS ceiling."""
    if (type(width) is not int or type(height) is not int or not 1 <= width <= 4096
            or not 1 <= height <= 4096 or width * height > 16_777_216):
        raise ValueError("Invalid bounded subject-mask picture dimensions")
    _window_budget(1, window_frames, overlap_frames)
    # Predictor input images are 1024-square RGB float32. Reserve two binary
    # overlap masks per source frame, active upsample/logits scratch and model/
    # state overhead. The native supervisor must separately measure/enforce RSS.
    estimate = (1536 * 1024 ** 2 + window_frames * 1024 * 1024 * 12
                + overlap_frames * width * height * 2 + width * height * 20)
    if estimate > 4 * 1024 ** 3:
        raise ValueError("Subject-mask window exceeds the four-GiB admission budget; reduce its size")
    return {"admissionMemoryBytes": estimate, "maximumCacheBytes": 2 * 1024 ** 3,
            "windowFrames": window_frames, "overlapFrames": overlap_frames}


def _unit(value) -> float:
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError("Subject coordinates must be finite normalized values")
    return float(value)


def reference_frame(selection):
    """Acquisition is a shared reference, not the earliest single-object correction."""
    identities = {(anchor['frame'], anchor['object']) for anchor in selection['anchors']}
    shared = sorted(frame for frame, name in identities if name == 'horse' and (frame, 'rider') in identities)
    reference = selection.get('referenceFrame', shared[0] if shared else None)
    if type(reference) is not int or reference not in shared:
        raise ValueError('Both horse and rider need anchors at the explicit reference frame')
    return reference


def selection_recipe(selection: dict, *, base_identity: str, frame_count: int, width: int, height: int,
                     window_frames: int = 64, overlap_frames: int = 16) -> tuple:
    """Freeze exact base/frame ownership and user prompts without retaining input objects."""
    mask_budget(width=width, height=height, window_frames=window_frames, overlap_frames=overlap_frames)
    if (not isinstance(selection, dict) or set(selection) - {'version', 'baseIdentity', 'frameCount', 'referenceFrame', 'anchors'}
            or type(selection.get("version")) is not int or selection["version"] != 1
            or type(frame_count) is not int or not 1 <= frame_count <= 1_800_000
            or type(selection.get("frameCount")) is not int or selection["frameCount"] != frame_count
            or not isinstance(base_identity, str) or not re.fullmatch(r"[a-f0-9]{32}|[a-f0-9]{64}", base_identity)
            or selection.get("baseIdentity") != base_identity):
        raise ValueError("Subject selection does not match this exact stabilized picture and frame count")
    saved = selection.get("anchors")
    if not isinstance(saved, list) or not 2 <= len(saved) <= 128:
        raise ValueError("Subject selection requires a bounded horse/rider anchor list")
    prompts, identities = [], set()
    total_points = 0
    for anchor in saved:
        if not isinstance(anchor, dict) or set(anchor) - {'frame', 'object', 'box', 'points'}:
            raise ValueError("Invalid subject anchor")
        frame, object_name = anchor.get("frame"), anchor.get("object")
        if type(frame) is not int or not 0 <= frame < frame_count or object_name not in ("horse", "rider"):
            raise ValueError("Invalid subject anchor frame or tracked object")
        identity = (frame, object_name)
        if identity in identities:
            raise ValueError("Duplicate subject/object anchor at the same frame")
        identities.add(identity)
        box = anchor.get("box")
        if box is not None:
            if not isinstance(box, list) or len(box) != 4:
                raise ValueError("Subject box requires four normalized coordinates")
            box = tuple(_unit(value) for value in box)
            if box[0] >= box[2] or box[1] >= box[3]:
                raise ValueError("Subject box must have positive area")
        raw_points = anchor.get("points", [])
        if not isinstance(raw_points, list) or len(raw_points) > 32:
            raise ValueError("Too many subject correction points")
        points = []
        for point in raw_points:
            if not isinstance(point, dict) or set(point) != {'x', 'y', 'include'} or type(point.get("include")) is not bool:
                raise ValueError("Subject correction requires explicit include/exclude points")
            points.append((_unit(point.get("x")), _unit(point.get("y")), point["include"]))
        total_points += len(points)
        if total_points > 512 or (box is None and not any(point[2] for point in points)):
            raise ValueError("Subject anchor requires a box or a positive point within its correction budget")
        prompts.append((frame, object_name, box, tuple(points)))
    reference = reference_frame(selection)
    generation = (1, "proxy-max1024-jpeg-q2-v1", "fp32-cpu-offload-v1", window_frames, overlap_frames,
                  "fixed-two-id-object-reacquisition-seam-v3", .6, .25, "inward-erode5-blur1-nearest-v1")
    return (1, MASK_ENGINE, MODEL_SHA256, base_identity, frame_count, width, height, generation, reference, tuple(sorted(prompts)))


def canonical_recipe(recipe: tuple) -> str:
    return json.dumps(recipe, ensure_ascii=True, allow_nan=False,separators=(",", ":"))

def mask_identity(recipe: tuple) -> str:
    return hashlib.sha256(canonical_recipe(recipe).encode("utf-8")).hexdigest()
