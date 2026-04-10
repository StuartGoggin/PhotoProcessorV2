#!/usr/bin/env python3
import argparse
import json
import math
import sys


def _load_dependencies():
    try:
        import cv2  # type: ignore
        from deepface import DeepFace  # type: ignore
    except Exception as exc:
        print(
            f"Dependency error: {exc}. Install python packages: deepface opencv-python",
            file=sys.stderr,
        )
        raise
    return cv2, DeepFace


def _iter_sampled_frames(cv2, cap, sample_fps, shard_index=0, shard_count=1):
    source_fps = cap.get(cv2.CAP_PROP_FPS)
    if not source_fps or math.isnan(source_fps) or source_fps <= 0:
        source_fps = 30.0

    step = max(int(round(source_fps / max(sample_fps, 1))), 1)
    frame_idx = 0
    sampled_idx = 0

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if frame_idx % step == 0:
            if sampled_idx % max(shard_count, 1) == shard_index:
                timestamp_ms = int((frame_idx / source_fps) * 1000)
                yield frame, timestamp_ms
            sampled_idx += 1
        frame_idx += 1


def _estimate_sampled_total(total_frames, step):
    if total_frames <= 0 or step <= 0:
        return 0
    return (total_frames + step - 1) // step


def _estimate_shard_total(sampled_total, shard_index, shard_count):
    if sampled_total <= 0:
        return 0
    if shard_count <= 1:
        return sampled_total
    if shard_index >= sampled_total:
        return 0
    return ((sampled_total - 1 - shard_index) // shard_count) + 1


def main():
    parser = argparse.ArgumentParser(description="Scan a video for faces with DeepFace")
    parser.add_argument("--video", required=True, help="Path to video file")
    parser.add_argument("--fps", type=int, default=1, help="Sample frames per second")
    parser.add_argument("--shard-index", type=int, default=0, help="Shard index for single-video parallel scan")
    parser.add_argument("--shard-count", type=int, default=1, help="Total shard count for single-video parallel scan")
    args = parser.parse_args()

    shard_count = max(int(args.shard_count or 1), 1)
    shard_index = int(args.shard_index or 0)
    if shard_index < 0 or shard_index >= shard_count:
        print(
            f"Invalid shard arguments: shard_index={shard_index} shard_count={shard_count}",
            file=sys.stderr,
        )
        return 2

    cv2, DeepFace = _load_dependencies()

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(f"Failed to open video: {args.video}", file=sys.stderr)
        return 2

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    source_fps = cap.get(cv2.CAP_PROP_FPS)
    if not source_fps or math.isnan(source_fps) or source_fps <= 0:
        source_fps = 30.0
    step = max(int(round(source_fps / max(args.fps, 1))), 1)
    sampled_total_all = _estimate_sampled_total(total_frames, step)
    sampled_total = _estimate_shard_total(sampled_total_all, shard_index, shard_count)

    detections = []
    sampled_done = 0
    progress_every = 10

    try:
        for frame, timestamp_ms in _iter_sampled_frames(
            cv2,
            cap,
            max(args.fps, 1),
            shard_index=shard_index,
            shard_count=shard_count,
        ):
            sampled_done += 1
            if sampled_done == 1 or sampled_done % progress_every == 0:
                print(
                    "PG_PROGRESS "
                    + json.dumps(
                        {
                            "sampled_done": sampled_done,
                            "sampled_total": sampled_total,
                            "shard_index": shard_index,
                            "shard_count": shard_count,
                        }
                    ),
                    flush=True,
                )
            try:
                reps = DeepFace.represent(
                    img_path=frame,
                    model_name="Facenet512",
                    detector_backend="retinaface",
                    enforce_detection=False,
                )

                if isinstance(reps, dict):
                    reps = [reps]

                for rep in reps:
                    embedding = rep.get("embedding")
                    if not embedding:
                        continue

                    confidence = 1.0
                    face_conf = rep.get("face_confidence")
                    if isinstance(face_conf, (float, int)):
                        confidence = float(face_conf)

                    detections.append(
                        {
                            "embedding": [float(v) for v in embedding],
                            "timestamp_ms": int(timestamp_ms),
                            "confidence": confidence,
                        }
                    )
            except Exception:
                # Keep scanning even if one frame fails inference.
                continue
    finally:
        cap.release()

    print(
        "PG_RESULT "
        + json.dumps(
            {
                "faces": detections,
                "sampled_done": sampled_done,
                "sampled_total": sampled_total,
                "source_total_frames": max(total_frames, 0),
                "shard_index": shard_index,
                "shard_count": shard_count,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
