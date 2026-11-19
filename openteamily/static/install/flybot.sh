#!/bin/sh
# FlyBot CLI helper for self-hosted OpenTeamily.
# Do not pipe this script to a shell. It does not download, install, or start
# a daemon. Download the zipapp yourself, then start it explicitly.
echo "Do not pipe this script into a shell." >&2
echo "Download the agent and start it with two explicit commands:" >&2
echo "  python3 -c 'from urllib.request import urlretrieve; urlretrieve(\"<origin>/install/flybot.pyz\", \"flybot.pyz\")'" >&2
echo "  python3 flybot.pyz daemon start --origin <this server origin> --key-file ./runtime-key" >&2
exit 1
