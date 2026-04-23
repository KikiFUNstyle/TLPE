import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { type NextFunction, type Request, type Response, Router } from 'express';
import multer, { MulterError } from 'multer';
import { z } from 'zod';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { authMiddleware, requireRole } from '../auth';
import { db, logAudit } from '../db';

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_ENTITY_TOTAL_SIZE = 50 * 1024 * 1024;
const MIME_WHITELIST = new Set(['image/jpeg', 'image/png', 'application/pdf']);
const UPLOADS_DIR = path.resolve(__dirname, '..', '..', 'data', 'uploads');

const storageMode = (process.env.TLPE_UPLOAD_STORAGE || 'local').trim().toLowerCase();
const useS3 = storageMode === 's3';
const s3Bucket = process.env.TLPE_S3_BUCKET?.trim() || '';

const s3Client = useS3
  ? new S3Client({
      region: process.env.TLPE_S3_REGION || 'us-east-1',
      endpoint: process.env.TLPE_S3_ENDPOINT || undefined,
      forcePathStyle: process.env.TLPE_S3_FORCE_PATH_STYLE === 'true',
      credentials:
        process.env.TLPE_S3_ACCESS_KEY_ID && process.env.TLPE_S3_SECRET_ACCESS_KEY
          ? {
              accessKeyId: process.env.TLPE_S3_ACCESS_KEY_ID,
              secretAccessKey: process.env.TLPE_S3_SECRET_ACCESS_KEY,
            }
          : undefined,
    })
  : null;

if (!useS3 && !fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function resolveUploadAbsolutePath(cheminRelatif: string): string {
  const uploadRoot = path.resolve(UPLOADS_DIR);
  const absolutePath = path.resolve(uploadRoot, cheminRelatif);
  if (absolutePath !== uploadRoot && !absolutePath.startsWith(`${uploadRoot}${path.sep}`)) {
    throw new Error('invalid-path');
  }
  return absolutePath;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
  },
});

const createSchema = z.object({
  entite: z.enum(['dispositif', 'declaration', 'contentieux']),
  entite_id: z.coerce.number().int().positive(),
});

export const piecesJointesRouter = Router();
piecesJointesRouter.use(authMiddleware);
piecesJointesRouter.use(requireRole('admin', 'gestionnaire', 'contribuable'));

interface PieceJointeRow {
  id: number;
  entite: 'dispositif' | 'declaration' | 'contentieux';
  entite_id: number;
  nom: string;
  mime_type: string;
  taille: number;
  chemin: string;
  uploaded_by: number | null;
  created_at: string;
  deleted_at: string | null;
}

function sanitizeFileName(original: string): string {
  const trimmed = original.trim();
  const base = path.basename(trimmed).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.length > 0 ? base : 'fichier';
}

function fileExtensionForMime(mime: string): string {
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/png') return '.png';
  if (mime === 'application/pdf') return '.pdf';
  return '';
}

export function detectMimeFromMagicBytes(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (buffer.length >= 5 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46 && buffer[4] === 0x2d) {
    return 'application/pdf';
  }

  return null;
}

function buildStorageRelativePath(params: {
  entite: 'dispositif' | 'declaration' | 'contentieux';
  entiteId: number;
  filename: string;
  mimeType: string;
}): string {
  const now = new Date();
  const y = String(now.getUTCFullYear());
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const ext = path.extname(params.filename) || fileExtensionForMime(params.mimeType);
  const safeBase = sanitizeFileName(path.basename(params.filename, path.extname(params.filename)));
  const name = `${Date.now()}-${randomUUID()}-${safeBase}${ext}`;
  return path.posix.join(params.entite, String(params.entiteId), y, m, name);
}

function checkEntityExists(entite: 'dispositif' | 'declaration' | 'contentieux', entiteId: number): boolean {
  if (entite === 'dispositif') {
    const row = db.prepare('SELECT id FROM dispositifs WHERE id = ?').get(entiteId) as { id: number } | undefined;
    return !!row;
  }
  if (entite === 'declaration') {
    const row = db.prepare('SELECT id FROM declarations WHERE id = ?').get(entiteId) as { id: number } | undefined;
    return !!row;
  }
  const row = db.prepare('SELECT id FROM contentieux WHERE id = ?').get(entiteId) as { id: number } | undefined;
  return !!row;
}

function canAccessEntity(
  user: Express.Request['user'],
  entite: 'dispositif' | 'declaration' | 'contentieux',
  entiteId: number,
): boolean {
  if (!user) return false;
  if (user.role !== 'contribuable') return true;
  if (!user.assujetti_id) return false;

  if (entite === 'dispositif') {
    const row = db.prepare('SELECT assujetti_id FROM dispositifs WHERE id = ?').get(entiteId) as
      | { assujetti_id: number }
      | undefined;
    return !!row && row.assujetti_id === user.assujetti_id;
  }

  if (entite === 'declaration') {
    const row = db.prepare('SELECT assujetti_id FROM declarations WHERE id = ?').get(entiteId) as
      | { assujetti_id: number }
      | undefined;
    return !!row && row.assujetti_id === user.assujetti_id;
  }

  const row = db.prepare('SELECT assujetti_id FROM contentieux WHERE id = ?').get(entiteId) as
    | { assujetti_id: number }
    | undefined;
  return !!row && row.assujetti_id === user.assujetti_id;
}

function getEntityTotalSize(entite: 'dispositif' | 'declaration' | 'contentieux', entiteId: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(taille), 0) AS total
       FROM pieces_jointes
       WHERE entite = ? AND entite_id = ? AND deleted_at IS NULL`,
    )
    .get(entite, entiteId) as { total: number };
  return Number(row.total || 0);
}

async function saveFile(cheminRelatif: string, buffer: Buffer, mimeType: string): Promise<void> {
  if (!useS3) {
    const absolutePath = resolveUploadAbsolutePath(cheminRelatif);
    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.promises.writeFile(absolutePath, buffer);
    return;
  }

  if (!s3Client || !s3Bucket) {
    throw new Error('Configuration S3 incomplete');
  }

  await s3Client.send(
    new PutObjectCommand({
      Bucket: s3Bucket,
      Key: cheminRelatif,
      Body: buffer,
      ContentType: mimeType,
    }),
  );
}

async function deleteStoredFile(cheminRelatif: string): Promise<void> {
  if (!useS3) {
    const absolutePath = resolveUploadAbsolutePath(cheminRelatif);
    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
    }
    return;
  }

  if (!s3Client || !s3Bucket) {
    return;
  }

  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: s3Bucket,
      Key: cheminRelatif,
    }),
  );
}

async function readStoredFile(cheminRelatif: string): Promise<{
  stream: NodeJS.ReadableStream;
  contentType?: string;
  contentLength?: number;
}> {
  if (!useS3) {
    const absolutePath = resolveUploadAbsolutePath(cheminRelatif);
    if (!fs.existsSync(absolutePath)) {
      throw new Error('missing');
    }
    const stat = fs.statSync(absolutePath);
    return {
      stream: fs.createReadStream(absolutePath),
      contentLength: stat.size,
    };
  }

  if (!s3Client || !s3Bucket) {
    throw new Error('missing');
  }

  const object = (await s3Client.send(
    new GetObjectCommand({
      Bucket: s3Bucket,
      Key: cheminRelatif,
    }),
  )) as GetObjectCommandOutput;

  if (!object.Body) {
    throw new Error('missing');
  }

  return {
    stream: object.Body as NodeJS.ReadableStream,
    contentType: object.ContentType,
    contentLength: object.ContentLength,
  };
}

piecesJointesRouter.post('/', upload.single('fichier'), async (req, res) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'Fichier requis (champ "fichier")' });
    }

    const { entite, entite_id } = parsed.data;

    if (!MIME_WHITELIST.has(file.mimetype)) {
      return res.status(400).json({ error: 'Type de fichier non autorise (jpeg, png, pdf uniquement)' });
    }

    const detectedMime = detectMimeFromMagicBytes(file.buffer);
    if (!detectedMime || detectedMime !== file.mimetype) {
      return res.status(400).json({ error: 'Contenu du fichier incoherent avec le type MIME annonce' });
    }

    if (!checkEntityExists(entite, entite_id)) {
      return res.status(404).json({ error: 'Entite introuvable' });
    }

    if (!canAccessEntity(req.user, entite, entite_id)) {
      return res.status(403).json({ error: 'Droits insuffisants' });
    }

    const insertPieceJointe = db.transaction(
      (params: {
        entite: 'dispositif' | 'declaration' | 'contentieux';
        entite_id: number;
        nom: string;
        mime_type: string;
        taille: number;
        chemin: string;
        uploaded_by: number | null;
      }) => {
        const currentSize = getEntityTotalSize(params.entite, params.entite_id);
        if (currentSize + params.taille > MAX_ENTITY_TOTAL_SIZE) {
          throw new Error('quota-exceeded');
        }

        const info = db
          .prepare(
            `INSERT INTO pieces_jointes (entite, entite_id, nom, mime_type, taille, chemin, uploaded_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            params.entite,
            params.entite_id,
            params.nom,
            params.mime_type,
            params.taille,
            params.chemin,
            params.uploaded_by,
          );

        return Number(info.lastInsertRowid);
      },
    );

    const nom = sanitizeFileName(file.originalname);
    const chemin = buildStorageRelativePath({
      entite,
      entiteId: entite_id,
      filename: nom,
      mimeType: file.mimetype,
    });

    try {
      await saveFile(chemin, file.buffer, file.mimetype);
    } catch {
      return res.status(500).json({ error: 'Echec du stockage de la piece jointe' });
    }

    try {
      const id = insertPieceJointe({
        entite,
        entite_id,
        nom,
        mime_type: file.mimetype,
        taille: file.size,
        chemin,
        uploaded_by: req.user?.id ?? null,
      });
      logAudit({
        userId: req.user?.id ?? null,
        action: 'upload',
        entite: 'piece_jointe',
        entiteId: id,
        details: { entite, entite_id, nom, mime_type: file.mimetype, taille: file.size },
        ip: req.ip ?? null,
      });

      return res.status(201).json({
        id,
        entite,
        entite_id,
        nom,
        mime_type: file.mimetype,
        taille: file.size,
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'quota-exceeded') {
        await deleteStoredFile(chemin).catch(() => undefined);
        return res.status(400).json({ error: 'Taille totale depassee (50 Mo maximum par entite)' });
      }
      await deleteStoredFile(chemin).catch(() => undefined);
      return res.status(500).json({ error: 'Echec lors de l’enregistrement en base' });
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[pieces-jointes] erreur upload inattendue', error);
    return res.status(500).json({ error: 'Erreur interne upload' });
  }
});

piecesJointesRouter.get('/:id', async (req, res) => {
  try {
    const piece = db
      .prepare(
        `SELECT id, entite, entite_id, nom, mime_type, taille, chemin, uploaded_by, created_at, deleted_at
         FROM pieces_jointes
         WHERE id = ?`,
      )
      .get(req.params.id) as PieceJointeRow | undefined;

    if (!piece || piece.deleted_at) {
      return res.status(404).json({ error: 'Piece jointe introuvable' });
    }

    if (!canAccessEntity(req.user, piece.entite, piece.entite_id)) {
      return res.status(403).json({ error: 'Droits insuffisants' });
    }

    try {
      const stored = await readStoredFile(piece.chemin);
      res.setHeader('Content-Type', piece.mime_type || stored.contentType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(piece.nom)}"`);
      if (stored.contentLength ?? piece.taille) {
        res.setHeader('Content-Length', String(stored.contentLength ?? piece.taille));
      }

      logAudit({
        userId: req.user?.id ?? null,
        action: 'download',
        entite: 'piece_jointe',
        entiteId: piece.id,
        details: { entite: piece.entite, entite_id: piece.entite_id, nom: piece.nom },
        ip: req.ip ?? null,
      });

      stored.stream.on('error', () => {
        if (!res.headersSent) {
          res.status(500).json({ error: 'Lecture du fichier impossible' });
        } else {
          res.end();
        }
      });

      stored.stream.pipe(res);
      return;
    } catch {
      return res.status(404).json({ error: 'Fichier introuvable dans le stockage' });
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[pieces-jointes] erreur download inattendue', error);
    return res.status(500).json({ error: 'Erreur interne download' });
  }
});

piecesJointesRouter.delete('/:id', async (req, res) => {
  try {
    const piece = db
      .prepare(
        `SELECT id, entite, entite_id, nom, deleted_at
         FROM pieces_jointes
         WHERE id = ?`,
      )
      .get(req.params.id) as Pick<PieceJointeRow, 'id' | 'entite' | 'entite_id' | 'nom' | 'deleted_at'> | undefined;

    if (!piece || piece.deleted_at) {
      return res.status(404).json({ error: 'Piece jointe introuvable' });
    }

    if (!canAccessEntity(req.user, piece.entite, piece.entite_id)) {
      return res.status(403).json({ error: 'Droits insuffisants' });
    }

    db.prepare(`UPDATE pieces_jointes SET deleted_at = datetime('now') WHERE id = ?`).run(piece.id);
    logAudit({
      userId: req.user?.id ?? null,
      action: 'soft_delete',
      entite: 'piece_jointe',
      entiteId: piece.id,
      details: { entite: piece.entite, entite_id: piece.entite_id, nom: piece.nom },
      ip: req.ip ?? null,
    });

    return res.status(204).end();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[pieces-jointes] erreur suppression inattendue', error);
    return res.status(500).json({ error: 'Erreur interne suppression' });
  }
});

piecesJointesRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Fichier trop volumineux (10 Mo maximum)' });
    }
    return res.status(400).json({ error: `Erreur upload: ${err.code}` });
  }

  return res.status(500).json({ error: 'Erreur interne upload' });
});
