"""Qualification-only eager encoder measurement; never a production runtime mode."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument("--runtime-root", type=Path, required=True)
parser.add_argument("--source", type=Path, required=True)
parser.add_argument("--ffmpeg", type=Path, required=True)
parser.add_argument("--threads", type=int, choices=(4, 8), required=True)
parser.add_argument("--receipt", type=Path, required=True)
parser.add_argument("--tracking", action="store_true")
parser.add_argument("--attention", action="store_true")
args = parser.parse_args()
if args.attention and not args.tracking:
    raise ValueError("Attention diagnostics require the unchanged mature tracking fixture")
root = args.runtime_root.resolve(strict=True)
if not sys.flags.isolated or not sys.flags.no_site or not sys.dont_write_bytecode:
    raise ValueError("Encoder diagnostics require the isolated no-site interpreter")
seal = hashlib.sha256((root / "runtime-manifest.json").read_bytes()).hexdigest()
if seal != "3305693bb725b3d003c25381d3c02e381646fec5ee7dbad483f21e36448b2c78":
    raise ValueError("This probe requires the unchanged qualification pack")
checkpoint = root / "models/sam2.1_hiera_tiny.pt"
with checkpoint.open("rb") as stream:
    model_hash = hashlib.file_digest(stream, "sha256").hexdigest()
if model_hash != "7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69":
    raise ValueError("Unexpected encoder checkpoint")
sys.path.insert(0, str(root / "vendor"))
import torch
from sam2.build_sam import build_sam2_video_predictor
from sam2.utils.misc import _load_img_as_tensor

if torch.__version__ != "2.14.1+cpu":
    raise ValueError("This diagnostic does not substitute another Torch build")
torch.set_num_threads(min(args.threads, max(1, os.cpu_count() or 1)))
torch.set_num_interop_threads(1)
if torch.backends.cuda.is_built() or torch.version.cuda is not None:
    raise ValueError("CPU probe cannot qualify a CUDA backend")
print(json.dumps({"event": "setup", "threads": torch.get_num_threads()}), flush=True)
# Identical proxy dimensions, JPEG quality and pinned SAM preprocessing. One
# fixed frame, decoded once, is excluded from every timed encoder call.
decoded = subprocess.run([str(args.ffmpeg.resolve(strict=True)), "-v", "error", "-nostdin", "-threads", "2",
    "-ss", "0.5", "-noautorotate", "-i", str(args.source.resolve(strict=True)), "-map", "0:v:0", "-an",
    "-frames:v", "1", "-vf", "scale=1024:576,setsar=1", "-filter_threads", "1", "-threads", "1", "-q:v", "2",
    "-c:v", "mjpeg", "-f", "image2pipe", "-"], capture_output=True, timeout=20, check=True)
if not 0 < len(decoded.stdout) <= 2 * 1024 * 1024:
    raise ValueError("Diagnostic proxy exceeds its fixed frame bound")
x, height, width = _load_img_as_tensor(io.BytesIO(decoded.stdout), 1024)
x = x.float()
x -= torch.tensor((0.485, 0.456, 0.406), dtype=torch.float32)[:, None, None]
x /= torch.tensor((0.229, 0.224, 0.225), dtype=torch.float32)[:, None, None]
x = x.unsqueeze(0).contiguous()
input_hash = hashlib.sha256(x.numpy().tobytes()).hexdigest()
load_began = time.perf_counter()
predictor = build_sam2_video_predictor("configs/sam2.1/sam2.1_hiera_t.yaml", str(checkpoint),
    device="cpu", apply_postprocessing=False)
load_seconds = time.perf_counter() - load_began
measurements = []
tracking = None
with torch.inference_mode():
    if args.tracking:
        import importlib.util
        spec = importlib.util.spec_from_file_location("tracking_probe", Path(__file__).with_name("probe-sam-tracking.py"))
        probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)
        tracking = probe.measure(predictor, x, height, width, torch, attention_probe=args.attention)
    for attempt in range(0 if args.tracking else 4):
        wall, cpu = time.perf_counter(), time.process_time()
        result = predictor.forward_image(x)  # Never the last-frame feature cache.
        elapsed, consumed = time.perf_counter() - wall, time.process_time() - cpu
        leaves = []
        def inspect(value):
            if isinstance(value, torch.Tensor):
                if not bool(torch.isfinite(value).all()):
                    raise ValueError("Nonfinite encoder output")
                leaves.append({"shape": list(value.shape), "dtype": str(value.dtype),
                    "sha256": hashlib.sha256(value.contiguous().numpy().tobytes()).hexdigest()})
            elif isinstance(value, dict):
                for item in value.values(): inspect(item)
            elif isinstance(value, (list, tuple)):
                for item in value: inspect(item)
            elif value is not None:
                raise ValueError("Unexpected encoder result field")
        inspect(result)
        if not leaves: raise ValueError("Encoder produced no tensor result")
        measurements.append({"warmup": attempt == 0, "wallSeconds": elapsed, "processCpuSeconds": consumed, "outputs": leaves})
        print(json.dumps({"event": "encoder", "attempt": attempt, "wallSeconds": elapsed, "processCpuSeconds": consumed}), flush=True)
        del result
receipt = {"schema": 1, "diagnosticOnly": True, "maskQualityAccepted": False, "runtimeSeal": seal,
    "modelSha256": model_hash, "configSha256": hashlib.sha256((root / "vendor/sam2/configs/sam2.1/sam2.1_hiera_t.yaml").read_bytes()).hexdigest(),
    "torch": torch.__version__, "torchGit": torch.version.git_version, "build": torch.__config__.show(),
    "parallel": torch.__config__.parallel_info(), "intraThreads": torch.get_num_threads(), "interThreads": torch.get_num_interop_threads(),
    "mkldnnAvailable": torch.backends.mkldnn.is_available(), "mkldnnEnabled": torch.backends.mkldnn.enabled,
    "environment": {key: os.environ.get(key) for key in ("OMP_NUM_THREADS", "MKL_NUM_THREADS")},
    "input": {"proxySha256": hashlib.sha256(decoded.stdout).hexdigest(), "proxyWidth": width, "proxyHeight": height,
        "tensorSha256": input_hash, "shape": list(x.shape), "strides": list(x.stride()), "dtype": str(x.dtype)},
    "loadSeconds": load_seconds, "measurements": measurements,
    "medianWallSeconds": tracking["medianWallSeconds"] if tracking else statistics.median(m["wallSeconds"] for m in measurements[1:]),
    "limitations": "Encoder plus feature projections only; no mature tracking, mask quality or GPU qualification."}
if tracking:
    receipt["tracking"] = tracking
    receipt["limitations"] = tracking["limitations"]
with args.receipt.open("x", encoding="utf-8") as stream:
    json.dump(receipt, stream, indent=2)
print(json.dumps({"event": "complete", "medianWallSeconds": receipt["medianWallSeconds"]}), flush=True)
