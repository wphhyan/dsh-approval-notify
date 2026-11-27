#!/bin/zsh
# Build the notification helper app from dsh-notify.m.
#
# The binary is compiled universal (arm64 + x86_64) so the same bundle works on
# Intel and Apple silicon Macs, then ad-hoc signed so macOS keeps its notification
# authorization stable across rebuilds.
set -euo pipefail
cd "$(dirname "$0")"

APP="DSHNotify.app"
SRC="../assets/icon-512.png"

rm -rf "$APP" build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" build/icon.iconset

clang -arch arm64 -arch x86_64 -O2 -fobjc-arc -framework Cocoa -framework UserNotifications \
  -o "$APP/Contents/MacOS/dsh-notify" dsh-notify.m

# App icon: the same bell the plugin ships as icon.svg, rendered at every size.
for spec in "16 icon_16x16.png" "32 icon_16x16@2x.png" "32 icon_32x32.png" "64 icon_32x32@2x.png" \
            "128 icon_128x128.png" "256 icon_128x128@2x.png" "256 icon_256x256.png" \
            "512 icon_256x256@2x.png" "512 icon_512x512.png" "1024 icon_512x512@2x.png"; do
  size="${spec%% *}"
  name="${spec#* }"
  sips -z "$size" "$size" "$SRC" --out "build/icon.iconset/$name" >/dev/null
done
iconutil -c icns build/icon.iconset -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>DSH Notify</string>
  <key>CFBundleExecutable</key>
  <string>dsh-notify</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>com.wphhyan.approval-notify</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>DSH Notify</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>10.14</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSHumanReadableCopyright</key>
  <string>MIT licensed; part of dsh-approval-notify.</string>
</dict>
</plist>
PLIST

VERSION="$(node -p "require('../package.json').version" 2>/dev/null || echo 1.0)"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"
echo "helper version $VERSION"

codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "warning: ad-hoc codesign failed; the helper still runs unsigned"

rm -rf build
lipo -info "$APP/Contents/MacOS/dsh-notify"
echo "built $APP"