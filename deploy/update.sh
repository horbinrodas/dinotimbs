#!/bin/sh
set -e
cd /srv/dinotimbs
before=$(git rev-parse HEAD)
git pull --ff-only
if ! git diff --quiet "$before" HEAD -- larpdle; then sudo systemctl restart larpdle; fi
if ! git diff --quiet "$before" HEAD -- lowballdle; then sudo systemctl restart lowballdle; fi
if ! git diff --quiet "$before" HEAD -- deploy/Caddyfile; then sudo systemctl reload caddy; fi
