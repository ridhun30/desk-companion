#!/usr/bin/env bash
# One-time setup inside Termux on the phone: bash scripts/termux-setup.sh
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

pkg update -y
pkg install -y python
pip install -r "$REPO_DIR/requirements.txt"

if [ ! -f "$REPO_DIR/config.json" ]; then
  cp "$REPO_DIR/config.example.json" "$REPO_DIR/config.json"
  echo "Created config.json - set up your calendar in it (see README, step 3)."
fi

# Auto-start on boot (needs the Termux:Boot app, opened once).
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/desk-companion.sh" <<BOOT
#!/data/data/com.termux/files/usr/bin/sh
"$REPO_DIR/scripts/start.sh" >> "$HOME/desk-companion.log" 2>&1 &
BOOT
chmod +x "$HOME/.termux/boot/desk-companion.sh" "$REPO_DIR/scripts/start.sh"

echo
echo "Done. Start it now with:  $REPO_DIR/scripts/start.sh"
echo "Then open http://localhost:8080 in Chrome."
