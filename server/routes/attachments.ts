import { Router } from 'express';
import multer from 'multer';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { attachments, brandSettings, entityAttachments } from '../db/schema/index';
import { orgCtx, requirePermission } from '../middleware/auth';
import { asyncHandler, parseBody, parseParams } from '../middleware/validate';
import { rateLimit } from '../middleware/rate-limit';
import { AppError } from '../lib/errors';
import { getStorage } from '../storage/adapter';
import { writeAuditEvent } from '../accounting/audit';

export const attachmentsRouter = Router();

const IdParam = z.object({ id: z.string().uuid() });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

/**
 * Prototype Core accepts only these types, verified by extension, declared
 * MIME type, AND magic bytes. Office documents, archives, HTML, and SVG are
 * rejected until a real malware-scanning pipeline exists. Without a scanner,
 * files are stored as unscanned_download_only and are never inline-rendered.
 */
const ALLOWED: Record<string, { mimes: string[]; magic: (b: Buffer) => boolean }> = {
  pdf: {
    mimes: ['application/pdf'],
    magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  },
  png: {
    mimes: ['image/png'],
    magic: (b) =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  jpg: {
    mimes: ['image/jpeg'],
    magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  jpeg: {
    mimes: ['image/jpeg'],
    magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  webp: {
    mimes: ['image/webp'],
    magic: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  csv: {
    mimes: ['text/csv', 'application/vnd.ms-excel', 'text/plain'],
    magic: (b) => !b.subarray(0, 4096).includes(0),
  },
};

function validateFile(originalName: string, mime: string, data: Buffer): string {
  const ext = originalName.split('.').pop()?.toLowerCase() ?? '';
  const rule = ALLOWED[ext];
  if (!rule) {
    throw AppError.unprocessable(
      'UNSUPPORTED_FILE_TYPE',
      'Only PDF, PNG, JPEG, WebP, and CSV files are accepted',
    );
  }
  if (!rule.mimes.includes(mime)) {
    throw AppError.unprocessable(
      'FILE_TYPE_MISMATCH',
      'The file type does not match its extension',
    );
  }
  if (data.length === 0 || !rule.magic(data)) {
    throw AppError.unprocessable(
      'FILE_CONTENT_MISMATCH',
      'The file content does not match its type',
    );
  }
  return ext;
}

attachmentsRouter.post(
  '/attachments',
  requirePermission('attachments.create'),
  rateLimit({ name: 'uploads', limit: 60, windowSeconds: 300 }),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const storage = getStorage();
    if (!storage.available) {
      throw AppError.serviceUnavailable(
        'STORAGE_NOT_CONFIGURED',
        'File storage is not configured for this deployment yet',
      );
    }
    const file = req.file;
    if (!file) throw AppError.validation('Attach a file under the "file" field');
    const kind = z
      .enum(['brand_asset', 'receipt', 'document', 'statement', 'other'])
      .default('other')
      .parse(req.body?.kind ?? 'other');
    validateFile(file.originalname, file.mimetype, file.buffer);
    if (
      kind === 'brand_asset' &&
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)
    ) {
      throw AppError.unprocessable(
        'UNSUPPORTED_FILE_TYPE',
        'Brand assets must be PNG, JPEG, or WebP',
      );
    }
    // Random server-generated key; user filenames are metadata only.
    const storageKey = randomBytes(24).toString('hex');
    await storage.put(storageKey, file.buffer);
    const db = getDb();
    const [row] = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(attachments)
        .values({
          organizationId: ctx.organizationId,
          storageKey,
          originalFilename: file.originalname.slice(0, 200),
          mimeType: file.mimetype,
          byteSize: file.buffer.length,
          sha256: createHash('sha256').update(file.buffer).digest('hex'),
          scanState: 'unscanned_download_only',
          kind,
          uploadedByUserId: ctx.userId,
        })
        .returning();
      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        action: 'attachment.uploaded',
        entityType: 'attachment',
        entityId: inserted[0]!.id,
        payload: { filename: file.originalname.slice(0, 200), bytes: file.buffer.length, kind },
        correlationId: req.correlationId,
      });
      return inserted;
    });
    res.status(201).json(row);
  }),
);

attachmentsRouter.get(
  '/attachments',
  requirePermission('attachments.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const db = getDb();
    const rows = await db
      .select()
      .from(attachments)
      .where(eq(attachments.organizationId, ctx.organizationId))
      .orderBy(desc(attachments.createdAt))
      .limit(500);
    const links = await db
      .select()
      .from(entityAttachments)
      .where(eq(entityAttachments.organizationId, ctx.organizationId));
    const linksByAttachment = new Map<string, { entityType: string; entityId: string }[]>();
    for (const link of links) {
      const list = linksByAttachment.get(link.attachmentId) ?? [];
      list.push({ entityType: link.entityType, entityId: link.entityId });
      linksByAttachment.set(link.attachmentId, list);
    }
    res.json({
      storageAvailable: getStorage().available,
      items: rows.map((r) => ({ ...r, links: linksByAttachment.get(r.id) ?? [] })),
    });
  }),
);

/** Server-mediated download; never inline for unscanned files. */
attachmentsRouter.get(
  '/attachments/:id/download',
  requirePermission('attachments.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const db = getDb();
    const [row] = await db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, id), eq(attachments.organizationId, ctx.organizationId)))
      .limit(1);
    if (!row) throw AppError.notFound('Attachment not found');
    const data = await getStorage().get(row.storageKey);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${row.originalFilename.replace(/[^A-Za-z0-9._ -]/g, '_')}"`,
    );
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(data);
  }),
);

const LinkSchema = z.object({
  entityType: z.enum([
    'invoice',
    'estimate',
    'bill',
    'expense',
    'customer',
    'vendor',
    'credit_memo',
    'reconciliation',
  ]),
  entityId: z.string().uuid(),
});

attachmentsRouter.post(
  '/attachments/:id/link',
  requirePermission('attachments.create'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, LinkSchema);
    const db = getDb();
    const [row] = await db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, id), eq(attachments.organizationId, ctx.organizationId)))
      .limit(1);
    if (!row) throw AppError.notFound('Attachment not found');
    await db
      .insert(entityAttachments)
      .values({
        organizationId: ctx.organizationId,
        attachmentId: id,
        entityType: body.entityType,
        entityId: body.entityId,
      })
      .onConflictDoNothing();
    res.json({ ok: true });
  }),
);

attachmentsRouter.delete(
  '/attachments/:id',
  requirePermission('attachments.create'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const db = getDb();
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(attachments)
        .where(and(eq(attachments.id, id), eq(attachments.organizationId, ctx.organizationId)))
        .for('update')
        .limit(1);
      if (!row) throw AppError.notFound('Attachment not found');
      const [linked] = await tx
        .select()
        .from(entityAttachments)
        .where(eq(entityAttachments.attachmentId, id))
        .limit(1);
      if (linked) {
        throw AppError.conflict(
          'ATTACHMENT_LINKED',
          'This file is attached to a record and is retained with it',
        );
      }
      const [brandUse] = await tx
        .select({ id: brandSettings.id })
        .from(brandSettings)
        .where(
          and(
            eq(brandSettings.organizationId, ctx.organizationId),
            eq(brandSettings.primaryLogoAttachmentId, id),
          ),
        )
        .limit(1);
      if (brandUse) {
        throw AppError.conflict('ATTACHMENT_LINKED', 'This file is in use as the company logo');
      }
      await tx.delete(attachments).where(eq(attachments.id, id));
      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        action: 'attachment.deleted',
        entityType: 'attachment',
        entityId: id,
        payload: { filename: row.originalFilename },
        correlationId: req.correlationId,
      });
      await getStorage().remove(row.storageKey);
    });
    res.json({ ok: true });
  }),
);

/** Sets the uploaded image as the company's primary logo. */
attachmentsRouter.post(
  '/brand/logo',
  requirePermission('brand.edit'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, z.object({ attachmentId: z.string().uuid().nullable() }));
    const db = getDb();
    await db.transaction(async (tx) => {
      if (body.attachmentId) {
        const [row] = await tx
          .select()
          .from(attachments)
          .where(
            and(
              eq(attachments.id, body.attachmentId),
              eq(attachments.organizationId, ctx.organizationId),
              eq(attachments.kind, 'brand_asset'),
            ),
          )
          .limit(1);
        if (!row) throw AppError.validation('Upload the logo as a brand asset first');
      }
      const [brand] = await tx
        .select()
        .from(brandSettings)
        .where(eq(brandSettings.organizationId, ctx.organizationId))
        .for('update')
        .limit(1);
      if (!brand) throw AppError.internal();
      await tx
        .update(brandSettings)
        .set({
          primaryLogoAttachmentId: body.attachmentId,
          brandVersion: brand.brandVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(brandSettings.id, brand.id));
      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        action: 'brand.logo_updated',
        entityType: 'brand_settings',
        payload: { attachmentId: body.attachmentId },
        correlationId: req.correlationId,
      });
    });
    res.json({ ok: true });
  }),
);
