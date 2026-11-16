# FlyBot CLI helper for self-hosted OpenTeamily.
# Do not pipe this script to a shell. It does not download, install, or start
# a daemon. Start the bundled module yourself from a source checkout.
Write-Error @"
Do not pipe this script into a shell.
From a checkout of https://github.com/openTeamily/openTeamily, write your runtime key to a private file and start the daemon explicitly:
  python -m openteamily.flybot daemon start --origin <this server origin> --key-file .\runtime-key
"@
exit 1
