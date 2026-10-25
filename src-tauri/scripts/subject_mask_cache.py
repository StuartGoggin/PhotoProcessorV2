"""Streaming, bounded RLE mask artifact. Exact frames; never overwrite a cache."""
import hashlib
import os
from pathlib import Path
import struct

MAGIC = b"PGMSK001"
HEADER = struct.Struct("<8sIII")
RUN = struct.Struct("<IB")
SIZE = struct.Struct("<I")
MAXIMUM_BYTES = 2 * 1024 ** 3


def _geometry(width, height, frame_count):
    if (any(type(value) is not int for value in (width, height, frame_count))
            or not 1 <= width <= 1024 or not 1 <= height <= 1024
            or not 1 <= frame_count <= 1_800_000):
        raise ValueError("Invalid bounded mask-cache geometry")
    return width * height


def _encode(frame, pixels):
    if not isinstance(frame, bytes) or len(frame) != pixels:
        raise ValueError("Mask frame payload differs from its exact geometry")
    output = bytearray()
    previous, count = frame[0], 0
    for value in frame:
        if value != previous:
            output.extend(RUN.pack(count, previous))
            previous, count = value, 0
        count += 1
    output.extend(RUN.pack(count, previous))
    return output


def write_masks(path: Path, *, width, height, frame_count, frames,
                maximum_bytes=MAXIMUM_BYTES) -> dict:
    pixels = _geometry(width, height, frame_count)
    if type(maximum_bytes) is not int or not HEADER.size + 9 <= maximum_bytes <= MAXIMUM_BYTES:
        raise ValueError("Invalid mask-cache disk budget")
    total, count = HEADER.size, 0
    checksum, strong_checksum = hashlib.md5(), hashlib.sha256()
    with path.open("xb") as stream:
        header = HEADER.pack(MAGIC, width, height, frame_count)
        stream.write(header)
        checksum.update(header)
        strong_checksum.update(header)
        for frame in frames:
            if count >= frame_count:
                raise ValueError("Mask producer exceeded its exact frame count")
            payload = _encode(frame, pixels)
            record = SIZE.pack(len(payload)) + payload
            total += len(record)
            if total > maximum_bytes:
                raise ValueError("Compressed subject masks exceed the two-GiB cache budget")
            stream.write(record)
            checksum.update(record)
            strong_checksum.update(record)
            count += 1
        if count != frame_count:
            raise ValueError("Mask producer dropped one or more owned frames")
        stream.flush()
        os.fsync(stream.fileno())
    return {"schema": 1, "format": "PGMSK001", "width": width, "height": height,
            "frames": count, "bytes": total, "checksum": checksum.hexdigest(),
            "sha256": strong_checksum.hexdigest()}


def read_masks(path: Path, *, width, height, frame_count):
    pixels = _geometry(width, height, frame_count)
    if path.stat().st_size > MAXIMUM_BYTES:
        raise ValueError("Mask artifact exceeds its disk budget")
    with path.open("rb") as stream:
        header = stream.read(HEADER.size)
        if len(header) != HEADER.size or HEADER.unpack(header) != (MAGIC, width, height, frame_count):
            raise ValueError("Mask artifact does not match its exact frame geometry")
        for _ in range(frame_count):
            raw_size = stream.read(SIZE.size)
            if len(raw_size) != SIZE.size:
                raise ValueError("Truncated mask frame record")
            size = SIZE.unpack(raw_size)[0]
            if not 5 <= size <= pixels * RUN.size or size % RUN.size:
                raise ValueError("Invalid bounded mask-frame RLE size")
            payload = stream.read(size)
            if len(payload) != size:
                raise ValueError("Truncated mask-frame payload")
            result = bytearray()
            for offset in range(0, size, RUN.size):
                count, value = RUN.unpack_from(payload, offset)
                if not count or count > pixels - len(result):
                    raise ValueError("Invalid expanding subject-mask run")
                result.extend(bytes([value]) * count)
            if len(result) != pixels:
                raise ValueError("Mask frame run lengths do not cover its exact pixels")
            yield bytes(result)
        if stream.read(1):
            raise ValueError("Trailing data after the last subject-mask frame")
