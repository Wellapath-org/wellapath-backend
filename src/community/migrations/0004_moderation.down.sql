DROP TABLE IF EXISTS account_restrictions;
DROP TABLE IF EXISTS moderation_actions;
DROP TABLE IF EXISTS reports;
-- Shared with auth_events (0007), which is dropped first by the down order.
DROP FUNCTION IF EXISTS community_reject_change();
DROP FUNCTION IF EXISTS community_force_server_time();
