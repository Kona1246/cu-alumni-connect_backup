#!/bin/sh
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed. Download the LTS version from https://nodejs.org and run this again."; exit 1; }
[ -d node_modules ] || { echo "Installing for the first time, please wait..."; npm install --omit=dev || exit 1; }
exec node server.js
