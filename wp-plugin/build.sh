#!/usr/bin/env bash
#
# Build the installable beardbot-sensors zip into .build/ at the repo root
# (gitignored, same convention as the wp-staging-setup project).
#
# The zip must carry forward-slash entry paths or WordPress on Linux hosting
# extracts garbage — which rules out PowerShell's Compress-Archive (backslash
# entries). bsdtar (macOS tar, Windows' bundled system32 tar.exe) and
# Info-ZIP `zip` both do it correctly; this script uses whichever is present.
#
# Usage: bash wp-plugin/build.sh   (from anywhere; paths are script-relative)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BUILD_DIR="${REPO_ROOT}/.build"

VERSION="$(sed -n 's/^ \* Version: *//p' "${SCRIPT_DIR}/beardbot-sensors/beardbot-sensors.php" | tr -d '[:space:]')"
if [ -z "${VERSION}" ]; then
  echo "ERROR: could not read the plugin version from beardbot-sensors.php" >&2
  exit 1
fi

ZIP="${BUILD_DIR}/beardbot-sensors-${VERSION}.zip"
mkdir -p "${BUILD_DIR}"
rm -f "${ZIP}"

cd "${SCRIPT_DIR}"
if command -v zip >/dev/null 2>&1; then
  zip -rq "${ZIP}" beardbot-sensors
elif [ -x "/c/Windows/System32/tar.exe" ]; then
  # Windows Git Bash: the bundled bsdtar writes zip when told -a by extension.
  /c/Windows/System32/tar.exe -a -cf "${ZIP}" beardbot-sensors
elif tar --version 2>/dev/null | grep -q bsdtar; then
  tar -a -cf "${ZIP}" beardbot-sensors
else
  echo "ERROR: need Info-ZIP 'zip' or bsdtar to build a portable zip." >&2
  exit 1
fi

echo "Built ${ZIP}"
