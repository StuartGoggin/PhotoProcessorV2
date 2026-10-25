"""Finite-window local mask generation. No remote inference or whole-video state."""
import ctypes
import gc
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import time

from subject_mask_cache import write_masks, read_masks, MAXIMUM_BYTES
from subject_masks_contract import directional_windows, mask_budget, mask_identity, selection_recipe, reference_frame, canonical_recipe
from subject_media_contract import validate_profile
from subject_process import bounded_process


def _checksum(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "md5").hexdigest()


def peak_working_set():
    class Counters(ctypes.Structure):
        _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
                    ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    api = ctypes.WinDLL("psapi", use_last_error=True)
    api.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(Counters), ctypes.c_ulong]
    api.GetProcessMemoryInfo.restype = ctypes.c_int
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = ctypes.c_void_p
    if not api.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
        raise ValueError("Subject-mask memory measurement is unavailable")
    return int(counters.PeakWorkingSetSize)


def _validate(request, ffmpeg):
    allowed = {"version", "sourcePath", "baseChecksum", "width", "height", "fps", "frameCount",
               "windowFrames", "overlapFrames", "destinationPath", "selection"}
    if not isinstance(request, dict) or set(request) != allowed or type(request["version"]) is not int or request["version"] != 1:
        raise ValueError("Invalid versioned mask job request")
    if not ffmpeg.is_absolute() or not ffmpeg.is_file() or ffmpeg.name.lower() != "ffmpeg.exe":
        raise ValueError("Mask jobs require an exact local FFmpeg executable")
    if not ffmpeg.with_name('ffprobe.exe').is_file():
        raise ValueError('Mask jobs require the exact local FFprobe sibling')
    source, destination = Path(request["sourcePath"]), Path(request["destinationPath"])
    if (not source.is_absolute() or not source.is_file() or not destination.is_absolute()
            or destination.exists() or not destination.parent.is_dir() or not destination.name.endswith(".partial")):
        raise ValueError("Mask job requires a local base and a new owned .partial destination")
    if (type(request["fps"]) is not int or not 1 <= request["fps"] <= 60
            or request["baseChecksum"] != _checksum(source)):
        raise ValueError("Mask job base content or CFR schedule changed")
    budget = mask_budget(width=request["width"], height=request["height"],
                         window_frames=request["windowFrames"], overlap_frames=request["overlapFrames"])
    recipe = selection_recipe(request["selection"], base_identity=request["baseChecksum"],
                              frame_count=request["frameCount"], width=request["width"], height=request["height"],
                              window_frames=request["windowFrames"], overlap_frames=request["overlapFrames"])
    probe = bounded_process([str(ffmpeg.with_name("ffprobe.exe")), "-v", "error", "-show_streams", "-of", "json", str(source)],
                            timeout=30,limit=1024*1024)
    validate_profile(json.loads(probe)['streams'],width=request['width'],height=request['height'],
                     fps=request['fps'],frame_count=request['frameCount'])
    return source, destination, recipe, budget


def decode_window(ffmpeg, source, directory, *, lower, upper, width, height, fps,threads=2):
    """Bounded original frame ownership; JPEG filenames map to lower+i exactly."""
    if (type(lower) is not int or type(upper) is not int or not 0<=lower<=upper<1_800_000
            or upper-lower+1>64 or type(fps) is not int or not 1<=fps<=60
            or type(width) is not int or type(height) is not int or not 1<=width<=1024 or not 1<=height<=1024
            or type(threads) is not int or not 1<=threads<=2 or not directory.is_dir() or any(directory.iterdir())):
        raise ValueError('Invalid finite subject-window decode request')
    bounded_process([str(ffmpeg),'-v','error','-nostdin','-n','-threads',str(threads),
        '-ss',str(lower/fps),'-noautorotate','-i',str(source),'-map','0:v:0','-an',
        '-frames:v',str(upper-lower+1),'-fps_mode','passthrough','-vf',f'scale={width}:{height},setsar=1',
        '-filter_threads','1','-threads','1','-q:v','2',str(directory/'%07d.jpg')],
        timeout=120,limit=64*1024)
    if len(list(directory.glob('*.jpg')))!=upper-lower+1:
        raise ValueError('Bounded subject window decoder failed or changed its exact frame schedule')


def generate(request, *, runtime_root, ffmpeg, verify_artifacts,threads=8):
    started = time.perf_counter()
    source, destination, recipe, budget = _validate(request, ffmpeg)
    verify_artifacts(runtime_root)
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
    import numpy as np
    import torch
    from PIL import Image, ImageFilter
    from sam2.build_sam import build_sam2_video_predictor
    if torch.__version__ not in ("2.14.1+cpu", "2.14.1+cu126"):
        raise ValueError("Mask inference requires its exact reviewed patched runtime")
    if type(threads) is not int or not 1<=threads<=8:
        raise ValueError('Mask inference requires its admitted thread bound')
    torch.set_num_threads(min(threads, max(1, os.cpu_count() or 1)))
    torch.set_num_interop_threads(1)
    if hasattr(torch.backends,'cuda'):
        torch.backends.cuda.matmul.allow_tf32=False
        torch.backends.cudnn.allow_tf32=False
    device = "cuda" if torch.cuda.is_available() else "cpu"
    predictor = build_sam2_video_predictor("configs/sam2.1/sam2.1_hiera_t.yaml",
        str(runtime_root / "models/sam2.1_hiera_tiny.pt"), device=device, apply_postprocessing=False)
    width, height = request["width"], request["height"]
    scale = min(1., 1024. / max(width, height))
    mw, mh = max(1, round(width * scale)), max(1, round(height * scale))
    reference = reference_frame(request['selection'])
    anchors = request["selection"]["anchors"]
    names = {"horse": 1, "rider": 2}
    destination.mkdir()
    owned_count = 0
    scratch_bytes = 0
    windows = 0
    peak = 0
    overlap = {}
    last_direction = None
    minimum_seam_iou = None
    verified_seam_frames = 0
    seed_frames = []
    empty_object_frames = 0
    decode_seconds = inference_seconds = 0.
    with tempfile.TemporaryDirectory(prefix="owned-", dir=destination) as scratch:
        scratch = Path(scratch)
        def owned_path(index):
            return scratch / f"{index:07d}.pgmask"

        def iou(left, right):
            union = int(np.logical_or(left, right).sum())
            return float(np.logical_and(left, right).sum()) / union if union else 1.

        for window in directional_windows(request["frameCount"], reference=reference,
                window_frames=request["windowFrames"], overlap_frames=request["overlapFrames"]):
            if last_direction != window.reverse:
                overlap = {}
            last_direction = window.reverse
            lower, upper = min(window.frames), max(window.frames)
            with tempfile.TemporaryDirectory(prefix="window-", dir=destination) as frames_dir:
                frames_dir = Path(frames_dir)
                decode_started = time.perf_counter()
                decode_window(ffmpeg,source,frames_dir,lower=lower,upper=upper,width=mw,height=mh,fps=request['fps'],threads=min(2,threads))
                decode_seconds += time.perf_counter() - decode_started
                # SAM numbers filenames by sorted position, independently of the
                # encoder's image sequence numbering. Keep explicit local/global mapping.
                inference_started = time.perf_counter()
                with torch.inference_mode():
                    state = predictor.init_state(str(frames_dir), offload_video_to_cpu=True,
                                                 offload_state_to_cpu=True, async_loading_frames=False)
                    start = window.frames[0]
                    if overlap:
                        if start not in overlap:
                            raise ValueError("Mask handoff lost its exact overlap frame")
                        for index in range(2):
                            # An empty mask is explicit absence, not appearance
                            # identity. A fresh state may not silently reacquire
                            # an occluded/offscreen object under the same label.
                            if not overlap[start][index].any():
                                raise ValueError(f"Object {index+1} needs a visible reference at frame {start}; empty window handoff cannot prove identity")
                            predictor.add_new_mask(state, frame_idx=start-lower, obj_id=index+1, mask=overlap[start][index])
                        seed_frames.append(start)
                    in_window = [anchor for anchor in anchors if lower <= anchor["frame"] <= upper]
                    for anchor in sorted(in_window, key=lambda value: (value["frame"], names[value["object"]])):
                        box = np.array(anchor["box"], dtype=np.float32) * np.array([mw, mh, mw, mh]) if anchor.get("box") else None
                        points = anchor.get("points", [])
                        predictor.add_new_points_or_box(state, frame_idx=anchor["frame"]-lower, obj_id=names[anchor["object"]],
                            box=box, points=np.array([[point["x"]*mw, point["y"]*mh] for point in points], dtype=np.float32) if points else None,
                            labels=np.array([int(point["include"]) for point in points], dtype=np.int32) if points else None,
                            clear_old_points=True)
                    expected = set(window.frames)
                    next_overlap = {}
                    observed = set()
                    previous = None
                    held_out = [0, 0]
                    for local, ids, logits in predictor.propagate_in_video(state, start_frame_idx=start-lower,
                            max_frame_num_to_track=len(window.frames)-1, reverse=window.reverse):
                        global_index = lower + local
                        if (global_index not in expected or global_index in observed or ids != [1, 2]
                                or tuple(logits.shape) != (2, 1, mh, mw) or not bool(torch.isfinite(logits).all())):
                            raise ValueError("Mask prediction changed fixed object IDs, dimensions or frame ownership")
                        observed.add(global_index)
                        masks = (logits[:, 0] > 0).cpu().numpy()
                        # A prompt changes only its named object. It must never
                        # waive the other member's independent safety checks.
                        corrected = {names[anchor["object"]] for anchor in in_window
                                     if anchor["frame"] == global_index}
                        if global_index in overlap and global_index != start:
                            for index in range(2):
                                if index + 1 in corrected:
                                    continue
                                if not masks[index].any() and not overlap[global_index][index].any():
                                    continue  # Both-empty agreement is N/A, not confidence 1.
                                score = iou(masks[index], overlap[global_index][index])
                                minimum_seam_iou = min(minimum_seam_iou, score) if minimum_seam_iou is not None else score
                                if score < .6:
                                    raise ValueError(f"Subject identity is uncertain at held-out seam frame {global_index}; add a reference correction and review, no completed masks were published")
                                held_out[index] += 1
                            verified_seam_frames += 1
                        if previous is not None:
                            for index in range(2):
                                if index + 1 in corrected:
                                    continue
                                if not previous[index].any() and masks[index].any():
                                    name = "horse" if index == 0 else "rider"
                                    direction = "reverse" if window.reverse else "forward"
                                    raise ValueError(f"Object {index+1} needs a reference correction after absence at frame {global_index} ({name}, {direction}); identity cannot be silently reacquired, no completed masks were published")
                                if previous[index].any() and masks[index].any():
                                    score = iou(previous[index], masks[index])
                                    if score < .25:
                                        name = "horse" if index == 0 else "rider"
                                        direction = "reverse" if window.reverse else "forward"
                                        raise ValueError(f"Abrupt subject-mask change at frame {global_index} ({name}, {direction}, IoU {score:.4f}); check for a cut or add a correction, no completed masks were published")
                        previous = masks
                        empty_object_frames += int(not masks[0].any() or not masks[1].any())
                        if global_index not in window.owned:
                            next_overlap[global_index] = masks.copy()
                        if global_index in window.owned:
                            union = np.logical_or(masks[0], masks[1])
                            image = Image.fromarray((union.astype(np.uint8)*255), mode="L")
                            eroded = image.filter(ImageFilter.MinFilter(5))
                            soft = np.asarray(eroded.filter(ImageFilter.GaussianBlur(1)))
                            # Feather inward only. Nothing outside either object
                            # can acquire an effect from a blurred mask edge.
                            alpha = np.where(union, soft, 0).astype(np.uint8).tobytes()
                            receipt = write_masks(owned_path(global_index), width=mw, height=mh,
                                                  frame_count=1, frames=iter([alpha]))
                            scratch_bytes += receipt["bytes"]
                            if scratch_bytes > MAXIMUM_BYTES:
                                raise ValueError("Bounded mask scratch storage exceeded its cache budget")
                            if global_index == reference:
                                Image.frombytes("L", (mw, mh), alpha).save(destination / "reference-mask.png")
                            owned_count += 1
                            print(f"frame={owned_count}\nout_time_us={round(owned_count/request['fps']*1e6)}\nprogress=continue", flush=True)
                        peak = max(peak, peak_working_set())
                        if peak > 4 * 1024 ** 3:
                            raise ValueError("Subject-mask process exceeded its four-GiB measured working-set budget")
                    if observed != expected:
                        raise ValueError("Finite mask window omitted one or more input frames")
                    if overlap and not all(held_out):
                        raise ValueError("Window handoff has no independent visible overlap evidence for both objects; add a reference or increase overlap")
                    overlap = next_overlap
                    del state, logits, masks, previous
                inference_seconds += time.perf_counter() - inference_started
                gc.collect()
                if device == "cuda":
                    torch.cuda.empty_cache()
            windows += 1
        if owned_count != request["frameCount"]:
            raise ValueError("Directional subject tracking dropped or duplicated an owned frame")
        def canonical_frames():
            for frame in range(request["frameCount"]):
                yield from read_masks(owned_path(frame), width=mw, height=mh, frame_count=1)
        mask = write_masks(destination / "masks.pgmask", width=mw, height=mh,
                           frame_count=request["frameCount"], frames=canonical_frames())
    if _checksum(source) != request["baseChecksum"]:
        raise ValueError("The stabilized base changed during subject tracking; masks were not accepted")
    manifest = {"schema": 1, "complete": True, "engine": recipe[1], "maskIdentity": mask_identity(recipe),
        "canonicalRecipe":canonical_recipe(recipe),
        "generationProfile": recipe[-3],
                "baseChecksum": request["baseChecksum"], "selection": request["selection"],
                "width": width, "height": height, "fps": request["fps"], "frames": owned_count,
                "profile": "limited-sdr709-yuv420p8", "mask": mask, "device": device,
                "windows": windows, "maximumDecodedFrames": request["windowFrames"],
                "peakWorkingSetBytes": peak, "minimumSeamIoU": minimum_seam_iou,
                "handoffSeedFrames": seed_frames, "heldOutSeamFrames": verified_seam_frames,
                "emptyObjectFrameObservations": empty_object_frames, "decodeSeconds": round(decode_seconds, 3),
                "inferenceSeconds": round(inference_seconds, 3), "secondsIncludingLoad": round(time.perf_counter()-started, 3),
                "subjectQualityAccepted": False}
    with (destination / "manifest.json").open("x", encoding="utf-8") as stream:
        json.dump(manifest, stream, allow_nan=False, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())
    print("progress=end", flush=True)
    return manifest
