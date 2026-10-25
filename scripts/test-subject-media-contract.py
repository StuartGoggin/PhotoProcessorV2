import sys
from pathlib import Path
import unittest
import copy

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src-tauri/scripts'))
from subject_media_contract import validate_profile


class PictureCoordinates(unittest.TestCase):
    def profile(self):
        return {'codec_type':'video','width':320,'height':180,'sample_aspect_ratio':'1:1','pix_fmt':'yuv420p',
            'color_range':'tv','color_transfer':'bt709','color_primaries':'bt709','color_space':'bt709',
            'field_order':'progressive','nb_frames':'10','r_frame_rate':'50/1','avg_frame_rate':'50/1'}

    def test_only_exact_normalized_full_picture_is_accepted(self):
        expected=dict(width=320,height=180,fps=50,frame_count=10)
        self.assertEqual(validate_profile([self.profile()],**expected),self.profile())
        for patch in [dict(width=180,height=320),dict(nb_frames='11'),dict(sample_aspect_ratio='2:1'),
            dict(sample_aspect_ratio=None),dict(color_transfer='unknown'),dict(color_transfer='smpte2084'),
            dict(color_range='pc'),dict(pix_fmt='yuv420p10le'),dict(field_order='unknown'),
            dict(avg_frame_rate='499/10'),dict(tags={'rotate':'0'}),
            dict(side_data_list=[{'rotation':90,'displaymatrix':'...'}])]:
            value=self.profile();value.update(patch)
            with self.assertRaises(ValueError):validate_profile([value],**expected)
        with self.assertRaises(ValueError):validate_profile([self.profile(),self.profile()],**expected)


if __name__=='__main__':unittest.main()
