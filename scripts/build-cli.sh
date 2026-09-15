#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun build --compile --minify bin/actpipe.js --outfile actpipe
echo "已编译 $(pwd)/actpipe"
