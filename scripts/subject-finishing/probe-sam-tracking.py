"""Frozen-history two-object compute diagnostic, never semantic mask acceptance."""
import hashlib
import json
import statistics
import time


def measure(predictor, tensor, height, width, torch, attention_probe=False):
    import sam2.sam2_video_predictor as module
    if predictor.num_maskmem != 7 or predictor.memory_temporal_stride_for_eval != 1:
        raise ValueError("Tracking probe requires the unchanged seven-memory profile")
    if predictor.training or tensor.shape != (1, 3, 1024, 1024):
        raise ValueError("Unexpected predictor or normalized input")
    original_loader = module.load_video_frames
    # A diagnostic-only in-memory tape. Restore the vendor binding immediately;
    # do not edit its sealed source or reproduce its inference-state dictionary.
    module.load_video_frames = lambda **kwargs: ([tensor[0]] * 16, height, width)
    try:
        state = predictor.init_state("diagnostic-in-memory-tape", offload_video_to_cpu=True, offload_state_to_cpu=True)
    finally:
        module.load_video_frames = original_loader
    predictor.add_new_points_or_box(state, frame_idx=0, obj_id=1, box=[width*.50, height*.30, width*.95, height*.95])
    predictor.add_new_points_or_box(state, frame_idx=0, obj_id=2, box=[width*.58, height*.08, width*.82, height*.56])
    setup_began = time.perf_counter()
    warm = list(predictor.propagate_in_video(state, start_frame_idx=0, max_frame_num_to_track=6, reverse=False))
    setup_seconds = time.perf_counter() - setup_began
    if [frame for frame, _, _ in warm] != list(range(7)) or state["obj_ids"] != [1, 2]:
        raise ValueError("Warm-up did not establish exactly two objects and seven historical frames")
    del warm

    def describe(value):
        if isinstance(value, torch.Tensor):
            if value.device.type != "cpu" or not bool(torch.isfinite(value).all()):
                raise ValueError("Nonfinite or non-CPU diagnostic output")
            return {"shape": list(value.shape), "dtype": str(value.dtype),
                    "sha256": hashlib.sha256(value.contiguous().view(torch.uint8).numpy().tobytes()).hexdigest()}
        if isinstance(value, dict):
            return {str(key): describe(item) for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))}
        if isinstance(value, (tuple, list)):
            return [describe(item) for item in value]
        if value is None or isinstance(value, (str, bool, float, int)):
            return value
        raise ValueError("Unexpected history field")

    def history():
        for outputs in state["output_dict_per_obj"].values():
            if set(outputs["cond_frame_outputs"]) != {0} or set(outputs["non_cond_frame_outputs"]) != set(range(1, 7)):
                raise ValueError("History was not frozen at frames zero through six")
            for group in outputs.values():
                for output in group.values():
                    if output["maskmem_features"] is None or output["obj_ptr"] is None:
                        raise ValueError("Spatial memory or object pointer is missing")
        for values in state["temp_output_dict_per_obj"].values():
            if any(values.values()):
                raise ValueError("Unconsolidated prompts would alter the timed preflight")
        value = describe({"outputs": state["output_dict_per_obj"], "tracked": state["frames_tracked_per_obj"]})
        return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()

    frozen = history()
    def step():
        state["cached_features"].clear()  # Force one shared encoder, not a cache hit.
        wall, cpu = time.perf_counter(), time.process_time()
        result = list(predictor.propagate_in_video(state, start_frame_idx=7, max_frame_num_to_track=0, reverse=False))
        elapsed, consumed = time.perf_counter() - wall, time.process_time() - cpu
        if len(result) != 1 or result[0][0] != 7 or result[0][1] != [1, 2]:
            raise ValueError("Mature slice did not produce exactly the one requested two-object frame")
        masks = result[0][2]
        output = describe(masks)
        output["positiveMaskPixels"] = [int((item > 0).sum()) for item in masks]
        for object_index in range(2):
            state["output_dict_per_obj"][object_index]["non_cond_frame_outputs"].pop(7)
            state["frames_tracked_per_obj"][object_index].pop(7)
        if history() != frozen:
            raise ValueError("A measured repetition modified the frozen historical outputs")
        return {"wallSeconds": elapsed, "processCpuSeconds": consumed, "output": output}

    samples = []
    for attempt in range(4):
        sample = step(); sample["warmup"] = attempt == 0; samples.append(sample)
        print(json.dumps({"event": "mature-tracking", "attempt": attempt, "wallSeconds": sample["wallSeconds"],
                          "processCpuSeconds": sample["processCpuSeconds"]}), flush=True)
    stages, installed = {}, []
    names = ["forward_image", "_prepare_memory_conditioned_features", "_forward_sam_heads", "_encode_new_memory"]
    def wrapper(name, original):
        def call(*args, **kwargs):
            wall, cpu = time.perf_counter(), time.process_time()
            try:
                return original(*args, **kwargs)
            finally:
                stages.setdefault(name, []).append({"wallSeconds": time.perf_counter()-wall, "processCpuSeconds": time.process_time()-cpu})
        return call
    attention = []
    def shapes(value):
        return list(value.shape) if isinstance(value, torch.Tensor) else [shapes(item) for item in value] if isinstance(value, (list, tuple)) else value
    def attention_hook(module, args, kwargs):
        attention.append({key: shapes(kwargs[key]) for key in ("curr", "memory", "num_obj_ptr_tokens") if key in kwargs})
    handle = predictor.memory_attention.register_forward_pre_hook(attention_hook, with_kwargs=True)
    try:
        for name in names:
            if name in predictor.__dict__:
                raise ValueError("A predictor method was already replaced")
            setattr(predictor, name, wrapper(name, getattr(predictor, name))); installed.append(name)
        if attention_probe:
            import importlib.util
            from pathlib import Path
            spec = importlib.util.spec_from_file_location("attention_probe", Path(__file__).with_name("probe-sam-attention.py"))
            probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)
            with probe.Capture(torch) as capture:
                instrumented = step()
        else:
            instrumented = step()
    finally:
        for name in installed: delattr(predictor, name)
        handle.remove()
    if [len(stages.get(name, [])) for name in names] != [1, 2, 2, 2] or len(attention) != 2:
        raise ValueError("Instrumentation did not observe the expected shared encoder and two object stages")
    report = {"mode": "frozen-history-frame7-two-object", "logicalWindowFrames": 16, "numMaskmem": 7,
            "setupPropagationSeconds": setup_seconds, "historySha256": frozen, "seedPrompts": "Geometric diagnostic fixture, not semantic horse/rider annotation",
            "measurements": samples, "medianWallSeconds": statistics.median(item["wallSeconds"] for item in samples[1:]),
            "instrumentedSample": instrumented, "stages": stages, "attentionInputs": attention,
            "limitations": "One static frame with full seven-entry spatial memory and seven pointer histories; not full tail-pointer saturation, semantic mask quality, video throughput or GPU qualification."}
    if attention_probe:
        report["cpuAttention"] = capture.replay()
    return report
