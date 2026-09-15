#!/bin/bash

# Dieses Skript läuft, wenn die Verbindung zur Bridge hergestellt wurde

PATH=/usr/sbin:/usr/bin

IF=$1

ip link set $IF master br0
ip link set $IF up
ip -6 addr flush $IF
