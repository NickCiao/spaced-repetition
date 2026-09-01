-- The grouping concept is a topic, not a source: prompts in one group can come
-- from different places. Rename the table/column, and add real provenance as an
-- optional single-line markdown `source` on each prompt. Captures get a `topic`
-- name hint (free text; resolved to a topic row at refine time) so `title` can
-- go back to meaning the shared page title.
ALTER TABLE sources RENAME TO topics;
ALTER TABLE prompts RENAME COLUMN source_id TO topic_id;
DROP INDEX idx_prompts_source;
CREATE INDEX idx_prompts_topic ON prompts (topic_id, position);
ALTER TABLE prompts ADD COLUMN source TEXT;
ALTER TABLE captures ADD COLUMN topic TEXT;
