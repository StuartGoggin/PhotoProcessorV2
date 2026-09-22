/* Regression harness for the pinned old vid.stab library, not modern algorithms. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <omp.h>
#include "transform.h"
#include "frameinfo.h"

static void require(int ok, const char *label) {
  if (!ok) { fprintf(stderr, "FAIL: %s\n", label); exit(1); }
}
static void fill(VSFrame *f, const VSFrameInfo *fi, int seed) {
  unsigned state = (unsigned)seed;
  for (int p = 0; p < fi->planes; p++) {
    int w = fi->width >> vsGetPlaneWidthSubS(fi, p);
    int h = fi->height >> vsGetPlaneHeightSubS(fi, p);
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      state = state * 1664525u + 1013904223u;
      f->data[p][y * f->linesize[p] + x] = (unsigned char)(state >> 24);
    }
  }
}
static int equal(const VSFrame *a, const VSFrame *b, const VSFrameInfo *fi) {
  for (int p = 0; p < fi->planes; p++) {
    int w = fi->width >> vsGetPlaneWidthSubS(fi, p);
    int h = fi->height >> vsGetPlaneHeightSubS(fi, p);
    for (int y = 0; y < h; y++)
      if (memcmp(a->data[p] + y*a->linesize[p], b->data[p] + y*b->linesize[p], w)) return 0;
  }
  return 1;
}
static void allocate_padded(VSFrame *f, const VSFrameInfo *fi) {
  vsFrameNull(f);
  for(int p=0;p<fi->planes;p++) {
    int w=fi->width >> vsGetPlaneWidthSubS(fi,p);
    int h=fi->height >> vsGetPlaneHeightSubS(fi,p);
    f->linesize[p]=w+32;
    f->data[p]=vs_malloc((size_t)(w+32)*h);
    require(f->data[p]!=NULL,"padded frame allocation");
    memset(f->data[p],0xa5,(size_t)(w+32)*h);
  }
}
static void padding_intact(const VSFrame *f, const VSFrameInfo *fi) {
  for(int p=0;p<fi->planes;p++) {
    int w=fi->width >> vsGetPlaneWidthSubS(fi,p);
    int h=fi->height >> vsGetPlaneHeightSubS(fi,p);
    for(int y=0;y<h;y++)for(int x=w;x<f->linesize[p];x++)
      require(f->data[p][y*f->linesize[p]+x]==0xa5,"row padding overwritten");
  }
}
static void ownership_mode(int crop) {
  VSFrameInfo fi; VSFrame old, saved, out, next, refsrc, refout;
  VSTransformData td, reference; VSTransform t = {0};
  VSTransformConfig conf = vsTransformGetDefaultConfig("ownership");
  conf.crop = crop; conf.interpolType = VS_BiCubic;
  vsFrameInfoInit(&fi, 64, 48, PF_YUV420P);
  vsFrameAllocate(&old,&fi); vsFrameAllocate(&saved,&fi);
  vsFrameAllocate(&out,&fi); vsFrameAllocate(&next,&fi);
  vsFrameAllocate(&refsrc,&fi); vsFrameAllocate(&refout,&fi);
  fill(&old,&fi,10); fill(&next,&fi,20); vsFrameCopy(&saved,&old,&fi);
  require(vsTransformDataInit(&td,&conf,&fi,&fi)==VS_OK,"init");
  require(vsTransformDataInit(&reference,&conf,&fi,&fi)==VS_OK,"reference init");
  t.x=0.5; t.y=-0.5;
  require(vsTransformPrepare(&td,&old,&out)==VS_OK,"separate prepare");
  require(vsDoTransform(&td,t)==VS_OK,"separate transform");
  require(vsTransformFinish(&td)==VS_OK,"separate finish");
  vsFrameCopy(&refsrc,&saved,&fi);
  require(vsTransformPrepare(&reference,&refsrc,&refout)==VS_OK,"reference first prepare");
  require(vsDoTransform(&reference,t)==VS_OK,"reference first transform");
  require(vsTransformFinish(&reference)==VS_OK,"reference first finish");
  vsFrameCopy(&refsrc,&next,&fi);
  require(vsTransformPrepare(&reference,&refsrc,&refout)==VS_OK,"reference next prepare");
  require(vsDoTransform(&reference,t)==VS_OK,"reference next transform");
  require(vsTransformFinish(&reference)==VS_OK,"reference next finish");
  require(vsTransformPrepare(&td,&next,&next)==VS_OK,"in-place prepare");
  require(equal(&old,&saved,&fi),"retained previous caller input overwritten on separate-to-in-place transition");
  require(td.srcMalloced && td.src.data[0]!=next.data[0] && td.src.data[0]!=old.data[0],"owned source snapshot");
  require(vsDoTransform(&td,t)==VS_OK,"in-place transform");
  require(vsTransformFinish(&td)==VS_OK,"in-place finish");
  require(equal(&old,&saved,&fi),"retained input after transform");
  require(equal(&next,&refout,&fi),"in-place result differs from separate-buffer reference");
  vsTransformDataCleanup(&td);
  vsTransformDataCleanup(&reference);
  vsFrameFree(&old); vsFrameFree(&saved); vsFrameFree(&out); vsFrameFree(&next);
  vsFrameFree(&refsrc);vsFrameFree(&refout);
}
static void ownership(void) {
  ownership_mode(VSCropBorder);ownership_mode(VSKeepBorder);
  puts("PASS retained-input ownership and separate-buffer reference, both borders");
}
static void planar_formats(void) {
  VSPixelFormat formats[]={PF_GRAY8,PF_YUV444P,PF_YUVA420P};
  int comparisons=0;
  for(int fmt=0;fmt<3;fmt++)for(int interpolation=0;interpolation<4;interpolation++)for(int crop=0;crop<2;crop++){
    VSFrameInfo fi;VSFrame input,output[2];VSTransformData td[2];VSTransform t={0};
    VSTransformConfig conf=vsTransformGetDefaultConfig("formats");
    conf.crop=crop;conf.interpolType=interpolation;
    vsFrameInfoInit(&fi,64,48,formats[fmt]);allocate_padded(&input,&fi);fill(&input,&fi,81);
    t.x=3.25;t.y=-1.5;t.alpha=0.04;t.zoom=-6;
    for(int k=0;k<2;k++){
      allocate_padded(&output[k],&fi);omp_set_num_threads(k?6:1);
      require(vsTransformDataInit(&td[k],&conf,&fi,&fi)==VS_OK,"format init");
      require(vsTransformPrepare(&td[k],&input,&output[k])==VS_OK,"format prepare");
      require(vsDoTransform(&td[k],t)==VS_OK,"format transform");
      require(vsTransformFinish(&td[k])==VS_OK,"format finish");
      padding_intact(&output[k],&fi);
    }
    require(equal(&output[0],&output[1],&fi),"planar format/interpolation equality");comparisons++;
    for(int k=0;k<2;k++){vsTransformDataCleanup(&td[k]);vsFrameFree(&output[k]);}
    vsFrameFree(&input);
  }
  printf("PASS additional_planar_interpolation_pairs=%d\n",comparisons);
}
static void rows(void) {
  int comparisons=0;
  omp_set_dynamic(0);
  for(int size=0;size<2;size++) for(int threads=6;threads<=12;threads+=6)
  for(int crop=0;crop<=1;crop++) for(int mode=0;mode<3;mode++) {
    VSFrameInfo fi; VSFrame input, src[2], dest[2]; VSTransformData td[2];
    VSTransformConfig conf=vsTransformGetDefaultConfig("rows");
    conf.crop=crop; conf.interpolType=VS_BiCubic;
    vsFrameInfoInit(&fi,size?3840:638,size?2160:358,PF_YUV420P);
    allocate_padded(&input,&fi);
    for(int k=0;k<2;k++) {
      allocate_padded(&src[k],&fi); allocate_padded(&dest[k],&fi);
      require(vsTransformDataInit(&td[k],&conf,&fi,&fi)==VS_OK,"rows init");
    }
    for(int f=0;f<8;f++) {
      VSTransform t={0}; VSFrame *out[2];
      int inplace=mode==1 || (mode==2 && f%2);
      if(f==1){t.x=0.5;t.y=0.5;} if(f==2){t.x=7.3;t.y=-4.7;t.alpha=0.026;t.zoom=2;}
      if(f==3){t.alpha=-0.05;t.zoom=4;} if(f==4){t.x=-400;t.y=-300;}
      if(f==5)t.alpha=0.7853981633974483; if(f==6)t.zoom=-60;
      if(f==7){t.x=11.75;t.y=-9.25;t.alpha=-0.02;t.zoom=8;}
      fill(&input,&fi,f+100);
      for(int k=0;k<2;k++) {
        int observed=0; omp_set_num_threads(k?threads:1);
#pragma omp parallel
        {
#pragma omp single
          observed=omp_get_num_threads();
        }
        require(observed==(k?threads:1),"observed worker count");
        vsFrameCopy(&src[k],&input,&fi); out[k]=inplace?&src[k]:&dest[k];
        require(vsTransformPrepare(&td[k],&src[k],out[k])==VS_OK,"rows prepare");
        require(vsDoTransform(&td[k],t)==VS_OK,"rows transform");
        require(vsTransformFinish(&td[k])==VS_OK,"rows finish");
        if(!inplace)require(equal(&src[k],&input,&fi),"read-only current input");
        padding_intact(&src[k],&fi);padding_intact(&dest[k],&fi);
      }
      require(equal(out[0],out[1],&fi),"serial/parallel pixel equality");comparisons++;
    }
    for(int k=0;k<2;k++){vsTransformDataCleanup(&td[k]);vsFrameFree(&src[k]);vsFrameFree(&dest[k]);}
    vsFrameFree(&input);
  }
  printf("PASS byte_equal_frame_pairs=%d\n",comparisons);
  require(comparisons==192,"comparison count");
}
int main(int argc,char **argv) {
  ownership();
  planar_formats();
  if(argc>1 && strcmp(argv[1],"rows")==0)rows();
  return 0;
}
