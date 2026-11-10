-- Read-only public dashboard links. Anyone with the token can view stats for the site.
CREATE TABLE share_links (
  token TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX share_links_site ON share_links (site_id);
