-- Snowflake DDL bootstrap script for the Ghostfolio Snowflake Sync Layer (Feature A).
-- Executed by SnowflakeSyncService.bootstrap() on application startup.
-- Each statement uses CREATE TABLE IF NOT EXISTS, so re-running is safe (Rule 7 idempotency).
-- Statements MUST be separated by a semicolon followed by a newline (the bootstrap loader
-- splits on /;\s*\n/ and executes each statement independently).
-- See AAP sections 0.1.2.4, 0.4.1.3, 0.5.1.1, 0.7.1.7, 0.7.3.

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  snapshot_date    DATE   NOT NULL,
  user_id          STRING NOT NULL,
  asset_class      STRING NOT NULL,
  allocation_pct   FLOAT,
  total_value_usd  FLOAT,
  CONSTRAINT pk_portfolio_snapshots PRIMARY KEY (snapshot_date, user_id, asset_class)
);

CREATE TABLE IF NOT EXISTS orders_history (
  order_id    STRING        NOT NULL,
  user_id     STRING        NOT NULL,
  date        DATE          NOT NULL,
  type        STRING        NOT NULL,
  ticker      STRING,
  quantity    FLOAT,
  unit_price  FLOAT,
  fee         FLOAT,
  currency    STRING,
  synced_at   TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  CONSTRAINT pk_orders_history PRIMARY KEY (order_id)
);

CREATE TABLE IF NOT EXISTS performance_metrics (
  metric_date   DATE   NOT NULL,
  user_id       STRING NOT NULL,
  twr           FLOAT,
  volatility    FLOAT,
  sharpe_ratio  FLOAT,
  CONSTRAINT pk_performance_metrics PRIMARY KEY (metric_date, user_id)
);
