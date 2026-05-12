-- session.title (#255): the daemon's session-title tag (siropkin/budi#779) lands
-- as a free-form string on `session_summaries`. Sources include the parser's
-- IntelliJ project name (`Verkada-Web`, `verkadalizer`), the session-type label
-- (`chat-agent`, `chat-edit`), or any future free-form tag. Nullable: older
-- daemons (≤ 8.4.8) don't send `title`, and Cursor / Claude Code sessions may
-- have no title locally either. Matches the existing pattern for `repo_id`,
-- `git_branch`, `ticket`. `IF NOT EXISTS` so re-applied migrations no-op.
ALTER TABLE session_summaries
    ADD COLUMN IF NOT EXISTS title TEXT;
