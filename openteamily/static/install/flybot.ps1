# FlyBot CLI helper for self-hosted OpenTeamily.
# This management-server slice does not ship a CLI binary. The script is the
# documented Windows install path for this origin; it does not download or
# change files. Do not point this at Teamily or other third-party URLs.
Write-Error @"
The FlyBot CLI is not bundled with this OpenTeamily server yet.
When a release is published, install it from https://github.com/openTeamily/openTeamily
Then start the daemon with:
  flybot daemon start --origin <this server origin> --key <runtime key>
"@
exit 1
