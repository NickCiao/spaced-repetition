#!/usr/bin/env bash
# Renders docs/design/architecture.svg to a 2x PNG and embeds it as a base64
# data URI in the design doc. The doc must be self-contained: sandboxed
# markdown readers only get access to the opened file, so relative image
# references never resolve there.
set -euo pipefail
cd "$(dirname "$0")/../docs/design"

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless --disable-gpu --force-device-scale-factor=2 \
  --window-size=900,368 --screenshot=architecture.png "file://$PWD/architecture.svg" 2>/dev/null

python3 - <<'EOF'
import base64, pathlib, re

doc = pathlib.Path("2026-08-20-spaced-repetition-design.md")
png = base64.b64encode(pathlib.Path("architecture.png").read_bytes()).decode()
text = doc.read_text()
new, n = re.subn(
    r'\]\((?:architecture\.png|data:image/png;base64,[A-Za-z0-9+/=]+)\)',
    f'](data:image/png;base64,{png})',
    text,
    count=1,
)
assert n == 1, "image reference not found in design doc"
doc.write_text(new)
print(f"embedded {len(png) // 1024} KB data URI into {doc.name}")
EOF
