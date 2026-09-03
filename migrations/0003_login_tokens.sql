-- One-time email sign-in codes for bootstrapping new devices. The raw code only
-- ever exists inside the emailed link; only its SHA-256 hex digest is stored, so
-- a leaked database row cannot be replayed. Rows are single-use (used_at) and
-- short-lived (expires_at); expired rows are pruned opportunistically.
CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  redirect TEXT NOT NULL DEFAULT '/'
);
