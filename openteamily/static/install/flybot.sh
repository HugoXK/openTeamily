#!/bin/sh
# FlyBot CLI helper for self-hosted OpenTeamily.
# Do not pipe this script to a shell. It does not download, install, or start
# a daemon. Start the bundled module yourself from a source checkout.
echo "Do not pipe this script into a shell." >&2
echo "From a checkout of https://github.com/openTeamily/openTeamily, write your" >&2
echo "runtime key to a private file and start the daemon explicitly:" >&2
echo "  python3 -m openteamily.flybot daemon start --origin <this server origin> --key-file ./runtime-key" >&2
exit 1
