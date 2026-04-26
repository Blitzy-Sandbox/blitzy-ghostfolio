export interface OrdersHistoryRow {
  currency: string;
  date: string;
  fee: number;
  order_id: string;
  quantity: number;
  synced_at: string;
  ticker: string | null;
  type: string;
  unit_price: number;
  user_id: string;
}

export interface PerformanceMetricRow {
  metric_date: string;
  sharpe_ratio: number;
  twr: number;
  user_id: string;
  volatility: number;
}

export interface PortfolioSnapshotRow {
  allocation_pct: number;
  asset_class: string;
  snapshot_date: string;
  total_value_usd: number;
  user_id: string;
}
