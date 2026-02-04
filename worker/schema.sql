-- Agent Service Exchange Database Schema
-- D1 SQLite database for off-chain metadata

CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    price_usdc INTEGER NOT NULL,
    provider_address TEXT NOT NULL,
    category TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_services_provider ON services(provider_address);
CREATE INDEX IF NOT EXISTS idx_services_category ON services(category);
CREATE INDEX IF NOT EXISTS idx_services_status ON services(status);

CREATE TABLE IF NOT EXISTS service_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id INTEGER NOT NULL,
    buyer_address TEXT NOT NULL,
    provider_address TEXT NOT NULL,
    tx_hash TEXT NOT NULL UNIQUE,
    status TEXT DEFAULT 'pending',
    amount_usdc INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (service_id) REFERENCES services(id)
);

CREATE INDEX IF NOT EXISTS idx_requests_service ON service_requests(service_id);
CREATE INDEX IF NOT EXISTS idx_requests_buyer ON service_requests(buyer_address);
CREATE INDEX IF NOT EXISTS idx_requests_status ON service_requests(status);

CREATE TABLE IF NOT EXISTS agent_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_address TEXT NOT NULL,
    request_id INTEGER NOT NULL,
    rater_address TEXT NOT NULL,
    score INTEGER NOT NULL CHECK (score >= 1 AND score <= 5),
    review TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (request_id) REFERENCES service_requests(id),
    UNIQUE(agent_address, request_id, rater_address)
);

CREATE INDEX IF NOT EXISTS idx_ratings_agent ON agent_ratings(agent_address);

CREATE TABLE IF NOT EXISTS agent_profiles (
    address TEXT PRIMARY KEY,
    total_services INTEGER DEFAULT 0,
    total_transactions INTEGER DEFAULT 0,
    total_volume_usdc INTEGER DEFAULT 0,
    rating_avg REAL DEFAULT 0,
    rating_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS exchange_stats (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    total_services INTEGER DEFAULT 0,
    total_transactions INTEGER DEFAULT 0,
    total_volume_usdc INTEGER DEFAULT 0,
    active_services INTEGER DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO exchange_stats (id) VALUES (1);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id INTEGER,
    actor_address TEXT,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
