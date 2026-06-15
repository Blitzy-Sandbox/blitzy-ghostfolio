export interface DashboardLayoutItem {
  moduleKey: string;
  x: number;
  y: number;
  cols: number;
  rows: number;
}

export interface LayoutData {
  schemaVersion: number;
  items: DashboardLayoutItem[];
}

export interface UserDashboardLayout {
  userId: string;
  layoutData: LayoutData;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/**
 * Client-to-server payload shape for `PATCH /api/v1/user/layout`.
 *
 * Server-only fields (`userId`, `createdAt`, `updatedAt`) are omitted —
 * those are sourced authoritatively by the server: `userId` is read from
 * the JWT, `createdAt` is set by the database default on first upsert, and
 * `updatedAt` is set by the `@updatedAt` Prisma directive.
 */
export type UserDashboardLayoutPatchPayload = Omit<
  UserDashboardLayout,
  'createdAt' | 'updatedAt' | 'userId'
>;
