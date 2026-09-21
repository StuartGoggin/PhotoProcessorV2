#include <omp.h>
#include <stdio.h>

int main(void) {
    int count = 0;
    omp_set_dynamic(0);
    #pragma omp parallel num_threads(2) reduction(+:count)
    count += 1;
    printf("existing_compiler_openmp_threads=%d\n", count);
    return count == 2 ? 0 : 1;
}
