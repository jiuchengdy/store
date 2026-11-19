-- 0002_email_outbox_episodes: let an order notify the buyer once per status EPISODE.
--
-- Why: email_outbox was unique on (order_id, status), so a second 'failed' episode
-- (failed -> manual retry -> processing -> failed) was swallowed by ON CONFLICT DO
-- NOTHING and the buyer never received the second "需要人工协助处理" email. Support
-- accepted that as a real gap (P0#4 criterion 8).
--
-- Episode numbering: the trigger counts existing rows for (order_id, status) and
-- inserts episode = max+1. Within one episode the trigger still only fires when the
-- status actually changes, so repeated writes of the same status stay deduped.
--
-- Expand-only: a column with a NOT NULL default plus a widened unique key. Old code
-- that inserts without naming `episode` still works (default 1) — it just cannot
-- produce episode 2, which is exactly the old behaviour.

ALTER TABLE email_outbox
  ADD COLUMN IF NOT EXISTS episode integer DEFAULT 1 NOT NULL;

ALTER TABLE email_outbox
  DROP CONSTRAINT IF EXISTS email_outbox_order_id_status_key;

ALTER TABLE email_outbox
  DROP CONSTRAINT IF EXISTS email_outbox_order_id_status_episode_key;

ALTER TABLE email_outbox
  ADD CONSTRAINT email_outbox_order_id_status_episode_key UNIQUE (order_id, status, episode);

CREATE OR REPLACE FUNCTION enqueue_order_email() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  next_episode integer;
BEGIN
  IF NEW.contact_email IS NOT NULL AND (TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
    SELECT COALESCE(MAX(episode),0)+1 INTO next_episode
      FROM email_outbox WHERE order_id=NEW.id AND status=NEW.status;
    INSERT INTO email_outbox(id,order_id,status,episode)
      VALUES(NEW.id||':'||NEW.status||':'||next_episode,NEW.id,NEW.status,next_episode)
      ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
