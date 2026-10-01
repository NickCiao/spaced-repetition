-- The hourly reminder cron asks for the most recent grade
-- (MAX(ts) WHERE action IN ('remembered','forgot')). Without this index that is a
-- full scan of events, the one table that grows with every review.
CREATE INDEX idx_events_action_ts ON events (action, ts);
