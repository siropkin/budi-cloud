-- Multi-use invite links (issue #68)
--
-- Switches `invite_tokens` from single-use (one `used_by`/`used_at` slot per
-- token) to multi-use: any signed-in user who clicks before `expires_at` can
-- join the inviter's org. The audit trail of "who joined via which token"
-- moves into a child `invite_redemptions` table so the token itself stops
-- carrying redemption state.

-- ============================================================
-- 1. New child table: one row per (token, user) redemption
-- ============================================================

CREATE TABLE IF NOT EXISTS invite_redemptions (
    token_id     TEXT NOT NULL REFERENCES invite_tokens(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redeemed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (token_id, user_id)
);

ALTER TABLE invite_redemptions ENABLE ROW LEVEL SECURITY;

-- Mirrors the `invite_tokens` SELECT policy: managers can read redemptions
-- only for tokens that belong to their own org.
CREATE POLICY "Managers can read org invite redemptions"
    ON invite_redemptions FOR SELECT
    USING (
        token_id IN (
            SELECT id FROM invite_tokens
            WHERE org_id IN (
                SELECT org_id FROM users
                WHERE id = auth.uid()::text
                  AND role = 'manager'
            )
        )
    );

-- ============================================================
-- 2. Backfill audit history from the legacy single-use columns
-- ============================================================

INSERT INTO invite_redemptions (token_id, user_id, redeemed_at)
SELECT id, used_by, COALESCE(used_at, created_at)
FROM invite_tokens
WHERE used_by IS NOT NULL
ON CONFLICT (token_id, user_id) DO NOTHING;

-- ============================================================
-- 3. Drop the now-dead single-use columns
-- ============================================================

ALTER TABLE invite_tokens DROP COLUMN IF EXISTS used_by;
ALTER TABLE invite_tokens DROP COLUMN IF EXISTS used_at;
