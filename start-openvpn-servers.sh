#!/bin/bash

set -e

SCRIPT_DIR=$(dirname "$0")
cd "$SCRIPT_DIR"

# set -e ends the script when the query fails, so a database outage stops no
# server.
configurations=$(psql -U retrostar -d retrostar -tAF' ' -c 'select coalesce(oc.config_name, u.name), oc.port_number from openvpn_configuration oc join "user" u on u.id = oc.user_id')

# Stop the servers of configurations that were removed. A pid file names its
# configuration; the process must be an OpenVPN server of ours.
for pid_file in /var/run/openvpn/*.pid
do
    [ -f "$pid_file" ] || continue
    config_name=$(basename "$pid_file" .pid)
    if echo "$configurations" | cut -d' ' -f1 | grep -qxF "$config_name"
    then
        continue
    fi
    pid=$(cat "$pid_file")
    if [ -e "/proc/$pid/cmdline" ] && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q "openvpn_server.conf"
    then
        echo "stopping server for $config_name"
        kill "$pid"
    fi
    rm -f "$pid_file"
done

echo "$configurations" | while read -r config_name port
do
    [ -n "$config_name" ] || continue
    pid_file="/var/run/openvpn/$config_name.pid"
    if [ -f "$pid_file" ] && [ -e "/proc/$(cat $pid_file)" ]
    then
        continue
    fi
    echo "starting server for $config_name"
    log_file="/var/log/openvpn/$config_name.log"
    sudo openvpn --cd "ca" \
            --daemon \
            --verb 3 \
            --port "$port" \
            --config openvpn_server.conf \
            --log-append $log_file \
            --writepid $pid_file
done
