-- DECnet gateway clients: named nodes of a member's DECnet block that reach
-- the RetroStar network through the decnet-gateway daemon. The web
-- application keeps the gateway's key identifier and the key's fingerprint;
-- the key itself lives only in the gateway's configuration and in the
-- member's connection line.

-- The Ethernet address of DECnet node 23.<node>: AA-00-04-00 followed by
-- area * 1024 + node, low byte first.
CREATE OR REPLACE FUNCTION decnet_mac(node integer)
    RETURNS macaddr AS
$$
SELECT ('aa:00:04:00:'
            || lpad(to_hex((23 * 1024 + node) & 255), 2, '0') || ':'
            || lpad(to_hex((23 * 1024 + node) >> 8), 2, '0'))::macaddr
$$ LANGUAGE sql IMMUTABLE;

CREATE TABLE decnet_gateway_client
(
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         uuid      NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
    -- Set while the node is named; a revoked client's node may be released
    -- later, and its record keeps the address.
    node_number     integer REFERENCES decnet_host (node_number) ON DELETE RESTRICT,
    address         text      NOT NULL,
    name            varchar(6) NOT NULL,
    key_id          integer UNIQUE,
    key_fingerprint text,
    created_at      timestamp NOT NULL DEFAULT NOW(),
    rekeyed_at      timestamp,
    rekey_day       date,
    rekey_count     integer   NOT NULL DEFAULT 0,
    -- The gateway did not know the client at the last reconciliation; a
    -- rekey issues it a new key.
    needs_rekey     boolean   NOT NULL DEFAULT FALSE,
    last_seen       timestamp,
    revoked_at      timestamp,
    revoked_by      uuid REFERENCES "user" (id) ON DELETE SET NULL,
    revoke_reason   text,
    CONSTRAINT active_has_node CHECK (revoked_at IS NOT NULL OR node_number IS NOT NULL)
);

CREATE UNIQUE INDEX decnet_gateway_client_active_node
    ON decnet_gateway_client (node_number)
    WHERE revoked_at IS NULL;

CREATE INDEX decnet_gateway_client_user ON decnet_gateway_client (user_id);

-- A machine seen on the gateway's bridge port: the host belongs to the owner
-- of the active gateway client whose DECnet address the MAC carries. MACs
-- without an active client are ignored.
CREATE OR REPLACE FUNCTION update_gateway_host(mac text)
    RETURNS VOID AS
$$
DECLARE
    owner uuid;
BEGIN
    SELECT c.user_id
    INTO owner
    FROM decnet_gateway_client c
    WHERE c.revoked_at IS NULL
      AND decnet_mac(c.node_number) = mac::macaddr;

    IF owner IS NULL THEN
        RETURN;
    END IF;

    INSERT INTO host (user_id, mac_address, last_seen)
    VALUES (owner, mac::macaddr, NOW())
    ON CONFLICT (mac_address) DO UPDATE SET last_seen = NOW(), user_id = owner;
END
$$ LANGUAGE plpgsql;
