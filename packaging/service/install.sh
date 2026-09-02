#!/usr/bin/env bash
# force-agent overlay: install the background service so it starts at login and
# stays up. Linux (systemd user unit) and macOS (launchd LaunchAgent).
#
#   bash install.sh              install and start
#   bash install.sh --uninstall  stop and remove
#
# This installs a *user* service, not a system one. The service registers itself
# in the user's XDG state directory and binds 127.0.0.1 with a credential it
# generates - a system-wide daemon would put that registration somewhere the user
# running `force` cannot read, so the TUI would never find it.

set -euo pipefail

label="com.force-agent.agent"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
uninstall=""
[ "${1:-}" = "--uninstall" ] && uninstall="yes"

# Same override chain as bin/force.cjs, most specific first: the current
# LABHARNESS_ brand, the previous LABFY_ one, then POWER_, then upstream's
# OPENCODE_. POWERAGENT_BIN is the older alias this installer accepted; it still
# works so an existing setup keeps pointing at the same binary.
binary="${FORCE_AGENT_BIN_PATH:-${LABHARNESS_BIN_PATH:-${LABFY_BIN_PATH:-${POWER_BIN_PATH:-${OPENCODE_BIN_PATH:-$(command -v force || true)}}}}}"
if [ -z "$binary" ] && [ -z "$uninstall" ]; then
  echo "force is not on PATH. Install it with 'npm i -g force-agent', or set LABHARNESS_BIN_PATH." >&2
  exit 1
fi
# systemd and launchd both refuse a relative ExecStart.
[ -n "$binary" ] && binary="$(cd "$(dirname "$binary")" && pwd)/$(basename "$binary")"

case "$(uname -s)" in
  Linux) platform="linux" ;;
  Darwin) platform="darwin" ;;
  *) echo "Unsupported platform: $(uname -s). See README.md for Windows." >&2; exit 1 ;;
esac

if [ "$platform" = "linux" ]; then
  command -v systemctl > /dev/null || { echo "systemd is required; see README.md for a plain-nohup fallback." >&2; exit 1; }
  unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/force-agent.service"
  if [ -n "$uninstall" ]; then
    systemctl --user disable --now force-agent.service 2> /dev/null || true
    rm -f "$unit"
    systemctl --user daemon-reload
    echo "removed $unit"
    exit 0
  fi
  mkdir -p "$(dirname "$unit")"
  sed "s|@BIN@|$binary|g" "$here/force-agent.service" > "$unit"
  systemctl --user daemon-reload
  systemctl --user enable --now force-agent.service
  systemctl --user --no-pager status force-agent.service || true
  echo
  echo "Installed $unit"
  # Without lingering, the user manager is torn down at logout and the service
  # dies with it - which is exactly what "app alive on the machine" must not do.
  if ! loginctl show-user "$USER" --property=Linger 2> /dev/null | grep -q "Linger=yes"; then
    echo "To keep it running after logout: sudo loginctl enable-linger $USER"
  fi
  exit 0
fi

plist="$HOME/Library/LaunchAgents/$label.plist"
if [ -n "$uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$label" 2> /dev/null || launchctl unload "$plist" 2> /dev/null || true
  rm -f "$plist"
  echo "removed $plist"
  exit 0
fi
logs="${XDG_STATE_HOME:-$HOME/.local/state}/force-agent/log"
mkdir -p "$(dirname "$plist")" "$logs"
sed -e "s|@BIN@|$binary|g" -e "s|@LOG@|$logs|g" "$here/$label.plist" > "$plist"
plutil -lint "$plist" > /dev/null
launchctl bootout "gui/$(id -u)/$label" 2> /dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
launchctl kickstart "gui/$(id -u)/$label"
echo "Installed $plist"
echo "Logs: $logs"
