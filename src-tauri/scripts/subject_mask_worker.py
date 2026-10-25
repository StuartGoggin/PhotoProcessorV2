"""Local hash-pinned subject tracking; application-owned job integration is separate."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import zipfile

SAM_COMMIT = "2b90b9f5ceec907a1c18123530e92e794ad901a4"
ARTIFACTS = {
    "models/sam2.1_hiera_tiny.pt": "7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69",
    "models/detr-no-timm/pytorch_model.bin": "883e4b0a898b87cc8ce28b33e04f86413984f67f7a44e96de5d05473bb0931b4",
    "models/detr-no-timm/config.json": "ea65a2708a8fb81c71fffb93c8f68e43b7f8f8ee7b931597e3f1a94fdf683d3b",
    "models/detr-no-timm/preprocessor_config.json": "6842c9a3895e41cfd135d0c2f925dd46a1224aeb6e943b040cf597f394a60791",
    f"sam2-{SAM_COMMIT}.zip": "fe93082a71a885a427894b1eab76341768781b6b58a298a0717e03862097d137",
}


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_sam_artifacts(root: Path) -> None:
    """Manual video selection requires SAM only, never an absent detector bypass."""
    for relative, expected in ARTIFACTS.items():
        if relative.startswith("models/detr-no-timm/"):
            continue
        path = root / relative
        if not path.is_file() or digest(path) != expected:
            raise ValueError(f"Hash-allowlisted evaluation artifact is missing or changed: {relative}")
    # Source-tree injection is rejected, not just a changed model checkpoint.
    expected_files = set()
    with zipfile.ZipFile(root / f"sam2-{SAM_COMMIT}.zip") as archive:
        prefix = f"sam2-{SAM_COMMIT}/"
        for entry in archive.infolist():
            if not entry.filename.startswith(prefix):
                raise ValueError("Unexpected evaluation source archive root")
            relative = entry.filename[len(prefix):]
            wanted = (relative.startswith("sam2/") and relative.endswith((".py", ".yaml"))) or relative in ("LICENSE", "LICENSE_cctorch")
            if not wanted:
                continue
            expected_files.add(relative)
            path = root / "vendor" / relative
            if not path.is_file() or digest(path) != hashlib.sha256(archive.read(entry)).hexdigest():
                raise ValueError("Vendored evaluation source has changed")
    actual_files = {path.relative_to(root / "vendor").as_posix() for path in (root / "vendor").rglob("*") if path.is_file()}
    if actual_files != expected_files:
        raise ValueError("Unexpected code or file in the private evaluation vendor directory")


def verify_evaluation_artifacts(root: Path) -> None:
    verify_sam_artifacts(root)
    for relative, expected in ARTIFACTS.items():
        if not relative.startswith("models/detr-no-timm/"):
            continue
        path = root / relative
        if not path.is_file() or digest(path) != expected:
            raise ValueError(f"Hash-allowlisted detector artifact is missing or changed: {relative}")


def verify_detector_inventory(detector, checkpoint: Path) -> int:
    """Independently account for every tensor; loader reports filter some keys."""
    import torch
    source = torch.load(checkpoint, map_location="cpu", weights_only=True)
    if not isinstance(source, dict) or not source:
        raise ValueError("Detector checkpoint must contain a nonempty tensor inventory")
    target = detector.state_dict()
    mapped = set()
    for original, tensor in source.items():
        if not isinstance(original, str) or not isinstance(tensor, torch.Tensor):
            raise ValueError("Unexpected detector checkpoint inventory item")
        # Pinned Transformers 5.19 DetrModel conversion_mapping.py. No fuzzy
        # suffix matches, ignored keys or opportunistic fallback mappings.
        renamed = original.replace("backbone.conv_encoder", "backbone").replace("out_proj", "o_proj")
        renamed = re.sub(r"layers\.(\d+)\.fc1", r"layers.\1.mlp.fc1", renamed)
        renamed = re.sub(r"layers\.(\d+)\.fc2", r"layers.\1.mlp.fc2", renamed)
        if renamed in mapped or renamed not in target or tuple(tensor.shape) != tuple(target[renamed].shape):
            raise ValueError(f"Unaccounted, colliding or mismatched detector tensor: {original}")
        if tensor.dtype != target[renamed].dtype or not torch.equal(tensor, target[renamed]):
            raise ValueError(f"Detector tensor values differ after pinned conversion: {original}")
        mapped.add(renamed)
    if mapped != set(target):
        raise ValueError("Detector model contains tensors absent from the verified checkpoint")
    return len(mapped)


def self_test(root: Path) -> dict:
    started = time.perf_counter()
    verify_evaluation_artifacts(root)
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
    import numpy as np
    import torch
    from PIL import Image, ImageDraw
    from transformers import AutoImageProcessor, AutoModelForObjectDetection, DetrConfig

    if torch.__version__ != "2.14.1+cpu" or importlib.metadata.version("transformers") != "5.19.0":
        raise ValueError("This evaluation profile requires its pinned patched CPU runtime")
    torch.set_num_threads(min(8, max(1, os.cpu_count() or 1)))
    torch.set_num_interop_threads(1)

    detector_dir = root / "models/detr-no-timm"
    # This hash-allowlisted legacy config represents an undilated ResNet.
    # Transformers 5 validates the old null boolean strictly. Normalize only
    # that known historical field in memory, never alter downloaded metadata.
    detector_config = json.loads((detector_dir / "config.json").read_text(encoding="utf-8"))
    if detector_config.get("model_type") != "detr" or detector_config.get("use_timm_backbone") is not False or detector_config.get("backbone_config", {}).get("model_type") != "resnet":
        raise ValueError("Unexpected hash-verified no-timm detector architecture")
    if detector_config.get("dilation") is None:
        detector_config["dilation"] = False
    detector_config = DetrConfig.from_dict(detector_config)
    detector, loading = AutoModelForObjectDetection.from_pretrained(
        detector_dir, local_files_only=True, trust_remote_code=False,
        use_safetensors=False, output_loading_info=True, config=detector_config,
        weights_only=True, ignore_mismatched_sizes=False,
    )
    if any(loading.get(field) for field in ("missing_keys", "unexpected_keys", "mismatched_keys", "error_msgs")):
        raise ValueError("Detector checkpoint/config mapping needs validation before inference")
    detector_tensors = verify_detector_inventory(detector, detector_dir / "pytorch_model.bin")
    detector.eval()
    processor = AutoImageProcessor.from_pretrained(detector_dir, local_files_only=True, use_fast=False)
    sample = Image.new("RGB", (320, 192), (112, 124, 128))
    drawing = ImageDraw.Draw(sample)
    drawing.rectangle((96, 40, 224, 164), fill=(180, 96, 64))
    drawing.rectangle((136, 18, 184, 52), fill=(64, 96, 180))
    with torch.inference_mode():
        result = detector(**processor(images=sample, return_tensors="pt"))
    if not bool(torch.isfinite(result.logits).all()) or not bool(torch.isfinite(result.pred_boxes).all()):
        raise ValueError("Detector produced nonfinite outputs")
    del detector, result

    frames = sam_window_self_test(root, sample)
    return {
        "schema": 1, "evaluationOnly": True, "modelHashesVerified": True,
        "device": "cpu", "detectorExecuted": True, "frames": frames,
        "detectorTensorInventory": detector_tensors,
        "detectorWeightsExact": True, "trackedObjects": ["horse", "rider"],
        "finiteMasks": True, "secondsIncludingLoad": round(time.perf_counter() - started, 3),
        "subjectQualityAccepted": False,
    }


def sam_window_self_test(root: Path, sample) -> int:
    import numpy as np
    import torch
    from PIL import ImageDraw
    sys.path.insert(0, str(root / "vendor"))
    from sam2.build_sam import build_sam2_video_predictor
    predictor = build_sam2_video_predictor(
        "configs/sam2.1/sam2.1_hiera_t.yaml", str(root / "models/sam2.1_hiera_tiny.pt"),
        device="cpu", apply_postprocessing=False,
    )
    frames = []
    with tempfile.TemporaryDirectory(prefix="mask-self-test-", dir=root) as directory:
        frame_dir = Path(directory)
        for frame in range(2):
            image = sample.copy()
            ImageDraw.Draw(image).rectangle((96 + frame * 2, 40, 224 + frame * 2, 164), fill=(180, 96, 64))
            image.save(frame_dir / f"{frame:06d}.jpg", quality=95)
        with torch.inference_mode():
            state = predictor.init_state(str(frame_dir), offload_video_to_cpu=True, offload_state_to_cpu=True, async_loading_frames=False)
            predictor.add_new_points_or_box(state, frame_idx=0, obj_id=1, box=np.array([96, 40, 224, 164], dtype=np.float32))
            predictor.add_new_points_or_box(state, frame_idx=0, obj_id=2, box=np.array([136, 18, 184, 52], dtype=np.float32))
            for index, ids, logits in predictor.propagate_in_video(state, start_frame_idx=0, max_frame_num_to_track=1):
                if ids != [1, 2] or tuple(logits.shape) != (2, 1, 192, 320) or not bool(torch.isfinite(logits).all()):
                    raise ValueError("Finite-window mask output contract failed")
                frames.append(index)
        if frames != [0, 1]:
            raise ValueError("Finite-window inference dropped or duplicated frame identity")
    return len(frames)


def verify_manual_startup() -> None:
    if not sys.flags.isolated or not sys.flags.no_site or not sys.dont_write_bytecode:
        raise ValueError("Manual inference requires isolated, no-site, no-bytecode startup")
    if "site" in sys.modules or "_distutils_hack" in sys.modules:
        raise ValueError("Manual inference refused package startup hooks; use the sealed no-site runtime")


def manual_self_test(root: Path) -> dict:
    started = time.perf_counter()
    verify_manual_startup()
    verify_sam_artifacts(root)
    import torch
    from PIL import Image, ImageDraw
    if torch.__version__ != "2.14.1+cpu":
        raise ValueError("Manual CPU profile requires its exact pinned patched runtime")
    torch.set_num_threads(min(8, max(1, os.cpu_count() or 1)))
    torch.set_num_interop_threads(1)
    sample = Image.new("RGB", (320, 192), (112, 124, 128))
    drawing = ImageDraw.Draw(sample)
    drawing.rectangle((96, 40, 224, 164), fill=(180, 96, 64))
    drawing.rectangle((136, 18, 184, 52), fill=(64, 96, 180))
    frames = sam_window_self_test(root, sample)
    excluded = sorted(name for name in ("torchvision", "transformers", "huggingface_hub", "tokenizers") if name in sys.modules)
    if excluded:
        raise ValueError(f"Manual video runtime unexpectedly imported excluded components: {excluded}")
    verify_manual_startup()
    return {
        "schema": 1, "evaluationOnly": True, "modelHashesVerified": True,
        "profile": "manual-video-cpu-v1", "device": "cpu", "detectorExecuted": False, "frames": frames,
        "excludedComponentsImported": excluded, "trackedObjects": ["horse", "rider"],
        "finiteMasks": True, "startupHooks": False, "secondsIncludingLoad": round(time.perf_counter() - started, 3),
        "subjectQualityAccepted": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--self-test", type=Path)
    mode.add_argument("--manual-self-test", type=Path)
    mode.add_argument("--generate", type=Path)
    parser.add_argument("--runtime-root", type=Path)
    parser.add_argument("--ffmpeg", type=Path)
    parser.add_argument("--threads",type=int,default=8)
    args = parser.parse_args()
    try:
        if args.self_test:
            result = self_test(args.self_test.resolve())
        elif args.manual_self_test:
            result = manual_self_test(args.manual_self_test.resolve())
        else:
            verify_manual_startup()
            if not args.runtime_root or not args.ffmpeg or args.generate.stat().st_size > 128 * 1024:
                raise ValueError("A bounded mask request requires its local runtime and FFmpeg")
            root = args.runtime_root.resolve()
            # Exact application-owned siblings and a hash-verified vendor tree;
            # isolated Python never searches the user's current working folder.
            verify_sam_artifacts(root)
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            sys.path.insert(0, str(root / "vendor"))
            from subject_mask_job import generate
            result = generate(json.loads(args.generate.read_text(encoding="utf-8")), runtime_root=root,
                              ffmpeg=args.ffmpeg, verify_artifacts=verify_sam_artifacts,threads=args.threads)
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({"schema": 1, "event": "error", "message": str(error)}), file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
