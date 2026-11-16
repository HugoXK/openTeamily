#!/bin/sh
# FlyBot CLI helper for self-hosted OpenTeamily.
# This management-server slice does not ship a CLI binary. The script is the
# documented install path for this origin; it does not download or change files.
# Do not point this at Teamily or other third-party URLs.
echo "The FlyBot CLI is not bundled with this OpenTeamily server yet." >&2
echo "When a release is published, install it from https://github.com/openTeamily/openTeamily" >&2
echo "Then start the daemon with:" >&2
echo "  flybot daemon start --origin <this server origin> --key <runtime key>" >&2
exit 1
