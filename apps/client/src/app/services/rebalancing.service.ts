import { RebalancingResponse } from '@ghostfolio/common/interfaces';

import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

/**
 * Optional override fields for a rebalancing request.
 *
 * Per AAP § 0.5.1.1, the request DTO accepts optional override fields
 * (e.g., a target allocation map). The shape mirrors the server-side
 * `RebalancingRequestDto`'s lenient `Record<string, number>` contract — the
 * server is the authoritative coercion layer, so the client interface
 * stays intentionally narrow. When the public contract is finalized this
 * shape can evolve to a richer typed structure (e.g.,
 * `Array<{ symbol: string; percentage: number }>`).
 */
export interface RebalancingRequest {
  /**
   * Optional target allocation override expressed as a map from ticker
   * symbol to allocation percentage (0–100). When omitted, the server
   * computes recommendations against the user's current portfolio without
   * any caller-supplied overrides.
   */
  targetAllocation?: Record<string, number>;
}

/**
 * Server endpoint for the explainable rebalancing engine (Feature C).
 *
 * Per AAP § 0.1.1.1, all backend routes are URI-versioned through `/api/v1`.
 */
const REBALANCING_ENDPOINT = '/api/v1/ai/rebalancing';

/**
 * Client-side wrapper for the rebalancing engine endpoint.
 *
 * Unlike {@link AiChatService}, this service uses the standard Angular
 * `HttpClient`, which means the registered `AuthInterceptor` automatically
 * attaches the `Authorization: Bearer <token>` header. No manual token
 * handling is required here.
 *
 * The endpoint returns a fully-formed {@link RebalancingResponse} sourced
 * exclusively from the Anthropic SDK's `tool_use` content block (Rule 4),
 * so the client only needs to forward the optional override payload and
 * surface the structured response to the calling component.
 */
@Injectable({ providedIn: 'root' })
export class RebalancingService {
  public constructor(private httpClient: HttpClient) {}

  /**
   * Requests a rebalancing recommendation from the server. The server
   * derives the user's current portfolio and `FinancialProfile` from the
   * JWT-authenticated session — never from the request body — so the
   * caller only supplies (optional) override fields.
   */
  public getRecommendations(
    request: RebalancingRequest = {}
  ): Observable<RebalancingResponse> {
    return this.httpClient.post<RebalancingResponse>(
      REBALANCING_ENDPOINT,
      request
    );
  }
}
