CREATE TABLE IF NOT EXISTS stripe_approval_event (
    id BIGSERIAL PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    approval_request_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    dashboard_url TEXT,
    expires_at TEXT,
    received_at BIGINT NOT NULL,
    payload JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS stripe_approval_event_by_request
    ON stripe_approval_event (approval_request_id, id);

CREATE OR REPLACE VIEW stripe_approval_latest AS
SELECT DISTINCT ON (approval_request_id)
    approval_request_id,
    status,
    type AS last_event_type,
    dashboard_url,
    expires_at,
    received_at
FROM stripe_approval_event
ORDER BY approval_request_id, id DESC;
