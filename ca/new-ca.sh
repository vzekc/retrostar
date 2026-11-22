#!/bin/bash

CA_CONF=$(pwd)/ca.cnf

CA_DIR="data"
OUTPUT_KEY="$CA_DIR/ca.key"
OUTPUT_CERT="$CA_DIR/ca.crt"
OUTPUT_TA_KEY="$CA_DIR/ta.key"
OUTPUT_CRL="$CA_DIR/crl.pem"
OUTPUT_DHPARAM="$CA_DIR/dh2048.pem"
OUTPUT_INDEX="$CA_DIR/index.txt"
OUTPUT_SERIAL="$CA_DIR/serial"
OUTPUT_CRLNUMBER="$CA_DIR/crlnumber"
DAYS_VALID=3650

if [ -f "$OUTPUT_CERT" ]
then
    echo "$0: ca certificate $OUTPUT_CERT exists, not overwritten"
    exit 1
fi

mkdir -p $CA_DIR

# Generate CA private key and self-signed certificate
openssl req -x509 \
        -newkey rsa:4096 \
        -keyout "$OUTPUT_KEY" \
        -out "$OUTPUT_CERT" \
        -days "$DAYS_VALID" \
        -nodes \
        -config "$CA_CONF"

# Generate TLS Auth key
openvpn --genkey --secret "$OUTPUT_TA_KEY"

# Generate Diffie-Helman parameters
openssl dhparam -out "$OUTPUT_DHPARAM" 2048

# Generate empty index and initial serial number file
touch "$OUTPUT_INDEX"

# Start with index 1194, which duplicates as udp port number
echo $(printf "%08X\n" 1194) > "$OUTPUT_SERIAL"
echo 1000 > "$OUTPUT_CRLNUMBER"

# The servers check client certificates against the CRL (crl-verify), so the
# CA starts with an empty one
openssl ca -config "$CA_CONF" -gencrl -out "$OUTPUT_CRL" -crldays 3650
