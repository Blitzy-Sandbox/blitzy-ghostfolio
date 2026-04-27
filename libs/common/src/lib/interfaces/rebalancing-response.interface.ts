export interface RebalancingRecommendation {
  action: 'BUY' | 'SELL' | 'HOLD';
  ticker: string;
  fromPct: number;
  toPct: number;
  rationale: string;
  goalReference: string;
}

export interface RebalancingResponse {
  recommendations: RebalancingRecommendation[];
  summary: string;
  warnings: string[];
}
