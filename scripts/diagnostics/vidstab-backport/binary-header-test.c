/* Read only the fixed header: never allocate a motion list on malformed input. */
#include <stdint.h>
#include <stdio.h>
int vsReadFileVersionBinary(FILE *f);
static int check(FILE *f) {
  int version = vsReadFileVersionBinary(f);
  long offset = ftell(f);
  int32_t first_frame = -1, first_count = -1;
  int read_ok = fread(&first_frame, sizeof(first_frame), 1, f) == 1 &&
                fread(&first_count, sizeof(first_count), 1, f) == 1;
  fclose(f);
  printf("version=%d header_bytes=%ld first_frame=%d first_count=%d\n",
         version, offset, (int)first_frame, (int)first_count);
  if (!read_ok || version != 1 || offset != 24 || first_frame != 1 || first_count != 0) {
    fprintf(stderr, "FAIL: binary header consumed a field byte as whitespace\n");
    return 1;
  }
  return 0;
}
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  FILE *fixture = fopen(argv[1], "rb");
  if (!fixture || check(fixture)) return 1;
  for (int32_t accuracy = 8; accuracy <= 13; ++accuracy) {
    FILE *f = tmpfile();
    if (!f) return 2;
    int32_t shakiness = 3, step = 6, frame = 1, count = 0;
    double contrast = 0.25;
    fwrite("TRF1", 1, 4, f);
    fwrite(&accuracy, 4, 1, f); fwrite(&shakiness, 4, 1, f); fwrite(&step, 4, 1, f);
    fwrite(&contrast, 8, 1, f); fwrite(&frame, 4, 1, f); fwrite(&count, 4, 1, f);
    rewind(f);
    if (check(f)) return 1;
  }
  puts("PASS: fixture and accuracy 8-13 preserve the first frame boundary");
  return 0;
}
