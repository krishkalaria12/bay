#!/bin/sh
# Flatpak's /app/bin/bay: cobalt reads /app/etc/cobalt.ini and starts /app/bay/bay through zypak.
exec cobalt "$@"
