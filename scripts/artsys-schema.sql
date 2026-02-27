-- ArtSys database schema for artsys_db
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'user',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS collections (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_collections (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, collection_id)
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_categories_collection ON categories(collection_id);

CREATE TABLE IF NOT EXISTS sub_categories (
  id SERIAL PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subcategories_category ON sub_categories(category_id);

CREATE TABLE IF NOT EXISTS item_types (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL
);

CREATE TABLE IF NOT EXISTS dealers (
  id SERIAL PRIMARY KEY,
  info TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS dispositions (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_sold BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS rankings (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventories (
  id SERIAL PRIMARY KEY,
  collection_id INTEGER REFERENCES collections(id),
  category_id INTEGER REFERENCES categories(id),
  sub_category_id INTEGER REFERENCES sub_categories(id),
  item_type_id INTEGER REFERENCES item_types(id),
  dealer_id INTEGER REFERENCES dealers(id),
  disposition_id INTEGER REFERENCES dispositions(id),
  location_id INTEGER REFERENCES locations(id),
  ranking_id INTEGER REFERENCES rankings(id),
  description TEXT NOT NULL DEFAULT '',
  artist VARCHAR(255) NOT NULL DEFAULT '',
  date_circa VARCHAR(255) NOT NULL DEFAULT '',
  where_made VARCHAR(255) NOT NULL DEFAULT '',
  provenance TEXT NOT NULL DEFAULT '',
  published BOOLEAN NOT NULL DEFAULT false,
  published_related_examples BOOLEAN NOT NULL DEFAULT false,
  exhibited BOOLEAN NOT NULL DEFAULT false,
  purchase_price DECIMAL(19,4) NOT NULL DEFAULT 0,
  purchase_date VARCHAR(50) NOT NULL DEFAULT '',
  purchase_year VARCHAR(20) NOT NULL DEFAULT '',
  appraised BOOLEAN NOT NULL DEFAULT false,
  estimated_value DECIMAL(19,4) NOT NULL DEFAULT 0,
  estimated_value_date VARCHAR(50) NOT NULL DEFAULT '',
  appraiser_info TEXT NOT NULL DEFAULT '',
  sold_price DECIMAL(19,4) NOT NULL DEFAULT 0,
  sold_date VARCHAR(50) NOT NULL DEFAULT '',
  sold_year VARCHAR(20) NOT NULL DEFAULT '',
  original_purchase DECIMAL(19,4) NOT NULL DEFAULT 0,
  vol_1 BOOLEAN NOT NULL DEFAULT false,
  vol_2 BOOLEAN NOT NULL DEFAULT false,
  comments TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inventories_collection ON inventories(collection_id);
CREATE INDEX IF NOT EXISTS idx_inventories_category ON inventories(category_id);
CREATE INDEX IF NOT EXISTS idx_inventories_subcategory ON inventories(sub_category_id);
CREATE INDEX IF NOT EXISTS idx_inventories_disposition ON inventories(disposition_id);
CREATE INDEX IF NOT EXISTS idx_inventories_location ON inventories(location_id);
CREATE INDEX IF NOT EXISTS idx_inventories_dealer ON inventories(dealer_id);
CREATE INDEX IF NOT EXISTS idx_inventories_ranking ON inventories(ranking_id);

CREATE TABLE IF NOT EXISTS attachments (
  id SERIAL PRIMARY KEY,
  inventory_id INTEGER NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
  file_path VARCHAR(500) NOT NULL,
  file_name VARCHAR(255) NOT NULL DEFAULT '',
  extension VARCHAR(10) NOT NULL DEFAULT '',
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  no_id BOOLEAN NOT NULL DEFAULT false,
  review BOOLEAN NOT NULL DEFAULT false,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_attachments_inventory ON attachments(inventory_id);
CREATE INDEX IF NOT EXISTS idx_attachments_active ON attachments(inventory_id, is_active);

-- Seed admin user (password: admin123 — change immediately!)
INSERT INTO users (email, password_hash, first_name, last_name, role)
VALUES ('admin@artsys.local', '$2b$10$kpnYHti8mkQN9fdSdY9v/uPIQOUXi76bTxUtIboMba1UeLZpJJytm', 'Admin', 'User', 'admin')
ON CONFLICT (email) DO NOTHING;
