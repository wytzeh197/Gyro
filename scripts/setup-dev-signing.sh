#!/usr/bin/env bash
# Create one stable local code-signing identity so macOS stops asking for the
# login Keychain (and stops re-asking for the microphone) after every rebuild.
#
# Why this is the whole fix: saved API keys sit in the login Keychain behind an
# access list naming the certificate that wrote them, and the microphone grant
# is keyed the same way. An ad-hoc build is a brand-new identity on every
# compile, so "Always Allow" can never stick. A certificate that survives
# rebuilds makes the grant permanent.
#
# Run once. Safe to re-run: it exits early if the identity already exists.
set -euo pipefail

IDENTITY="${GYRO_DEV_IDENTITY:-Gyro Dev}"
KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"

if security find-identity -p codesigning "${KEYCHAIN}" | grep -q "\"${IDENTITY}\""; then
  echo "Identity \"${IDENTITY}\" already exists. Nothing to do."
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
pass="$(openssl rand -hex 16)"

# A self-signed certificate with the code-signing extended key usage is what
# codesign accepts as an identity; no Apple account and no notarization
# involved. Extensions go through -config because macOS ships LibreSSL, whose
# -addext handling is less predictable across versions.
cat > "${work}/openssl.cnf" <<EOF
[ req ]
distinguished_name = dn
x509_extensions = v3
prompt = no
[ dn ]
CN = ${IDENTITY}
O = Gyro Local Development
[ v3 ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
  -keyout "${work}/key.pem" \
  -out "${work}/cert.pem" \
  -config "${work}/openssl.cnf" >/dev/null 2>&1

openssl pkcs12 -export \
  -inkey "${work}/key.pem" \
  -in "${work}/cert.pem" \
  -name "${IDENTITY}" \
  -out "${work}/identity.p12" \
  -passout "pass:${pass}"

# -T pre-authorises codesign and security to use the key, so signing never
# raises its own "allow access" sheet.
security import "${work}/identity.p12" \
  -k "${KEYCHAIN}" \
  -P "${pass}" \
  -T /usr/bin/codesign \
  -T /usr/bin/security >/dev/null

# The partition list is what makes codesign prompt-free on current macOS. It
# needs the login password once; it is passed straight to security and never
# stored or echoed.
printf 'Login password (needed once to let codesign use the new key): '
read -r -s login_password
printf '\n'
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s \
  -k "${login_password}" \
  "${KEYCHAIN}" >/dev/null
unset login_password

if security find-identity -p codesigning "${KEYCHAIN}" | grep -q "\"${IDENTITY}\""; then
  echo "Created \"${IDENTITY}\". Local builds are signed with it from now on,"
  echo "so the Keychain prompt does not come back after rebuilds."
else
  echo "Imported \"${IDENTITY}\", but it cannot sign yet." >&2
  echo "Open Keychain Access, select \"${IDENTITY}\", open Trust, set" >&2
  echo "Code Signing to \"Always Trust\", then re-run this script." >&2
  exit 1
fi
