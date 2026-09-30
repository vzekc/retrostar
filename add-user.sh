#!/bin/bash

set -e

export PGDATABASE=retrostar

if [ -z "$1" ]; then
  echo "Usage: $0 <username>"
  exit 1
fi

username=$(echo "$1" | tr '[:upper:]' '[:lower:]')

if [ "$username" != "$1" ]; then
  echo "Note: username normalized to lowercase: $username" >&2
fi

SCRIPT_DIR=$(dirname "$0")
cd "$SCRIPT_DIR"

# Create user
psql -tA -c 'INSERT INTO "user" (name) VALUES ('"'$username'"')'
./ca/new-cert.sh $username
./start-openvpn-servers.sh
key=$(psql -tA -c "SELECT '' || request_password_reset('$username');")
cat <<EOF

Dein RetroStar-Account wurde eingerichtet.

Dein Benutzername ist $username (Kleinbuchstaben)

Besuche diesen Link, um Dein Kennwort zu setzen: https://retrostar.classic-computing.de/set-password?key=$key

EOF
