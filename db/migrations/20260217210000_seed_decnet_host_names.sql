-- Seed DECnet host names from current NCP output

INSERT INTO decnet_host (node_number, block_id, name)
VALUES
  (20,  (SELECT id FROM decnet_block WHERE 20  BETWEEN start_node AND end_node), 'SMBRCK'),
  (23,  (SELECT id FROM decnet_block WHERE 23  BETWEEN start_node AND end_node), 'IIFX'),
  (24,  (SELECT id FROM decnet_block WHERE 24  BETWEEN start_node AND end_node), 'PSB001'),
  (29,  (SELECT id FROM decnet_block WHERE 29  BETWEEN start_node AND end_node), 'VS4K9'),
  (30,  (SELECT id FROM decnet_block WHERE 30  BETWEEN start_node AND end_node), 'VESTA'),
  (40,  (SELECT id FROM decnet_block WHERE 40  BETWEEN start_node AND end_node), 'VLC30'),
  (41,  (SELECT id FROM decnet_block WHERE 41  BETWEEN start_node AND end_node), 'V10031'),
  (50,  (SELECT id FROM decnet_block WHERE 50  BETWEEN start_node AND end_node), 'ROEDE'),
  (80,  (SELECT id FROM decnet_block WHERE 80  BETWEEN start_node AND end_node), 'KELVIN'),
  (100, (SELECT id FROM decnet_block WHERE 100 BETWEEN start_node AND end_node), 'HOPPER'),
  (109, (SELECT id FROM decnet_block WHERE 109 BETWEEN start_node AND end_node), 'NOTES'),
  (111, (SELECT id FROM decnet_block WHERE 111 BETWEEN start_node AND end_node), 'CORONA'),
  (112, (SELECT id FROM decnet_block WHERE 112 BETWEEN start_node AND end_node), 'MOPEIA'),
  (200, (SELECT id FROM decnet_block WHERE 200 BETWEEN start_node AND end_node), 'JODY'),
  (209, (SELECT id FROM decnet_block WHERE 209 BETWEEN start_node AND end_node), 'COLT');
