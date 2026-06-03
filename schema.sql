-- dsrp PostgreSQL Schema
-- Für semantische Suche optimiert (pgvector-ready)

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Kategorien
CREATE TABLE IF NOT EXISTS categories (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  slug        TEXT,
  short_label TEXT
);

-- Locations
CREATE TABLE IF NOT EXISTS locations (
  id                   TEXT PRIMARY KEY,
  institution_id       TEXT,
  name                 TEXT,
  street               TEXT,
  city                 TEXT,
  postcode             INTEGER,
  province             TEXT,
  district             TEXT,
  lat                  DOUBLE PRECISION,
  lng                  DOUBLE PRECISION,
  formatted_address    TEXT,
  accessibility        TEXT,
  accessibility_comment TEXT,
  email                TEXT,
  phone                TEXT,
  land_wide_valid      BOOLEAN DEFAULT FALSE
);

-- Öffnungszeiten (je Location)
CREATE TABLE IF NOT EXISTS office_hours (
  id          TEXT PRIMARY KEY,
  location_id TEXT REFERENCES locations(id) ON DELETE CASCADE,
  label       TEXT
);

-- Öffnungszeiten Tage
CREATE TABLE IF NOT EXISTS office_hour_days (
  id                    SERIAL PRIMARY KEY,
  office_hour_id        TEXT REFERENCES office_hours(id) ON DELETE CASCADE,
  day_id                INTEGER,
  day_label             TEXT,
  hours_from            TEXT,
  hours_to              TEXT,
  additional_hours_from TEXT,
  additional_hours_to   TEXT
);

-- Angebote
CREATE TABLE IF NOT EXISTS offers (
  id                       TEXT PRIMARY KEY,
  title                    TEXT NOT NULL,
  slug                     TEXT,
  description              TEXT,
  description_print        TEXT,
  description2             TEXT,
  description3             TEXT,
  description4             TEXT,
  website                  TEXT,
  costs                    TEXT,
  costs_comment            TEXT,
  modes_of_contact         TEXT[],
  anonymous_counseling     BOOLEAN,
  appointment_arrangement  TEXT,
  institution_id           TEXT,
  institution_name         TEXT,
  valid_from               TIMESTAMPTZ,
  valid_to                 TIMESTAMPTZ,
  released_from            TEXT,
  released_time            TIMESTAMPTZ,
  location_provinces       TEXT[],
  location_post_codes      INTEGER[],
  keywords                 TEXT[],
  target_groups            TEXT[],
  status                   TEXT DEFAULT 'released',
  -- Kombinierter Text für semantische Suche (title + desc + keywords + categories)
  search_text              TEXT,
  -- Für pgvector Embeddings (wird später befüllt)
  -- embedding             vector(1536),
  created_at               TIMESTAMPTZ,
  updated_at               TIMESTAMPTZ
);

-- Offer <-> Category (m:n)
CREATE TABLE IF NOT EXISTS offer_categories (
  offer_id    TEXT REFERENCES offers(id)     ON DELETE CASCADE,
  category_id TEXT REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (offer_id, category_id)
);

-- Offer <-> Location (m:n)
CREATE TABLE IF NOT EXISTS offer_locations (
  offer_id    TEXT REFERENCES offers(id)   ON DELETE CASCADE,
  location_id TEXT REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (offer_id, location_id)
);

-- Indizes für Performance
CREATE INDEX IF NOT EXISTS idx_offers_search_text     ON offers USING gin(to_tsvector('german', search_text));
CREATE INDEX IF NOT EXISTS idx_offers_institution_id  ON offers(institution_id);
CREATE INDEX IF NOT EXISTS idx_locations_postcode     ON locations(postcode);
CREATE INDEX IF NOT EXISTS idx_office_hours_location  ON office_hours(location_id);
