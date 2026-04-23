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
import { authMiddleware } from '../auth';
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
    const absolutePath = path.join(UPLOADS_DIR, cheminRelatif);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, buffer);
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
    const absolutePath = path.join(UPLOADS_DIR, cheminRelatif);
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
    const absolutePath = path.join(UPLOADS_DIR, cheminRelatif);
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

  if (!checkEntityExists(entite, entite_id)) {
    return res.status(404).json({ error: 'Entite introuvable' });
  }

  if (!canAccessEntity(req.user, entite, entite_id)) {
    return res.status(403).json({ error: 'Droits insuffisants' });
  }

  const currentSize = getEntityTotalSize(entite, entite_id);
  if (currentSize + file.size > MAX_ENTITY_TOTAL_SIZE) {
    return res.status(400).json({ error: 'Taille totale depassee (50 Mo maximum par entite)' });
  }

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
    const info = db
      .prepare(
        `INSERT INTO pieces_jointes (entite, entite_id, nom, mime_type, taille, chemin, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entite, entite_id, nom, file.mimetype, file.size, chemin, req.user?.id ?? null);

    const id = Number(info.lastInsertRowid);
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
  } catch {
    await deleteStoredFile(chemin).catch(() => undefined);
    return res.status(500).json({ error: 'Echec lors de l’enregistrement en base' });
  }
});

piecesJointesRouter.get('/:id', async (req, res) => {
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
});

piecesJointesRouter.delete('/:id', (req, res) => {
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
