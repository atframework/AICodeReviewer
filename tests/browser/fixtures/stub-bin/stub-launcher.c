/*
 * Windows stub-agent launcher for the browser gate (P7 run isolation leg).
 * Plain node cannot spawn `.cmd` shims by bare name (libuv only resolves
 * exact name + `.exe`), so start-fixture.mjs compiles this once per launch
 * into kilo.exe / opencode.exe. Each exe forwards to
 * `%AICR_STUB_BIN_DIR%\<own-stem>.mjs` (the async stub implementation shared
 * with POSIX) with the original argument vector, and propagates its exit
 * code. argv[0]-stem dispatch keeps one source for both binaries.
 */
#include <windows.h>
#include <process.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
  char self[MAX_PATH];
  DWORD len = GetModuleFileNameA(NULL, self, MAX_PATH);
  if (len == 0 || len >= MAX_PATH) {
    fprintf(stderr, "stub-launcher: cannot resolve own path\n");
    return 90;
  }
  char *slash = strrchr(self, '\\');
  if (slash != NULL) *slash = '\0';

  const char *base = strrchr(argv[0], '\\');
  base = base != NULL ? base + 1 : argv[0];
  char stem[128];
  strncpy(stem, base, sizeof(stem) - 1);
  stem[sizeof(stem) - 1] = '\0';
  char *dot = strrchr(stem, '.');
  if (dot != NULL) *dot = '\0';

  const char *binDir = getenv("AICR_STUB_BIN_DIR");
  if (binDir == NULL || binDir[0] == '\0') binDir = self;

  char script[MAX_PATH * 2];
  snprintf(script, sizeof(script), "%s\\%s.mjs", binDir, stem);

  char **forwarded = malloc(sizeof(char *) * ((size_t)argc + 2));
  if (forwarded == NULL) {
    fprintf(stderr, "stub-launcher: out of memory\n");
    return 91;
  }
  forwarded[0] = "node";
  forwarded[1] = script;
  for (int i = 1; i < argc; i++) forwarded[i + 1] = argv[i];
  forwarded[argc + 1] = NULL;

  intptr_t rc = _spawnvp(_P_WAIT, "node", (const char *const *)forwarded);
  free(forwarded);
  if (rc == -1) {
    fprintf(stderr, "stub-launcher: failed to spawn node for %s\n", script);
    return 92;
  }
  return (int)rc;
}
