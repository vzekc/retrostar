#!/bin/bash
#
# Brings the server's checkout to the published main branch, installs the web
# application's dependencies, runs the database migrations and restarts it.
# The deploy workflow's key runs this and nothing else.
#
# The body is one block, so bash has read all of it before the merge below
# replaces this file.
{
    set -euo pipefail
    cd "$(dirname "$0")"

    # Over HTTPS: the repository is public, and the server holds no GitHub key.
    git fetch --quiet https://github.com/vzekc/retrostar.git main
    git merge --ff-only --quiet FETCH_HEAD
    echo "deployed $(git log -1 --format='%h %s')"

    (cd webserver && npm ci --no-audit --no-fund)
    PGDATABASE=retrostar db/migrate.sh up
    sudo systemctl restart retrostar-webserver
    sleep 3
    systemctl is-active retrostar-webserver
    exit
}
