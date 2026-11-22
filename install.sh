#!/bin/bash
# Symlinks this extension into the GNOME Shell extensions directory so edits
# here take effect on the next Shell reload without a separate copy step.
set -euo pipefail
cd "$(dirname "$0")"

UUID=$(python3 -c "import json; print(json.load(open('metadata.json'))['uuid'])")
TARGET="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$(dirname "$TARGET")"
if [ -L "$TARGET" ] || [ -e "$TARGET" ]; then
    rm -rf "$TARGET"
fi
ln -s "$(pwd)" "$TARGET"

echo "Linked $(pwd) -> $TARGET"
echo "Reload GNOME Shell (log out/in on Wayland, or Alt+F2 r on X11), then:"
echo "  gnome-extensions enable $UUID"
