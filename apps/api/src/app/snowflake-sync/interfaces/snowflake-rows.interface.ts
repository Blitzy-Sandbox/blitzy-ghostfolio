/**
 * TypeScript row shapes for the three Snowflake analytical tables created by
 * `apps/api/src/app/snowflake-sync/sql/bootstrap.sql`.
 *
 * Nullability mirrors the SQL DDL exactly:
 * - Columns declared `NOT NULL` are typed as required value types
 *   (e.g. `string`, `number`).
 * - Columns NOT declared `NOT NULL` are typed as `T | null` so that callers
 *   producing or consuming rows from the Snowflake driver are forced to
 *   handle the SQL `NULL` case explicitly. The `snowflake-sdk` driver returns
 *   JavaScript `null` for SQL `NULL`, so the type contract here matches the
 *   runtime value space precisely.
 *
 * See AAP §§ 0.4.1.3, 0.5.1.1 (per-feature schema specification) and the
 * code-review remediation notes for nullable-column type accuracy.
 */

export interface OrdersHistoryRow {
  /** Free-text ISO 4217 currency code (NULLABLE per bootstrap.sql). */
  currency: string | null;
  /** ISO-8601 date string (NOT NULL primary-key candidate). */
  date: string;
  /** Brokerage fee in `currency` units (NULLABLE per bootstrap.sql). */
  fee: number | null;
  /** Stable order identifier (PRIMARY KEY, NOT NULL). */
  order_id: string;
  /** Quantity of the asset transacted (NULLABLE per bootstrap.sql). */
  quantity: number | null;
  /**
   * UTC timestamp recorded by the sync layer. Snowflake DDL provides a
   * `DEFAULT CURRENT_TIMESTAMP()` so the runtime value is always present
   * after a successful insert, but the column has no `NOT NULL` constraint
   * and the driver may return `null` if explicitly written that way.
   */
  synced_at: string | null;
  /** Asset symbol (NULLABLE — instruments may be unknown for cash legs). */
  ticker: string | null;
  /** Discriminator for the trade leg (`BUY`, `SELL`, etc.). NOT NULL. */
  type: string;
  /** Per-unit price in `currency` units (NULLABLE per bootstrap.sql). */
  unit_price: number | null;
  /** Owning Ghostfolio user ID (NOT NULL). */
  user_id: string;
}

export interface PerformanceMetricRow {
  /** ISO-8601 date string (NOT NULL primary-key component). */
  metric_date: string;
  /** Risk-adjusted return ratio (NULLABLE per bootstrap.sql). */
  sharpe_ratio: number | null;
  /** Time-Weighted Return for the period (NULLABLE per bootstrap.sql). */
  twr: number | null;
  /** Owning Ghostfolio user ID (NOT NULL). */
  user_id: string;
  /** Standard deviation of returns (NULLABLE per bootstrap.sql). */
  volatility: number | null;
}

export interface PortfolioSnapshotRow {
  /** Allocation percentage in [0, 1] (NULLABLE per bootstrap.sql). */
  allocation_pct: number | null;
  /** Asset class label (NOT NULL primary-key component). */
  asset_class: string;
  /** ISO-8601 date string (NOT NULL primary-key component). */
  snapshot_date: string;
  /** Total holdings value in USD (NULLABLE per bootstrap.sql). */
  total_value_usd: number | null;
  /** Owning Ghostfolio user ID (NOT NULL primary-key component). */
  user_id: string;
}
