import { TransformDataSourceInRequestInterceptor } from '@ghostfolio/api/interceptors/transform-data-source-in-request/transform-data-source-in-request.interceptor';
import {
  DataEnhancerHealthResponse,
  DataProviderHealthResponse
} from '@ghostfolio/common/interfaces';

import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Res,
  UseInterceptors
} from '@nestjs/common';
import { DataSource } from '@prisma/client';
import { Response } from 'express';
import { StatusCodes, getReasonPhrase } from 'http-status-codes';

import { HealthService } from './health.service';
import { SnowflakeHealthIndicator } from './snowflake-health.indicator';

@Controller('health')
export class HealthController {
  public constructor(
    private readonly healthService: HealthService,
    private readonly snowflakeHealthIndicator: SnowflakeHealthIndicator
  ) {}

  @Get()
  public async getHealth(@Res() response: Response) {
    const databaseServiceHealthy = await this.healthService.isDatabaseHealthy();
    const redisCacheServiceHealthy =
      await this.healthService.isRedisCacheHealthy();

    if (databaseServiceHealthy && redisCacheServiceHealthy) {
      return response
        .status(HttpStatus.OK)
        .json({ status: getReasonPhrase(StatusCodes.OK) });
    } else {
      return response
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json({ status: getReasonPhrase(StatusCodes.SERVICE_UNAVAILABLE) });
    }
  }

  @Get('data-enhancer/:name')
  public async getHealthOfDataEnhancer(
    @Param('name') name: string,
    @Res() response: Response
  ): Promise<Response<DataEnhancerHealthResponse>> {
    const hasResponse =
      await this.healthService.hasResponseFromDataEnhancer(name);

    if (hasResponse) {
      return response.status(HttpStatus.OK).json({
        status: getReasonPhrase(StatusCodes.OK)
      });
    } else {
      return response
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json({ status: getReasonPhrase(StatusCodes.SERVICE_UNAVAILABLE) });
    }
  }

  @Get('data-provider/:dataSource')
  @UseInterceptors(TransformDataSourceInRequestInterceptor)
  public async getHealthOfDataProvider(
    @Param('dataSource') dataSource: DataSource,
    @Res() response: Response
  ): Promise<Response<DataProviderHealthResponse>> {
    if (!DataSource[dataSource]) {
      throw new HttpException(
        getReasonPhrase(StatusCodes.NOT_FOUND),
        StatusCodes.NOT_FOUND
      );
    }

    const hasResponse =
      await this.healthService.hasResponseFromDataProvider(dataSource);

    if (hasResponse) {
      return response
        .status(HttpStatus.OK)
        .json({ status: getReasonPhrase(StatusCodes.OK) });
    } else {
      return response
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json({ status: getReasonPhrase(StatusCodes.SERVICE_UNAVAILABLE) });
    }
  }

  /**
   * Lightweight readiness probe for the Snowflake analytical backend that
   * supports the Snowflake Sync layer (Feature A, AAP § 0.1.1) and the
   * chat-agent `query_history` tool (Feature B, AAP § 0.5.1.5).
   *
   * Resolves with HTTP 200 when `SnowflakeHealthIndicator.isHealthy()`
   * returns `true` (a `SELECT 1` round-trip succeeded against the
   * configured Snowflake warehouse within the indicator's
   * `PROBE_TIMEOUT_MS` guard), or HTTP 503 otherwise. The indicator is
   * fail-closed: any error from `getConnection()` or `execute(...)` is
   * funneled to `false` after a redacted warning is logged, so this
   * route NEVER surfaces an unhandled HTTP 500 — orchestrators
   * (Kubernetes, ECS) and operators see a deterministic 200/503
   * boolean exactly mirroring the existing `/api/v1/health` aggregate
   * route shape.
   *
   * Operationalizes AAP § 0.5.1.2 (additive `SnowflakeHealthIndicator`
   * registration) and AAP § 0.7.2 (Observability rule — health probes
   * for every new external dependency).
   */
  @Get('snowflake')
  public async getHealthOfSnowflake(@Res() response: Response) {
    const snowflakeHealthy = await this.snowflakeHealthIndicator.isHealthy();

    if (snowflakeHealthy) {
      return response
        .status(HttpStatus.OK)
        .json({ status: getReasonPhrase(StatusCodes.OK) });
    } else {
      return response
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .json({ status: getReasonPhrase(StatusCodes.SERVICE_UNAVAILABLE) });
    }
  }
}
