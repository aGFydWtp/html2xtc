#!/usr/bin/env bash
# Runs test/converter/ inside the production converter image (linux/amd64),
# i.e. against the real Python, PyMuPDF, Pillow and patched xtctool the
# deployed container has. The local .venv differs (Python version, no
# xtctool), so this is the authority for the converter tests.
#
# Builds converter/Dockerfile as-is, then layers pytest on top in a separate
# test-only image: pytest never enters the production image. Tests are
# mounted read-only and run as the image's unprivileged user.
#
# Leaves two images on the host for reuse (layer cache): "<prefix>-base" (the
# production image) and "<prefix>-pytest" (base + pytest), prefix as below.
# Remove with: docker rmi h2x-conv-test-base h2x-conv-test-pytest
# (the containers are removed on exit).
#
# Usage: scripts/test-converter-docker.sh [pytest args...]
# Env:   H2X_TEST_IMAGE_PREFIX  image/container name prefix (default h2x-conv-test)
#        H2X_TEST_TIMEOUT       outer limit in seconds (default 1500); the
#                               container is killed when it elapses
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
prefix="${H2X_TEST_IMAGE_PREFIX:-h2x-conv-test}"
limit="${H2X_TEST_TIMEOUT:-1500}"
base_image="${prefix}-base"
test_image="${prefix}-pytest"
container="${prefix}-$$"

docker build --platform linux/amd64 -t "$base_image" -f "$repo_root/converter/Dockerfile" "$repo_root/converter"

# No build context needed: the Dockerfile comes from stdin.
docker build --platform linux/amd64 -t "$test_image" - <<EOF
FROM $base_image
USER root
RUN pip install --no-cache-dir pytest
# The tests expect test/converter/*.py next to converter/; /work/converter
# points at the image's own /app, and /work/test is mounted at run time.
RUN mkdir -p /work/test && ln -s /app /work/converter
WORKDIR /work
USER appuser
EOF

watchdog=""
cleanup() {
  if [ -n "$watchdog" ]; then
    pkill -P "$watchdog" 2>/dev/null || true  # its pending sleep
    kill "$watchdog" 2>/dev/null || true
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Kills the container if the run overstays the outer limit (a hung PDF must
# not hang this script).
# fd 3 keeps the message visible while the subshell's own stderr (where bash
# would report its sleep being terminated on a normal exit) is silenced.
exec 3>&2
( sleep "$limit" && echo "timed out after ${limit}s; killing $container" >&3 && docker kill "$container" >/dev/null 2>&1 ) 2>/dev/null &
watchdog=$!
disown "$watchdog"

# converter/Dockerfile is mounted so the test that checks it ships
# pdf_worker.py can run. H2X_REQUIRE_XTCTOOL turns a missing xtctool into a
# failure instead of a skip.
set +e
docker run --name "$container" --platform linux/amd64 \
  -e H2X_REQUIRE_XTCTOOL=1 \
  -v "$repo_root/test:/work/test:ro" \
  -v "$repo_root/converter/Dockerfile:/app/Dockerfile:ro" \
  --entrypoint python "$test_image" \
  -m pytest -p no:cacheprovider -rs test/converter/ "$@"
status=$?
set -e
exit "$status"
