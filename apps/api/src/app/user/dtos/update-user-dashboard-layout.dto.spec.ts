import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { UpdateUserDashboardLayoutDto } from './update-user-dashboard-layout.dto';

/**
 * Validation tests for `UpdateUserDashboardLayoutDto`.
 *
 * These tests exercise the DTO through a `ValidationPipe` configured EXACTLY
 * like the global pipe registered in `apps/api/src/main.ts`
 * (`{ forbidNonWhitelisted: true, transform: true, whitelist: true }`), so the
 * behavior asserted here is the behavior the controller actually receives at
 * runtime for `PATCH /api/v1/user/layout`.
 *
 * Primary guarantee (CWE-20 input-validation hardening): a request body that
 * omits the required top-level `layoutData` — e.g. `{}` or
 * `{ layoutData: undefined }` — is rejected with HTTP 400 before reaching the
 * controller/service, while a well-formed `{ layoutData: { schemaVersion,
 * items } }` payload passes. Without the `@IsDefined()` decorator on
 * `layoutData`, `@ValidateNested()` alone silently skips an omitted value and
 * the malformed body would pass.
 */
describe('UpdateUserDashboardLayoutDto', () => {
  let pipe: ValidationPipe;

  // A minimal valid layout payload: a schema version plus one 6x4 module
  // (both dimensions satisfy the 2x2 minimum enforced by `@Min(2)`).
  const validPayload = {
    layoutData: {
      items: [
        { cols: 6, moduleKey: 'portfolio-overview', rows: 4, x: 0, y: 0 }
      ],
      schemaVersion: 1
    }
  };

  // Runs a candidate request body through the pipe with the metadata NestJS
  // supplies for an `@Body()` parameter typed as `UpdateUserDashboardLayoutDto`.
  // `ValidationPipe.transform` is typed as `Promise<any>`; the assertion narrows
  // the resolved value to the DTO so the successful-path assertions are typed.
  const validate = (body: unknown) =>
    pipe.transform(body, {
      data: '',
      metatype: UpdateUserDashboardLayoutDto,
      type: 'body'
    }) as Promise<UpdateUserDashboardLayoutDto>;

  beforeEach(() => {
    pipe = new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true
    });
  });

  describe('layoutData requiredness (CWE-20 hardening)', () => {
    it('rejects an empty body `{}` (omitted layoutData) with HTTP 400', async () => {
      await expect(validate({})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects `{ layoutData: undefined }` with HTTP 400', async () => {
      await expect(validate({ layoutData: undefined })).rejects.toBeInstanceOf(
        BadRequestException
      );
    });

    it('rejects `{ layoutData: null }` with HTTP 400', async () => {
      await expect(validate({ layoutData: null })).rejects.toBeInstanceOf(
        BadRequestException
      );
    });

    it('names `layoutData` in the validation error when it is omitted', async () => {
      expect.assertions(2);

      try {
        await validate({});
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);

        const response = (error as BadRequestException).getResponse() as {
          message: string | string[];
        };
        const messages = Array.isArray(response.message)
          ? response.message
          : [response.message];

        expect(messages.join(' ')).toContain('layoutData');
      }
    });
  });

  describe('valid payloads', () => {
    it('accepts `{ layoutData: { schemaVersion, items } }` and returns a DTO instance', async () => {
      const result = await validate(validPayload);

      expect(result).toBeInstanceOf(UpdateUserDashboardLayoutDto);
      expect(result.layoutData.schemaVersion).toBe(1);
      expect(result.layoutData.items).toHaveLength(1);
      expect(result.layoutData.items[0].moduleKey).toBe('portfolio-overview');
    });

    it('accepts a layout with an empty items array', async () => {
      const result = await validate({
        layoutData: { items: [], schemaVersion: 1 }
      });

      expect(result).toBeInstanceOf(UpdateUserDashboardLayoutDto);
      expect(result.layoutData.items).toHaveLength(0);
    });
  });

  describe('nested geometry validation (defense-in-depth regression coverage)', () => {
    it('rejects a module with `cols` below the 2x2 minimum', async () => {
      await expect(
        validate({
          layoutData: {
            items: [{ cols: 1, moduleKey: 'holdings', rows: 4, x: 0, y: 0 }],
            schemaVersion: 1
          }
        })
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a module with `rows` below the 2x2 minimum', async () => {
      await expect(
        validate({
          layoutData: {
            items: [{ cols: 6, moduleKey: 'holdings', rows: 1, x: 0, y: 0 }],
            schemaVersion: 1
          }
        })
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
