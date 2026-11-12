#!/bin/sh
set -eu

runtime="${RUNTIME_IMAGE:-onecx-playwright:local}"
consumer="${SMOKE_IMAGE:-onecx-playwright-smoke:local}"
work=".contract-smoke-$$"
mkdir "$work"
containers=""
cleanup() {
    for container in $containers; do docker rm -f "$container" >/dev/null; done
    rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM

verify_manifest() {
    container="$1"
    directory="$2"
    status="$3"
    code="$4"
    docker cp "$container:$directory/execution.json" "$work/execution.json" >/dev/null
    docker run --rm --entrypoint node \
        --mount "type=bind,src=$(pwd)/$work,dst=/manifest,readonly" \
        "$runtime" -e 'const fs=require("node:fs"); const assert=require("node:assert/strict"); assert.deepEqual(JSON.parse(fs.readFileSync(process.argv[1])), {version:1,status:process.argv[2],exitCode:Number(process.argv[3])})' /manifest/execution.json "$status" "$code"
    test "$(docker inspect "$container" --format '{{.State.ExitCode}}')" = "$code"
}

contract_run() {
    status="$1"
    code="$2"
    directory="$3"
    shift 3
    container=$(docker create "$@")
    containers="$containers $container"
    docker start -a "$container" || test "$code" -ne 0
    verify_manifest "$container" "$directory" "$status" "$code"
}

expect_failure() {
    if "$@"; then
        echo "Expected command to fail: $*" >&2
        exit 1
    fi
}

docker run --rm "$runtime" sh -c 'test "$(node --version)" = v22.22.0'
expect_failure docker run --rm "$runtime"
expect_failure docker run --rm "$consumer" unknown-script
expect_failure docker run --rm -e TEST_ROOT=/missing "$consumer"
expect_failure docker run --rm -e ONECX_PLAYWRIGHT_VERSION=0.0.0 "$consumer"
expect_failure docker run --rm -e OUTPUT_DIR=/proc/onecx-results "$consumer"

docker run --rm --init "$consumer"
docker run --rm --init "$consumer" tests:gui --project=chromium
docker run --rm --init -e TEST_SCRIPT=tests:gui "$consumer" ignored --project=chromium
docker run --rm --init -e OUTPUT_DIR=/custom-results "$consumer" tests:gui --project=chromium

# Exercise the CA setup before Node starts without relying on a remote TLS service.
docker run --rm --init \
    -e TLS_CA_CERT_PATH=/etc/ssl/certs/ca-certificates.crt \
    "$consumer" tests:gui --project=chromium

contract_run success 0 /contract-results --init \
    -e ONECX_RUNTIME_FILE=/app/integration/runtime.json \
    "$consumer" tests:gui --project=chromium
contract_run configuration-failed 2 /e2e-results \
    -e ONECX_RUNTIME_FILE=/app/integration/runtime-invalid.json "$consumer"
contract_run configuration-failed 2 /e2e-results \
    -e ONECX_RUNTIME_FILE=/missing.json "$consumer"
contract_run configuration-failed 2 /e2e-results \
    -e ONECX_PLAYWRIGHT_CONFIG=/etc/passwd "$consumer"
contract_run configuration-failed 2 /e2e-results \
    -e TLS_CA_CERT_PATH=/missing.pem "$consumer"
contract_run test-failed 7 /e2e-results "$consumer" tests:fail

# Docker signals reach the inherited launcher, which forwards to the npm group.
container=$(docker create "$consumer" tests:wait)
containers="$containers $container"
docker start "$container" >/dev/null
ready=false
for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if docker logs "$container" 2>&1 | grep -q onecx-signal-ready; then
        ready=true
        break
    fi
    sleep 1
done
test "$ready" = true
docker kill --signal=TERM "$container" >/dev/null
docker wait "$container" >/dev/null
verify_manifest "$container" /e2e-results interrupted 143
