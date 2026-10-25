"""Process-lifetime fixture only; no inference or source media."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--generate', required=True)
parser.add_argument('--runtime-root', required=True)
parser.add_argument('--ffmpeg', required=True)
parser.add_argument('--threads',type=int,required=True)
args = parser.parse_args()
runtime = Path(sys.executable).parent.resolve()
assert Path.cwd() == runtime
assert Path(os.environ['PYTHONUSERBASE']).resolve() == runtime
assert Path(os.environ['NVTOOLSEXT_PATH']).resolve() == runtime
assert 'PHOTOGOGO_OWNER_SECRET' not in os.environ
assert 'APPDATA' not in os.environ and 'CUDA_PATH' not in os.environ
assert sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode
assert 'site' not in sys.modules
child = subprocess.Popen([args.ffmpeg, '-v', 'error', '-nostdin', '-re', '-f', 'lavfi',
    '-i', 'color=size=16x16:rate=1', '-t', '120', '-f', 'null', 'NUL'],
    creationflags=subprocess.CREATE_NO_WINDOW)
print(json.dumps({'event': 'ownerFixture', 'child': child.pid, 'controlledEnvironment': True}), flush=True)
time.sleep(120)
