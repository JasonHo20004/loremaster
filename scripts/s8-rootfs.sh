#!/bin/sh
set -eu
kind="$1"
mkdir -p /runtime/lib/apk/db /runtime/etc /runtime/tmp
chmod 1777 /runtime/tmp
cp /etc/alpine-release /etc/os-release /runtime/etc/
if [ "$kind" = node ]; then
  executable=/usr/local/bin/node
  packages='musl,libstdc++,libgcc,ca-certificates-bundle'
  mkdir -p /runtime/etc/ssl/certs
  cp /etc/ssl/certs/ca-certificates.crt /runtime/etc/ssl/certs/
else
  executable=/usr/sbin/nginx
  packages='musl,pcre2,libssl3,libcrypto3,zlib,nginx'
  mkdir -p /runtime/etc/nginx
  cp /etc/nginx/mime.types /runtime/etc/nginx/
fi
mkdir -p "/runtime$(dirname "$executable")"
cp "$executable" "/runtime$executable"
ldd "$executable" | awk '{for(i=1;i<=NF;i++) if($i ~ /^\//) print $i}' | sort -u | while read -r library; do
  mkdir -p "/runtime$(dirname "$library")"
  cp -L "$library" "/runtime$library"
done
# Retain conservative package records for copied libraries, allowing OS/SBOM
# scanners to identify them even though the final image contains no apk tool.
awk -v selected="$packages" 'BEGIN {RS=""; FS="\n"; ORS="\n\n"} {for(i=1;i<=NF;i++) if($i ~ /^P:/ && index("," selected ",", "," substr($i,3) ",") > 0) {print; break}}' /lib/apk/db/installed > /runtime/lib/apk/db/installed
test -s /runtime/lib/apk/db/installed
