#!/bin/sh
set -eu
umask 077

mode="${1:?Expected matrix, run, or report}"
case "$mode" in matrix|run|report) ;; *) echo "Unsupported orchestration mode" >&2; exit 2 ;; esac
: "${ORCHESTRATOR_IMAGE:?Set ORCHESTRATOR_IMAGE to a pinned orchestrator image}"
: "${CONFIG_PATH:=integration/integration.config.json}"
case "$CONFIG_PATH" in /*|../*|*/../*|*/..|..) echo "Config must be relative to the checkout" >&2; exit 2 ;; esac

root=$(pwd)
mkdir -p "$root/.onecx-ci" "$root/results"
state="$root/.onecx-ci/launch.$$"
if ! mkdir "$state"; then echo "Launcher state directory collision; refusing to overwrite files." >&2; exit 2; fi
volume=""
container=""
cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    cleanup_status=0
    if [ -n "$container" ]; then
        if ! docker stop --time 30 "$container" >>"$state/private.log" 2>&1; then
            echo "Cleanup failed: could not stop orchestrator container." >&2
            cleanup_status=1
        fi
        if ! docker cp "$container:$mountpoint/results/." "$root/results" >>"$state/private.log" 2>&1; then
            echo "Cleanup failed: could not export integration results." >&2
            cleanup_status=1
        fi
        if ! docker rm -f "$container" >>"$state/private.log" 2>&1; then
            echo "Cleanup failed: could not remove orchestrator container." >&2
            cleanup_status=1
        fi
    fi
    if [ -n "$volume" ]; then
        if ! docker volume rm -f "$volume" >>"$state/private.log" 2>&1; then
            echo "Cleanup failed: could not remove integration volume." >&2
            cleanup_status=1
        fi
    fi
    if ! rm -f "$state/environments.json" "$state/data.json"; then
        echo "Cleanup failed: could not remove local integration secret files." >&2
        cleanup_status=1
    fi
    if [ "$status" -eq 0 ]; then status=$cleanup_status; fi
    if [ "$status" -ne 0 ]; then
        echo "Integration $mode failed; inspect exported summaries. Raw logs are not published." >&2
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

echo "Preparing integration $mode..." >&2
volume=$(docker volume create)
mountpoint=$(docker volume inspect "$volume" --format '{{.Mountpoint}}')
case "$mountpoint" in /*) ;; *) echo "A Linux Docker daemon is required" >&2; exit 2 ;; esac

# Nested container bind mounts resolve on the daemon, not inside the orchestrator.
docker run --rm --entrypoint sh \
    --mount "type=volume,src=$volume,dst=$mountpoint" \
    "$ORCHESTRATOR_IMAGE" -c 'mkdir -p "$1/source" "$1/results" "$1/work" "$1/secrets/docker"' sh "$mountpoint" \
    >"$state/private.log" 2>&1

set -- docker create --init \
    --mount "type=volume,src=$volume,dst=$mountpoint" \
    --workdir "$mountpoint/source" \
    -e "CI=${CI:-}" \
    -e "TMPDIR=$mountpoint/work" \
    -e "ONECX_MATRIX_INDEX_FILE=$mountpoint/results/matrix-index-input.json"
if [ "$mode" = run ]; then
    : "${RUN_ID:?Matrix run requires RUN_ID}"
    set -- "$@" --network host --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
        -e "RUN_ID=$RUN_ID"
fi
if [ -n "${E2E_IMAGE:-}" ]; then set -- "$@" -e "E2E_IMAGE=$E2E_IMAGE"; fi
if [ -n "${DOCKER_CONFIG:-}" ] && [ -f "$DOCKER_CONFIG/config.json" ]; then
    set -- "$@" -e "DOCKER_CONFIG=$mountpoint/secrets/docker"
fi
if [ -n "${ENVIRONMENTS_JSON:-}" ]; then
    set -- "$@" -e "ENVIRONMENTS_JSON_FILE=$mountpoint/secrets/environments.json"
fi
if [ -n "${TEST_DATA_JSON:-}" ]; then
    set -- "$@" -e "TEST_DATA_JSON_FILE=$mountpoint/secrets/data.json"
fi
set -- "$@" "$ORCHESTRATOR_IMAGE" "$mode" \
    --config "$mountpoint/source/$CONFIG_PATH" \
    --results "$mountpoint/results" --work "$mountpoint/work"
if [ "$mode" = run ]; then
    : "${MATRIX_SELECTION_BASE64:?Matrix run requires a selection}"
    set -- "$@" --selection "$MATRIX_SELECTION_BASE64"
fi
container=$("$@")
echo "Staging configuration and source (excluding dependencies and generated artifacts)..." >&2
tar --exclude=.git --exclude=.onecx-ci --exclude=results \
    --exclude=node_modules --exclude=.angular --exclude=dist \
    --exclude=integration-tests --exclude=test-results --exclude=playwright-report \
    --exclude=allure-results --exclude=allure-report --exclude=blob-report \
    -cf - . |
    docker cp - "$container:$mountpoint/source" >>"$state/private.log" 2>&1
if [ "$mode" = report ]; then
    docker cp "$root/results/." "$container:$mountpoint/results" >>"$state/private.log" 2>&1
fi
if [ -n "${DOCKER_CONFIG:-}" ] && [ -f "$DOCKER_CONFIG/config.json" ]; then
    docker cp "$DOCKER_CONFIG/." "$container:$mountpoint/secrets/docker" >>"$state/private.log" 2>&1
fi
if [ -n "${ENVIRONMENTS_JSON:-}" ]; then
    printf '%s' "$ENVIRONMENTS_JSON" >"$state/environments.json"
    docker cp "$state/environments.json" "$container:$mountpoint/secrets/environments.json" >>"$state/private.log" 2>&1
fi
if [ -n "${TEST_DATA_JSON:-}" ]; then
    printf '%s' "$TEST_DATA_JSON" >"$state/data.json"
    docker cp "$state/data.json" "$container:$mountpoint/secrets/data.json" >>"$state/private.log" 2>&1
fi
unset ENVIRONMENTS_JSON TEST_DATA_JSON
echo "Executing integration $mode..." >&2
if [ "$mode" = matrix ]; then
    docker start -a "$container" >"$state/matrix.json" 2>>"$state/private.log"
    cp "$state/matrix.json" "$root/.onecx-ci/matrix.json"
else
    docker start -a "$container" >>"$state/private.log" 2>&1
fi
code=$(docker inspect "$container" --format '{{.State.ExitCode}}')
test "$code" = 0
echo "Integration $mode completed; exporting results." >&2
