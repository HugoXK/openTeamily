# FlyBot CLI helper for self-hosted OpenTeamily.
# Do not pipe this script to a shell. It does not download, install, or start
# a daemon. Download the zipapp yourself, then start it explicitly.
Write-Error @"
Do not pipe this script into a shell.
Download the agent and start it with two explicit commands:
  Invoke-WebRequest -Uri <origin>/install/flybot.pyz -OutFile flybot.pyz
  python flybot.pyz daemon start --origin <this server origin> --key-file .\runtime-key
"@
exit 1
