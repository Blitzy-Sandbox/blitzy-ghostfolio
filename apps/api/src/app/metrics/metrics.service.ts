import { Injectable } from '@nestjs/common';

/**
 * Mapping from a label name to its string value as supplied by callers.
 *
 * Used as the public parameter type for `incrementCounter` and
 * `observeHistogram`, and as the internal type for every label map produced by
 * the helper methods below. `Record<string, string>` is intentionally concrete
 * (no `any`) so consumers receive a strongly-typed surface.
 */
type LabelMap = Record<string, string>;

/**
 * Internal representation of a single histogram series for a particular
 * `(name, labelKey)` pairing. The cumulative `count` and running `sum` are
 * required to render the canonical `_count` and `_sum` lines in the
 * Prometheus exposition format. The `buckets` map keys are the upper-bound
 * thresholds (in seconds) and the values are the cumulative count of
 * observations whose value is `<=` the upper bound — matching Prometheus's
 * cumulative histogram semantics.
 */
interface HistogramObservation {
  buckets: Map<number, number>;
  count: number;
  sum: number;
}

/**
 * Default histogram bucket boundaries (seconds), aligned with the standard
 * `prom-client` defaults. Suitable for the latency-in-seconds histograms
 * declared by the surrounding feature work (chat first-token latency,
 * rebalancing latency, Snowflake sync latency). The conventional `+Inf`
 * bucket is rendered implicitly in `getRegistryAsText` from the running
 * total `count`, so it is not enumerated here.
 */
const DEFAULT_BUCKETS_SECONDS: number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10
];

/**
 * `MetricsService` — in-process counter and histogram registry exposed via a
 * Prometheus-compatible text exposition format.
 *
 * The service intentionally avoids any external Prometheus client library
 * (e.g., `prom-client`) and instead uses native `Map<string, ...>` data
 * structures. This keeps the dependency footprint minimal and is appropriate
 * for the single-process Ghostfolio runtime model. Multi-process aggregation
 * is out of scope; counters and histograms reset on every process restart.
 *
 * Public surface:
 * - `incrementCounter(name, value?, labels?)` — increment a monotonically
 *   non-decreasing counter, optionally tagged with label values.
 * - `observeHistogram(name, value, labels?)` — record a value into a
 *   bucketed histogram series, optionally tagged with label values.
 * - `getRegistryAsText()` — serialize the entire registry into the
 *   Prometheus 0.0.4 text exposition format consumable by `/metrics`
 *   scrapers.
 *
 * Thread-safety: Node.js runs JavaScript on a single event-loop thread, so
 * `Map` mutations never interleave; no explicit locking is required. All
 * mutations are O(1) amortized.
 */
@Injectable()
export class MetricsService {
  /**
   * Counter registry: outer key is the metric name (e.g.
   * `snowflake_sync_runs_total`); inner key is the serialized label set
   * (e.g. `result=success`); inner value is the cumulative count.
   * For unlabeled metrics, the inner key is the empty string.
   */
  private readonly counters = new Map<string, Map<string, number>>();

  /**
   * Histogram registry: outer key is the metric name (e.g.
   * `ai_chat_first_token_latency_seconds`); inner key is the serialized
   * label set; inner value is a `HistogramObservation` carrying cumulative
   * bucket counts plus running `count` and `sum`.
   */
  private readonly histograms = new Map<
    string,
    Map<string, HistogramObservation>
  >();

  /**
   * Increments a named counter by `value` (default `1`), optionally scoped
   * to a `labels` set. Multiple invocations for the same `(name, labels)`
   * pair accumulate into a single series; distinct label sets create
   * distinct series.
   *
   * Counters are expected to be monotonically non-decreasing per Prometheus
   * conventions. Negative `value` arguments are technically permitted but
   * not recommended; this method does not validate or reject them.
   *
   * @param name - The metric name (snake_case Prometheus identifier).
   * @param value - Increment amount (default `1`).
   * @param labels - Optional label dimensions for this observation.
   */
  public incrementCounter(
    name: string,
    value: number = 1,
    labels: LabelMap = {}
  ): void {
    const labelKey = this.serializeLabels(labels);
    const series = this.counters.get(name) ?? new Map<string, number>();

    series.set(labelKey, (series.get(labelKey) ?? 0) + value);
    this.counters.set(name, series);
  }

  /**
   * Records a single observation `value` into the named histogram, optionally
   * scoped to a `labels` set. The observation is added to every bucket whose
   * upper bound is `>= value` (cumulative semantics) and is folded into the
   * running `count` and `sum` of the matching series.
   *
   * @param name - The metric name (snake_case Prometheus identifier).
   * @param value - The observed value (in the unit implied by the metric
   *   name, typically seconds).
   * @param labels - Optional label dimensions for this observation.
   */
  public observeHistogram(
    name: string,
    value: number,
    labels: LabelMap = {}
  ): void {
    const labelKey = this.serializeLabels(labels);
    const series =
      this.histograms.get(name) ?? new Map<string, HistogramObservation>();

    const observation =
      series.get(labelKey) ?? this.createInitialHistogramObservation();

    observation.count += 1;
    observation.sum += value;

    for (const upperBound of DEFAULT_BUCKETS_SECONDS) {
      if (value <= upperBound) {
        observation.buckets.set(
          upperBound,
          (observation.buckets.get(upperBound) ?? 0) + 1
        );
      }
    }

    series.set(labelKey, observation);
    this.histograms.set(name, series);
  }

  /**
   * Serializes the entire registry into the canonical Prometheus 0.0.4 text
   * exposition format, suitable for direct return from an HTTP `/metrics`
   * endpoint. Counters render as `# TYPE <name> counter` followed by one
   * series line per label set. Histograms render as `# TYPE <name>
   * histogram` followed by per-bucket `<name>_bucket{le="..."} N` lines, an
   * implicit `<name>_bucket{le="+Inf"} N` line equal to the total count, the
   * `<name>_sum` line, and the `<name>_count` line.
   *
   * Returns an empty string when the registry has no recorded series. A
   * trailing newline is appended when output is non-empty per the
   * exposition-format specification.
   */
  public getRegistryAsText(): string {
    const lines: string[] = [];

    // Render counter series.
    for (const [name, series] of this.counters.entries()) {
      lines.push(`# TYPE ${name} counter`);

      for (const [labelKey, value] of series.entries()) {
        lines.push(`${name}${this.formatLabels(labelKey)} ${value}`);
      }
    }

    // Render histogram series.
    for (const [name, series] of this.histograms.entries()) {
      lines.push(`# TYPE ${name} histogram`);

      for (const [labelKey, observation] of series.entries()) {
        for (const [upperBound, bucketCount] of observation.buckets.entries()) {
          const bucketLabels = this.mergeLabels(labelKey, {
            le: String(upperBound)
          });

          lines.push(
            `${name}_bucket${this.formatLabels(bucketLabels)} ${bucketCount}`
          );
        }

        // The `+Inf` bucket count equals the total observation count by
        // definition — every observation falls into the `+Inf` bucket.
        const infBucketLabels = this.mergeLabels(labelKey, { le: '+Inf' });

        lines.push(
          `${name}_bucket${this.formatLabels(infBucketLabels)} ${observation.count}`
        );

        lines.push(
          `${name}_sum${this.formatLabels(labelKey)} ${observation.sum}`
        );
        lines.push(
          `${name}_count${this.formatLabels(labelKey)} ${observation.count}`
        );
      }
    }

    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
  }

  /**
   * Constructs a fresh `HistogramObservation` with each default bucket
   * pre-populated to `0`. Pre-populating every bucket ensures the resulting
   * exposition output reports a complete bucket ladder for the series even
   * before any observation has fallen into a particular bucket — required
   * by Prometheus consumers that expect a continuous series.
   */
  private createInitialHistogramObservation(): HistogramObservation {
    const buckets = new Map<number, number>();

    for (const upperBound of DEFAULT_BUCKETS_SECONDS) {
      buckets.set(upperBound, 0);
    }

    return { buckets, count: 0, sum: 0 };
  }

  /**
   * Serializes a `LabelMap` into a stable string key suitable for use as the
   * inner `Map` key. Label names are sorted alphabetically before joining so
   * that `{a:1, b:2}` and `{b:2, a:1}` always map to the same series — a
   * critical Prometheus invariant. The empty label map serializes to `''`.
   */
  private serializeLabels(labels: LabelMap): string {
    const keys = Object.keys(labels).sort();

    return keys.map((key) => `${key}=${labels[key]}`).join(',');
  }

  /**
   * Formats a serialized label key (e.g. `result=success,user_id=abc`) into
   * the Prometheus label-set syntax (e.g. `{result="success",user_id="abc"}`).
   * Returns the empty string for an empty label key so unlabeled series
   * render as bare metric names.
   */
  private formatLabels(labelKey: string): string {
    if (!labelKey) {
      return '';
    }

    const parts = labelKey.split(',').map((entry) => {
      const separatorIndex = entry.indexOf('=');
      const key = entry.slice(0, separatorIndex);
      const value = entry.slice(separatorIndex + 1);

      return `${key}="${this.escapeLabelValue(value)}"`;
    });

    return `{${parts.join(',')}}`;
  }

  /**
   * Merges an existing serialized label key with additional labels and
   * returns a fresh serialized key. Used to inject the histogram-specific
   * `le="..."` label onto each bucket without mutating the original series
   * key. Keys present in both maps are overridden by `additional`.
   */
  private mergeLabels(existingLabelKey: string, additional: LabelMap): string {
    const existing: LabelMap = {};

    if (existingLabelKey) {
      for (const entry of existingLabelKey.split(',')) {
        const separatorIndex = entry.indexOf('=');
        const key = entry.slice(0, separatorIndex);
        const value = entry.slice(separatorIndex + 1);

        existing[key] = value;
      }
    }

    return this.serializeLabels({ ...existing, ...additional });
  }

  /**
   * Escapes a label value per the Prometheus exposition-format
   * specification: backslashes, double quotes, and newlines are each
   * preceded by a backslash so the resulting string is safe to embed inside
   * a `"..."` literal in a metric line.
   */
  private escapeLabelValue(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');
  }
}
