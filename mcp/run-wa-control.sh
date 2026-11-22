#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python="${WA_MCP_PYTHON:-$here/.venv/bin/python}"
if [ ! -x "$python" ]; then
    python="$(command -v python3)"
fi

exec "$python" "$here/wa_control_server.py" "$@"
