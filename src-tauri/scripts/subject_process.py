"""Bounded diagnostics for local subprocesses, inside the native job owner."""
import os
import subprocess
import tempfile
import time

def bounded_process(args, *, timeout, limit):
    if not 0<timeout<=120 or type(limit) is not int or not 1<=limit<=1024*1024:
        raise ValueError('Invalid local subprocess diagnostic bounds')
    # Regular-file handles avoid inherited pipe readers hanging after exit.
    # Poll both diagnostic lengths while running, not after an unbounded capture.
    with tempfile.TemporaryFile() as output,tempfile.TemporaryFile() as error:
        child=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=output,stderr=error,
                               creationflags=subprocess.CREATE_NO_WINDOW)
        start=time.monotonic()
        try:
            while True:
                if max(os.fstat(output.fileno()).st_size,os.fstat(error.fileno()).st_size)>limit:
                    raise ValueError('Local subprocess exceeded its output budget')
                code=child.poll()
                if code is not None:
                    # A child can exit between the previous size sample and poll.
                    if max(os.fstat(output.fileno()).st_size,os.fstat(error.fileno()).st_size)>limit:
                        raise ValueError('Local subprocess exceeded its output budget')
                    if code:
                        error.seek(0)
                        diagnostic=error.read(min(limit,8192)).decode('utf-8',errors='replace')
                        raise ValueError(f'Local subprocess failed with exit code {code}: {diagnostic}')
                    output.seek(0)
                    return output.read(limit)
                if time.monotonic()-start>=timeout:
                    raise ValueError('Local subprocess exceeded its deadline')
                time.sleep(.025)
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
