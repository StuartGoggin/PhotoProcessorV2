"""Actual time-varying CFR decode provenance without model inference."""
from pathlib import Path
import sys
import hashlib
import subprocess
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src-tauri/scripts'))
from subject_mask_job import decode_window
from subject_masks_contract import directional_windows

ROOT=Path(__file__).resolve().parents[1]
FF=Path('C:/creations/PhotoGoGoV2/src-tauri/tools/ffmpeg/bin/ffmpeg.exe')


class ExactWindowFrames(unittest.TestCase):
    def test_time_varying_30_and_50_fps_forward_reverse_reference_zero_and_tail(self):
        with tempfile.TemporaryDirectory(prefix='decode-provenance-',dir=ROOT/'test-output') as owned:
            owned=Path(owned)
            for fps in (30,50):
                source=owned/f'{fps}.mp4'
                generated=subprocess.run([str(FF),'-v','error','-nostdin','-n','-f','lavfi','-i',
                    f"nullsrc=size=48x32:rate={fps},geq=lum='32+N*5':cb=128:cr=128",
                    '-frames:v','35','-c:v','libx264','-crf','0','-g','12','-bf','0','-threads','1',str(source)],
                    capture_output=True,timeout=30,creationflags=subprocess.CREATE_NO_WINDOW)
                self.assertEqual(generated.returncode,0,generated.stderr)
                with source.open('rb') as stream:before=hashlib.file_digest(stream,'sha256').hexdigest()
                full=owned/f'{fps}-full';full.mkdir()
                decode_window(FF,source,full,lower=0,upper=34,width=48,height=32,fps=fps)
                canonical=[hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(full.glob('*.jpg'))]
                self.assertEqual(len(set(canonical)),35,'Frame identity fixture must vary every frame')
                for reference in (0,12):
                    for index,window in enumerate(directional_windows(35,reference=reference,window_frames=16,overlap_frames=4)):
                        part=owned/f'{fps}-{reference}-{index}';part.mkdir()
                        lower,upper=min(window.frames),max(window.frames)
                        decode_window(FF,source,part,lower=lower,upper=upper,width=48,height=32,fps=fps)
                        decoded=[hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(part.glob('*.jpg'))]
                        self.assertEqual(decoded,canonical[lower:upper+1],f'{fps} fps ref {reference} {window}')
                        for frame in window.owned:self.assertEqual(decoded[frame-lower],canonical[frame])
                with source.open('rb') as stream:self.assertEqual(hashlib.file_digest(stream,'sha256').hexdigest(),before)


if __name__=='__main__':unittest.main()
