/**
 * Response DTO mirroring the persisted `UserDashboardLayout` Prisma row shape
 * returned from `GET /api/v1/user/layout` and `PATCH /api/v1/user/layout`
 * exposed by `UserDashboardLayoutController`
 * (`apps/api/src/app/user/user-dashboard-layout.controller.ts`).
 *
 * Why an `interface` (not a `class` with class-validator decorators):
 * This file is a RESPONSE shape, not a REQUEST shape. The companion
 * `update-dashboard-layout.dto.ts` (sibling file) is a REQUEST DTO and uses
 * class-validator decorators on a `class` to enforce body validation at the
 * NestJS pipe layer. A response DTO has no runtime validation contract —
 * Prisma returns trusted, well-typed rows from the operational store — so
 * the structural-only `interface` form suffices. The JSDoc verbosity of the
 * established precedent at
 * `apps/api/src/app/user-financial-profile/dtos/financial-profile.dto.ts`
 * is preserved here; the validation decorators are intentionally omitted.
 *
 * Cross-references:
 *
 *   - AAP § 0.6.1.1 — Prisma model `UserDashboardLayout`
 *     (`userId String @id`, `layoutData Json`,
 *     `createdAt DateTime @default(now())`, `updatedAt DateTime @updatedAt`).
 *     The interface mirrors all four fields in the same order with
 *     TypeScript-equivalent types.
 *
 *   - AAP § 0.6.1.7 — Persistence payload shape
 *     `{ version: 1; items: LayoutItem[] }` where each `LayoutItem` is
 *     `{ moduleId: string; cols: number; rows: number; x: number; y: number }`.
 *     The shape is inlined here for self-containment.
 *
 *   - AAP § 0.0.1.2 — The controller uses `Promise<UserDashboardLayout>`
 *     from `@prisma/client` directly as its return type. This DTO exists
 *     as a documented response-shape reference for downstream consumers
 *     (Angular client mirror, OpenAPI generators) that want a transport-
 *     layer alias decoupled from Prisma's generated types so that
 *     schema-internal changes do not propagate into client code.
 *
 *   - AAP § 0.8.4 (Security) — Including `userId` in the RESPONSE shape
 *     is NOT a violation of Engineering Rule 5 (JWT-Authoritative
 *     Identity). Rule 5 forbids the SERVER reading `userId` from a
 *     REQUEST body. The companion REQUEST DTO
 *     (`update-dashboard-layout.dto.ts`) deliberately omits any
 *     user-identifier field per Rule 5; this RESPONSE shape legitimately
 *     echoes `userId` back to the client as row-identity confirmation.
 *
 * Future evolution: when schema version 2 is introduced, the `version`
 * literal type widens to `1 | 2`. The discriminator pattern enables
 * backwards-compatible migration without breaking the persisted PostgreSQL
 * `jsonb` column shape.
 */
export interface DashboardLayoutDto {
  /** Foreign-key identifier of the user owning this layout (UUID). */
  userId: string;

  /**
   * Persisted `jsonb` payload describing the dashboard composition: a
   * schema-version discriminator plus an ordered array of zero or more
   * layout items. Each item carries its registered module identifier,
   * cell extent (`cols`, `rows`), and grid origin (`x`, `y`).
   */
  layoutData: {
    version: 1;
    items: {
      moduleId: string;
      cols: number;
      rows: number;
      x: number;
      y: number;
    }[];
  };

  /** First-persistence timestamp (Prisma `@default(now())`). */
  createdAt: Date;

  /** Last-mutation timestamp (Prisma `@updatedAt`). */
  updatedAt: Date;
}
