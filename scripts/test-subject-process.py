import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src-tauri/scripts'))
from subject_process import bounded_process

class Capture(unittest.TestCase):
    def test_complete_success_is_bounded(self):
        self.assertEqual(bounded_process([sys.executable,'-c','print("profile")'],timeout=5,limit=1024),b'profile\r\n')
    def test_oversized_metadata_nonzero_and_deadline_are_not_success(self):
        for code,timeout,expected in [
            ('print("x"*100_000)',5,'output budget'),
            ('import sys; print("valid-prefix"); sys.exit(7)',5,'exit code'),
            ('import time; time.sleep(4)',.2,'deadline')]:
            with self.subTest(expected=expected),self.assertRaisesRegex(ValueError,expected):
                bounded_process([sys.executable,'-c',code],timeout=timeout,limit=1024)
if __name__=='__main__':unittest.main()
