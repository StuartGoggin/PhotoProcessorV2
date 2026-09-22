/* Link-only preflight: no media or device operations are executed. */
#include <stdint.h>
#include <stdio.h>
#include <vid.stab/libvidstab.h>
#include <x264.h>
#include <hb.h>
#include <ft2build.h>
#include FT_FREETYPE_H
#include <vpl/mfxdispatcher.h>
#include <zlib.h>
int main(void) {
    printf("dependency_symbols=%p,%p,%p,%p,%p,%p\n",
        (void *)vsMotionDetectInit, (void *)x264_encoder_encode,
        (void *)hb_buffer_create, (void *)FT_Init_FreeType,
        (void *)MFXLoad, (void *)zlibVersion);
    return 0;
}
