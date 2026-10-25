"""Diagnostic-only replay of one actual mature CPU attention call. No model edits."""
import hashlib
import statistics
import time


def describe(tensor, torch):
    if tensor.device.type != "cpu" or tensor.dtype != torch.float32 or not bool(torch.isfinite(tensor).all()):
        raise ValueError("Attention diagnostic requires finite unchanged float32 CPU tensors")
    return {"shape": list(tensor.shape), "strides": list(tensor.stride()),
            "contiguous": tensor.is_contiguous(), "dtype": str(tensor.dtype),
            "sha256": hashlib.sha256(tensor.contiguous().numpy().tobytes()).hexdigest()}


class Capture:
    def __init__(self, torch):
        self.torch = torch
        self.original = torch.nn.functional.scaled_dot_product_attention
        self.inputs = None
        self.expected = None
        self.observed = 0

    def __enter__(self):
        torch = self.torch
        def attention(q, k, v, *args, **kwargs):
            # Exact unchanged seven-memory frame-7 profile. Do not extrapolate
            # this diagnostic to other heads, batches, masks, GQA or dropout.
            selected = tuple(q.shape) == (1, 1, 4096, 256) and tuple(k.shape) == (1, 1, 28700, 256)
            if selected:
                self.observed += 1
                if args or kwargs != {"dropout_p": 0.0} or tuple(v.shape) != tuple(k.shape):
                    raise ValueError("Unexpected mature cross-attention call contract")
                if self.inputs is None:
                    for value in (q, k, v): describe(value, torch)
                    if sum(value.numel() * value.element_size() for value in (q, k, v)) > 128 * 1024**2:
                        raise ValueError("Frozen attention inputs exceed the fixed capture budget")
                    self.inputs = tuple(value.detach().clone(memory_format=torch.preserve_format) for value in (q, k, v))
                    if any(not torch.equal(a, b) or a.stride() != b.stride() for a, b in zip((q, k, v), self.inputs)):
                        raise ValueError("Capture changed input values or tensor layout")
            result = self.original(q, k, v, *args, **kwargs)
            if selected and self.expected is None:
                self.expected = result.detach().clone()
            return result
        torch.nn.functional.scaled_dot_product_attention = attention
        return self

    def __exit__(self, *exc):
        self.torch.nn.functional.scaled_dot_product_attention = self.original

    def replay(self):
        torch = self.torch
        if self.observed != 8 or self.inputs is None or self.expected is None:
            raise ValueError("Probe did not observe four cross-attention layers for each of two objects")
        inputs_before = [describe(value, torch) for value in self.inputs]
        expected = describe(self.expected, torch)
        from torch.utils._python_dispatch import TorchDispatchMode
        class Operations(TorchDispatchMode):
            def __init__(self):
                super().__init__()
                self.names = []
            def __torch_dispatch__(self, operation, types, args=(), kwargs=None):
                self.names.append(str(operation))
                if len(self.names) > 128:
                    raise ValueError("Unexpected attention dispatch depth")
                return operation(*args, **(kwargs or {}))
        saved_threads = torch.get_num_threads()
        groups = []
        try:
            # Counterbalance order; this is a frozen-kernel experiment, not
            # advice to switch thread budgets inside production inference.
            for threads in (8, 4, 1, 1, 4, 8):
                torch.set_num_threads(threads)
                values = []
                for attempt in range(4):
                    wall, cpu = time.perf_counter(), time.process_time()
                    result = self.original(*self.inputs, dropout_p=0.0)
                    elapsed, consumed = time.perf_counter()-wall, time.process_time()-cpu
                    exact = torch.equal(result, self.expected)
                    difference = float((result-self.expected).abs().max())
                    values.append({"warmup": attempt == 0, "wallSeconds": elapsed,
                                   "processCpuSeconds": consumed, "exact": exact, "maxAbsDifference": difference})
                    del result
                group = {"threads": threads, "samples": values,
                         "medianWallSeconds": statistics.median(value["wallSeconds"] for value in values[1:])}
                groups.append(group)
                print(__import__("json").dumps({"event": "attention-replay", "threads": threads,
                    "medianWallSeconds": group["medianWallSeconds"], "allExact": all(value["exact"] for value in values)}), flush=True)
            torch.set_num_threads(saved_threads)
            with Operations() as dispatch:
                result = self.original(*self.inputs, dropout_p=0.0)
            if not torch.equal(result, self.expected):
                raise ValueError("Dispatch inspection changed the frozen attention output")
            # TorchDispatchMode may see only the composite public SDPA op,
            # not its selected C++ implementation. A separate untimed CPU
            # profiler call supplies kernel evidence; never infer dispatch
            # from eligibility, requested flags or the shallow mode trace.
            with torch.autograd.profiler.profile(use_kineto=False, record_shapes=False, profile_memory=False) as profile:
                profiled = self.original(*self.inputs, dropout_p=0.0)
            if not torch.equal(profiled, self.expected):
                raise ValueError("CPU profiler inspection changed the frozen attention output")
            operators = sorted({event.key for event in profile.key_averages()})
            if len(operators) > 128:
                raise ValueError("Unexpected attention profiler event depth")
            kernels = [name for name in operators if "attention" in name]
            if [describe(value, torch) for value in self.inputs] != inputs_before:
                raise ValueError("Replay mutated the frozen attention inputs")
            # Contiguous conversion is a no-op if all captured tensors already
            # have that layout; record it rather than claim a new optimization.
            contiguous_noop = all(value.is_contiguous() for value in self.inputs)
            return {"mode": "one-actual-mature-cross-attention", "observedCrossAttentionCalls": self.observed,
                    "inputs": inputs_before, "expectedOutput": expected, "dispatchOperations": dispatch.names,
                    "cpuProfilerOperators": operators, "cpuProfilerAttentionOperators": kernels,
                    "contiguousConversionWouldBeNoop": contiguous_noop, "groups": groups,
                    "restoredThreads": saved_threads, "qualityAccepted": False, "exportQualified": False,
                    "limitations": "One frozen actual layer input; not whole-model thread parity, semantic mask quality, video throughput or GPU qualification."}
        finally:
            torch.set_num_threads(saved_threads)
