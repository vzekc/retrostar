-- DECnet Address Space Management
-- Manages DECnet node address allocations in area 23

CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- Add admin flag to user table
ALTER TABLE "user" ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Block allocations
CREATE TABLE decnet_block (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid REFERENCES "user"(id) NOT NULL,
  start_node INTEGER NOT NULL,
  end_node INTEGER NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT valid_range CHECK (start_node >= 20 AND end_node <= 1023 AND start_node <= end_node),
  CONSTRAINT no_overlap EXCLUDE USING gist (int4range(start_node, end_node, '[]') WITH &&)
);

-- Named hosts within blocks
CREATE TABLE decnet_host (
  node_number INTEGER PRIMARY KEY,
  block_id uuid REFERENCES decnet_block(id) ON DELETE CASCADE NOT NULL,
  name VARCHAR(6) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT valid_name CHECK (name ~ '^[A-Za-z][A-Za-z0-9]{0,5}$'),
  CONSTRAINT unique_name UNIQUE (name)
);

-- Seed existing allocations from the VzEkC Google Sheet

-- Ensure users exist (insert only if not already present)
INSERT INTO "user" (name) VALUES ('hans') ON CONFLICT (name) DO NOTHING;
INSERT INTO "user" (name) VALUES ('toshi') ON CONFLICT (name) DO NOTHING;
INSERT INTO "user" (name) VALUES ('bernhard') ON CONFLICT (name) DO NOTHING;
INSERT INTO "user" (name) VALUES ('a1000duck') ON CONFLICT (name) DO NOTHING;
INSERT INTO "user" (name) VALUES ('kkaempf') ON CONFLICT (name) DO NOTHING;
INSERT INTO "user" (name) VALUES ('reinhard') ON CONFLICT (name) DO NOTHING;
INSERT INTO "user" (name) VALUES ('gnupublic') ON CONFLICT (name) DO NOTHING;
INSERT INTO "user" (name) VALUES ('schroeder') ON CONFLICT (name) DO NOTHING;
INSERT INTO "user" (name) VALUES ('tuti') ON CONFLICT (name) DO NOTHING;
INSERT INTO "user" (name) VALUES ('thiemo') ON CONFLICT (name) DO NOTHING;

-- Insert blocks
INSERT INTO decnet_block (user_id, start_node, end_node)
VALUES ((SELECT id FROM "user" WHERE name = 'hans'), 20, 29);

INSERT INTO decnet_block (user_id, start_node, end_node)
VALUES ((SELECT id FROM "user" WHERE name = 'toshi'), 30, 39);

INSERT INTO decnet_block (user_id, start_node, end_node)
VALUES ((SELECT id FROM "user" WHERE name = 'bernhard'), 40, 49);

INSERT INTO decnet_block (user_id, start_node, end_node)
VALUES ((SELECT id FROM "user" WHERE name = 'a1000duck'), 50, 59);

INSERT INTO decnet_block (user_id, start_node, end_node)
VALUES ((SELECT id FROM "user" WHERE name = 'kkaempf'), 60, 69);

INSERT INTO decnet_block (user_id, start_node, end_node)
VALUES ((SELECT id FROM "user" WHERE name = 'reinhard'), 70, 79);

INSERT INTO decnet_block (user_id, start_node, end_node)
VALUES ((SELECT id FROM "user" WHERE name = 'gnupublic'), 80, 99);

INSERT INTO decnet_block (user_id, start_node, end_node)
VALUES ((SELECT id FROM "user" WHERE name = 'schroeder'), 100, 199);

INSERT INTO decnet_block (user_id, start_node, end_node)
VALUES ((SELECT id FROM "user" WHERE name = 'tuti'), 200, 209);

INSERT INTO decnet_block (user_id, start_node, end_node)
VALUES ((SELECT id FROM "user" WHERE name = 'thiemo'), 210, 219);
