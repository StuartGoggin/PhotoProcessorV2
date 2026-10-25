"""Exact picture-coordinate admission, shared by local mask jobs and tests."""


def validate_profile(streams, *, width, height, fps, frame_count):
    videos = [stream for stream in streams if stream.get('codec_type') == 'video']
    if len(videos) != 1:
        raise ValueError('Subject finishing requires one exact normalized picture stream')
    video = videos[0]
    if (video.get('width') != width or video.get('height') != height
            or video.get('sample_aspect_ratio') != '1:1'
            or video.get('pix_fmt') != 'yuv420p' or video.get('color_range') != 'tv'
            or any(video.get(field) != 'bt709' for field in ('color_transfer', 'color_primaries', 'color_space'))
            or video.get('field_order') != 'progressive'
            or video.get('nb_frames') != str(frame_count)
            or any(video.get(field) != f'{fps}/1' for field in ('r_frame_rate', 'avg_frame_rate'))
            or 'rotate' in video.get('tags', {})
            or any('rotation' in value or 'displaymatrix' in value for value in video.get('side_data_list', []))):
        raise ValueError('Subject finishing requires exact geometry, square pixels, identity orientation and verified limited SDR7098 progressive CFR footage; unknown/HDR/Log profiles are not accepted')
    return video
