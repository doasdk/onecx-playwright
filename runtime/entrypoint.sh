#!/bin/sh
set -eu
umask 077

# Platform runners probe image availability without invoking the test suite.
if [ "${1:-}" = "sh" ]; then
    exec "$@"
fi

exec node /opt/onecx-playwright/launch.cjs "$@"
