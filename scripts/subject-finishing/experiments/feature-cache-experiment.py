"""Disposable observation/adapter around SAM; never shipped or sealed in a pack.

Fresh states and propagation remain owned by subject_mask_job.generate. Only
completed, immutable image-backbone outputs can cross an eligible overlap.
"""
import argparse
from collections import OrderedDict
import hashlib
import json
import os
from pathlib import Path
import sys
import time

MIB = 1024 ** 2
STORAGE_LIMIT = 512 * MIB
SINGLE_OUTPUT_LIMIT = 128 * MIB


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class FeatureExperiment:
    def __init__(self, predictor, request, runtime, torch, enabled, tail_failure=False):
        from subject_masks_contract import directional_windows, reference_frame, mask_budget
        if (torch.__version__ != "2.14.1+cpu" or torch.cuda.is_available()
                or torch.get_num_threads() != 8 or predictor.training
                or request["frameCount"] > 100
                or (request["windowFrames"], request["overlapFrames"]) not in ((4, 2), (16, 4))):
            raise ValueError("Diagnostic adapter requires the fixed small CPU FP32 profiles")
        budget = mask_budget(width=request["width"], height=request["height"],
                            window_frames=request["windowFrames"], overlap_frames=request["overlapFrames"])
        # Reserve retained storage plus insertion and delivery clones. This is
        # only an admission estimate; the owner still enforces its 4-GiB job cap.
        self.admission = budget["admissionMemoryBytes"] + STORAGE_LIMIT + 2*SINGLE_OUTPUT_LIMIT
        if self.admission > 4*1024**3:
            raise ValueError("Diagnostic feature cache cannot fit its additional memory allowance")
        self.predictor, self.torch, self.enabled = predictor, torch, enabled
        self.tail_failure = tail_failure
        self.plan = list(directional_windows(request["frameCount"], reference=reference_frame(request["selection"]),
                    window_frames=request["windowFrames"], overlap_frames=request["overlapFrames"]))
        self.limit = min(4, request["overlapFrames"])
        self.scope = (request["baseChecksum"], file_hash(runtime/"runtime-manifest.json"),
                      file_hash(runtime/"models/sam2.1_hiera_tiny.pt"),
                      file_hash(runtime/"vendor/sam2/configs/sam2.1/sam2.1_hiera_t.yaml"),
                      torch.__version__, "cpu", "float32", 8)
        self.retained = OrderedDict()
        self.windows, self.visits, self.inputs = [], [], {}
        self.index, self.state_id, self.lower = -1, None, None
        self.incoming, self.outgoing = set(), set()
        self.stats = {"enabled": enabled, "hits": 0, "encoderCalls": 0, "evictions": 0,
                      "maximumEntries": 0, "maximumStorageBytes": 0,
                      "encoderSeconds": 0., "adapterSeconds": 0., "integrityChecksPassed": False, "hitFrames": []}
        self.originals = {}

    def tensor_hash(self, value):
        if value.device.type != "cpu":
            raise ValueError("Diagnostic tensor left the admitted CPU profile")
        return hashlib.sha256(value.detach().contiguous().view(self.torch.uint8).numpy().tobytes()).hexdigest()

    def describe(self, value, memo=None):
        memo = {} if memo is None else memo
        if isinstance(value, self.torch.Tensor):
            identity = id(value)
            if identity in memo:
                return {"alias": memo[identity]}
            memo[identity] = len(memo)
            return {"tensor": memo[identity], "shape": list(value.shape), "stride": list(value.stride()),
                    "dtype": str(value.dtype), "sha256": self.tensor_hash(value)}
        if isinstance(value, dict):
            return {str(key): self.describe(item, memo) for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))}
        if isinstance(value, (tuple, list)):
            return [self.describe(item, memo) for item in value]
        if value is None or isinstance(value, (str, bool, int, float)):
            return value
        raise ValueError("Unexpected observational tensor tree")

    def storage_bytes(self, value, storages=None):
        storages = {} if storages is None else storages
        if isinstance(value, self.torch.Tensor):
            storage = value.untyped_storage()
            prior = storages.get(storage.data_ptr())
            if prior is not None and prior != id(value):
                raise ValueError("Unreviewed distinct tensor views share output storage")
            storages[storage.data_ptr()] = id(value)
            return storage.nbytes() if prior is None else 0
        if isinstance(value, dict):
            return sum(self.storage_bytes(item, storages) for item in value.values())
        if isinstance(value, (tuple, list)):
            return sum(self.storage_bytes(item, storages) for item in value)
        if value is None:
            return 0
        raise ValueError("Unexpected completed backbone output")

    def clone(self, value, memo=None):
        memo = {} if memo is None else memo
        if isinstance(value, self.torch.Tensor):
            if id(value) not in memo:
                memo[id(value)] = value.detach().clone(memory_format=self.torch.preserve_format)
            return memo[id(value)]
        if isinstance(value, dict):
            return {key: self.clone(item, memo) for key, item in value.items()}
        if isinstance(value, list):
            return [self.clone(item, memo) for item in value]
        if isinstance(value, tuple):
            return tuple(self.clone(item, memo) for item in value)
        if value is None:
            return None
        raise ValueError("Unexpected cache output")

    def check_integrity(self):
        for output, expected, _ in self.retained.values():
            if self.describe(output) != expected:
                raise ValueError("A retained image-feature snapshot was mutated")

    def forward_image(self, image):
        started = time.perf_counter()
        result = self.originals["forward_image"](image)
        self.stats["encoderSeconds"] += time.perf_counter()-started
        self.stats["encoderCalls"] += 1
        return result

    def init_state(self, *args, **kwargs):
        self.check_integrity()
        self.index += 1
        if self.index >= len(self.plan):
            raise ValueError("Generator created an unexpected extra temporal window")
        window = self.plan[self.index]
        previous = self.plan[self.index-1] if self.index else None
        self.incoming = (set(previous.frames)-set(previous.owned)) & set(window.frames) if previous and previous.reverse == window.reverse else set()
        following = self.plan[self.index+1] if self.index+1 < len(self.plan) else None
        self.outgoing = (set(window.frames)-set(window.owned)) & set(following.frames) if following and following.reverse == window.reverse else set()
        # Clear on direction changes; remove everything that cannot be a handoff.
        for key in list(self.retained):
            if key[1] not in self.incoming:
                del self.retained[key]
        self.lower = min(window.frames)
        self.state_id = None  # Warmup occurs inside the original init_state call.
        state = self.originals["init_state"](*args, **kwargs)
        if state["num_frames"] != len(window.frames) or state["device"].type != "cpu":
            raise ValueError("Initialized state changed the expected window or device")
        # Keep an identity guard, not a strong state/window-image reference.
        self.state_id = id(state)
        self.windows.append({"index": self.index, "reverse": window.reverse, "frames": list(window.frames),
                             "owned": list(window.owned), "incoming": sorted(self.incoming), "outgoing": sorted(self.outgoing)})
        return state

    def get_image_feature(self, state, frame_idx, batch_size):
        if self.state_id is not None and id(state) != self.state_id:
            raise ValueError("Unexpected inference-state reuse")
        if frame_idx not in range(len(self.plan[self.index].frames)):
            raise ValueError("Image feature request is outside the current decoded window")
        # Preserve SAM's ordinary current-picture fast path.
        if state["cached_features"].get(frame_idx, (None, None))[1] is not None:
            return self.originals["_get_image_feature"](state, frame_idx, batch_size)
        started = time.perf_counter()
        image = state["images"][frame_idx].to(state["device"]).float().unsqueeze(0)
        if image.dtype != self.torch.float32 or image.shape != (1, 3, 1024, 1024) or not image.is_contiguous():
            raise ValueError("Input left the exact normalized CPU FP32 layout")
        global_frame = self.lower+frame_idx
        digest = self.tensor_hash(image)
        if global_frame in self.inputs and self.inputs[global_frame] != digest:
            raise ValueError("The same global picture decoded to different normalized bytes")
        self.inputs[global_frame] = digest
        key = (self.scope, global_frame, digest, tuple(image.shape), tuple(image.stride()))
        if self.enabled and global_frame in self.incoming and key in self.retained:
            output, expected, _ = self.retained[key]
            if self.describe(output) != expected:
                raise ValueError("Retained feature integrity failed before delivery")
            delivered = self.clone(output)
            if self.describe(delivered) != expected:
                raise ValueError("Feature delivery changed layout, aliases or bytes")
            # Fresh input belongs to this state. Never retain its decoded-window view.
            state["cached_features"] = {frame_idx: (image, delivered)}
            self.retained.move_to_end(key)
            self.stats["hits"] += 1
            self.stats["hitFrames"].append({"window": self.index, "globalFrame": global_frame})
            print(json.dumps({"event": "featureCacheHit", "window": self.index, "globalFrame": global_frame}), flush=True)
        self.stats["adapterSeconds"] += time.perf_counter()-started
        result = self.originals["_get_image_feature"](state, frame_idx, batch_size)
        if self.enabled and global_frame in self.outgoing and key not in self.retained:
            started = time.perf_counter()
            output = state["cached_features"][frame_idx][1]
            storage = self.storage_bytes(output)
            if storage <= SINGLE_OUTPUT_LIMIT:
                while self.retained and (len(self.retained) >= self.limit or
                      sum(entry[2] for entry in self.retained.values())+storage > STORAGE_LIMIT):
                    self.retained.popitem(last=False)
                    self.stats["evictions"] += 1
                snapshot = self.clone(output)
                expected = self.describe(output)
                if self.describe(snapshot) != expected or self.storage_bytes(snapshot) != storage:
                    raise ValueError("Feature insertion changed aliases, layout, bytes or storage")
                self.retained[key] = (snapshot, expected, storage)
                self.stats["maximumEntries"] = max(self.stats["maximumEntries"], len(self.retained))
                self.stats["maximumStorageBytes"] = max(self.stats["maximumStorageBytes"], sum(entry[2] for entry in self.retained.values()))
            self.stats["adapterSeconds"] += time.perf_counter()-started
        return result

    def propagate(self, state, *args, **kwargs):
        window = self.plan[self.index]
        if self.state_id != id(state):
            raise ValueError("Propagation did not use the freshly initialized state")
        try:
            for local, ids, logits in self.originals["propagate_in_video"](state, *args, **kwargs):
                current = {}
                for index, outputs in state["output_dict_per_obj"].items():
                    groups = [outputs[group][local] for group in ("cond_frame_outputs", "non_cond_frame_outputs") if local in outputs[group]]
                    if len(groups) != 1:
                        raise ValueError("Tracking observation lacks one unambiguous current output")
                    current[index] = groups[0]
                self.visits.append({"window": self.index, "reverse": window.reverse, "globalFrame": self.lower+local,
                                    "ids": list(ids), "logits": self.describe(logits), "newMemoryAndOutput": self.describe(current)})
                yield local, ids, logits
            # This executes before the unchanged generator writes its manifest.
            self.check_integrity()
            if self.tail_failure and self.index+1 == len(self.plan):
                print(json.dumps({"event": "featureCacheTailFailure", "window": self.index}), flush=True)
                raise ValueError("Injected diagnostic failure after the last valid frame")
        finally:
            self.state_id = None

    def install(self):
        wrappers = {"init_state": self.init_state, "_get_image_feature": self.get_image_feature,
                    "forward_image": self.forward_image, "propagate_in_video": self.propagate}
        for name in wrappers:
            if name in self.predictor.__dict__:
                raise ValueError("Diagnostic predictor already has a replaced method")
        for name, wrapper in wrappers.items():
            self.originals[name] = getattr(self.predictor, name)
            setattr(self.predictor, name, wrapper)

    def close(self, complete):
        try:
            if complete:
                self.check_integrity()
                if self.index+1 != len(self.plan):
                    raise ValueError("Generator omitted planned temporal windows")
                self.stats["integrityChecksPassed"] = True
        finally:
            for name in self.originals:
                delattr(self.predictor, name)
            self.retained.clear()
            self.state_id = None

    def report(self):
        return {"schema": 1, "diagnosticOnly": True, "qualityAccepted": False, "exportQualified": False,
                "scope": list(self.scope), "admissionEstimateIncludingCacheBytes": self.admission,
                "persistentByteLimit": STORAGE_LIMIT, "entryLimit": self.limit, "cache": self.stats,
                "windows": self.windows, "visits": self.visits,
                "inputIdentities": [{"globalFrame": key, "sha256": value} for key, value in sorted(self.inputs.items())],
                "limits": "Only completed image features cross overlaps; masks, logits and temporal state are recomputed. CPU diagnostic, not app acceptance."}


def main(cache_enabled, tail_failure=False):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generate", type=Path, required=True)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=8)
    args = parser.parse_args()
    adapters = []
    original_factory = None
    try:
        app = Path(__file__).resolve().parents[3]/"src-tauri/scripts"
        sys.path.insert(0, str(app))
        from subject_mask_worker import verify_manual_startup, verify_sam_artifacts
        verify_manual_startup()
        if args.generate.stat().st_size > 128*1024 or args.threads != 8:
            raise ValueError("Diagnostic requires the bounded request and fixed thread profile")
        runtime = args.runtime_root.resolve()
        verify_sam_artifacts(runtime)
        sys.path.insert(0, str(runtime/"vendor"))
        import torch
        import sam2.build_sam as sam_build
        from subject_mask_job import generate
        request = json.loads(args.generate.read_text(encoding="utf-8"))
        original_factory = sam_build.build_sam2_video_predictor
        def factory(*factory_args, **factory_kwargs):
            if adapters:
                raise ValueError("Diagnostic requires exactly one predictor instance")
            predictor = original_factory(*factory_args, **factory_kwargs)
            adapter = FeatureExperiment(predictor, request, runtime, torch, cache_enabled, tail_failure)
            adapter.install()
            adapters.append(adapter)
            return predictor
        sam_build.build_sam2_video_predictor = factory
        result = generate(request, runtime_root=runtime, ffmpeg=args.ffmpeg,
                          verify_artifacts=verify_sam_artifacts, threads=args.threads)
        adapters[0].close(complete=True)
        report = adapters[0].report()
        with (Path(request["destinationPath"])/"encoder-diagnostic.json").open("x", encoding="utf-8") as stream:
            json.dump(report, stream, allow_nan=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        verify_manual_startup()
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({"schema": 1, "event": "error", "message": str(error)}), file=sys.stderr)
        raise SystemExit(1) from error
    finally:
        if original_factory is not None:
            sam_build.build_sam2_video_predictor = original_factory
        for adapter in adapters:
            if adapter.originals and any(name in adapter.predictor.__dict__ for name in adapter.originals):
                adapter.close(complete=False)
