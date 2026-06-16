import {
  ArgumentMetadata,
  BadRequestException,
  ValidationPipe
} from '@nestjs/common';
import 'reflect-metadata';

import { UpdateUserDashboardLayoutDto } from './update-user-dashboard-layout.dto';

/**
 * Validation tests for `UpdateUserDashboardLayoutDto`
 * (`PATCH /api/v1/user/layout` request body).
 *
 * These tests drive the DTO through a `ValidationPipe` configured IDENTICALLY
 * to the global pipe wired in `apps/api/src/main.ts`
 * (`{ forbidNonWhitelisted: true, transform: true, whitelist: true }`), so they
 * assert the exact runtime behavior the endpoint sees at the HTTP boundary: a
 * malformed body is rejected with a `BadRequestException` (HTTP 400) BEFORE the
 * controller/persistence layer runs, and a well-formed body is transformed into
 * a typed DTO instance.
 *
 * Regression coverage for the CWE-20 input-validation finding: a top-level
 * `layoutData` that is missing, `null`, an array, or a primitive must NOT
 * bypass validation and reach persistence.
 */
describe('UpdateUserDashboardLayoutDto', () => {
  const pipe = new ValidationPipe({
    forbidNonWhitelisted: true,
    transform: true,
    whitelist: true
  });

  const metadata: ArgumentMetadata = {
    metatype: UpdateUserDashboardLayoutDto,
    type: 'body'
  };

  const transform = (payload: unknown) => pipe.transform(payload, metadata);

  const validItem = {
    moduleKey: 'portfolio-overview',
    x: 0,
    y: 0,
    cols: 6,
    rows: 4
  };
  const validPayload = {
    layoutData: { schemaVersion: 1, items: [validItem] }
  };

  describe('rejects a malformed top-level layoutData (CWE-20 regression)', () => {
    it('rejects an empty body {} (layoutData missing)', async () => {
      await expect(transform({})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects { layoutData: null }', async () => {
      await expect(transform({ layoutData: null })).rejects.toBeInstanceOf(
        BadRequestException
      );
    });

    it('rejects { layoutData: [] } (array, not an object)', async () => {
      await expect(transform({ layoutData: [] })).rejects.toBeInstanceOf(
        BadRequestException
      );
    });

    it('rejects a non-empty array layoutData [item]', async () => {
      await expect(
        transform({ layoutData: [validItem] })
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a primitive (string) layoutData', async () => {
      await expect(
        transform({ layoutData: 'not-an-object' })
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an object layoutData missing schemaVersion and items', async () => {
      await expect(transform({ layoutData: {} })).rejects.toBeInstanceOf(
        BadRequestException
      );
    });
  });

  describe('rejects malformed nested item geometry / oversized payloads', () => {
    it('rejects an items array larger than the cap (> 50)', async () => {
      const items = Array.from({ length: 51 }, () => ({ ...validItem }));

      await expect(
        transform({ layoutData: { schemaVersion: 1, items } })
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects cols below the 2x2 minimum', async () => {
      await expect(
        transform({
          layoutData: { schemaVersion: 1, items: [{ ...validItem, cols: 1 }] }
        })
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects rows below the 2x2 minimum', async () => {
      await expect(
        transform({
          layoutData: { schemaVersion: 1, items: [{ ...validItem, rows: 1 }] }
        })
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a non-integer coordinate', async () => {
      await expect(
        transform({
          layoutData: { schemaVersion: 1, items: [{ ...validItem, x: 1.5 }] }
        })
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a moduleKey longer than the cap (> 100)', async () => {
      await expect(
        transform({
          layoutData: {
            schemaVersion: 1,
            items: [{ ...validItem, moduleKey: 'a'.repeat(101) }]
          }
        })
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unknown top-level property (forbidNonWhitelisted)', async () => {
      await expect(
        transform({ ...validPayload, userId: 'attacker' })
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('rejects unregistered / duplicate moduleKeys (QA F9 Issues 2 & 5)', () => {
    it('rejects an unknown (stale) moduleKey not in the registry allowlist', async () => {
      await expect(
        transform({
          layoutData: {
            schemaVersion: 1,
            items: [{ ...validItem, moduleKey: 'retired-module-key' }]
          }
        })
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a SQL-injection-shaped moduleKey', async () => {
      await expect(
        transform({
          layoutData: {
            schemaVersion: 1,
            items: [
              {
                ...validItem,
                moduleKey: 'summary; DROP TABLE "UserDashboardLayout"; --'
              }
            ]
          }
        })
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an XSS / markup-shaped moduleKey', async () => {
      await expect(
        transform({
          layoutData: {
            schemaVersion: 1,
            items: [{ ...validItem, moduleKey: '<img src=x onerror=alert(1)>' }]
          }
        })
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects duplicate moduleKeys in the items array', async () => {
      await expect(
        transform({
          layoutData: {
            schemaVersion: 1,
            items: [
              { ...validItem, moduleKey: 'summary' },
              { ...validItem, moduleKey: 'summary', x: 6 }
            ]
          }
        })
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('accepts a well-formed payload', () => {
    it('returns a typed UpdateUserDashboardLayoutDto instance', async () => {
      const result = await transform(validPayload);

      expect(result).toBeInstanceOf(UpdateUserDashboardLayoutDto);
      expect(result.layoutData.schemaVersion).toBe(1);
      expect(result.layoutData.items).toHaveLength(1);
      expect(result.layoutData.items[0]).toMatchObject(validItem);
    });

    it('accepts an empty items array (a valid object with zero modules)', async () => {
      const result = await transform({
        layoutData: { schemaVersion: 1, items: [] }
      });

      expect(result).toBeInstanceOf(UpdateUserDashboardLayoutDto);
      expect(result.layoutData.items).toHaveLength(0);
    });

    it('accepts multiple distinct registered modules', async () => {
      const result = await transform({
        layoutData: {
          schemaVersion: 1,
          items: [
            { moduleKey: 'holdings', x: 0, y: 0, cols: 6, rows: 4 },
            { moduleKey: 'ai-chat', x: 6, y: 0, cols: 6, rows: 4 }
          ]
        }
      });

      expect(result).toBeInstanceOf(UpdateUserDashboardLayoutDto);
      expect(result.layoutData.items).toHaveLength(2);
    });
  });
});
