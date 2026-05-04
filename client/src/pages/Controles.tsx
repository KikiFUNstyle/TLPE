import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiBlobWithMetadata } from '../api';
import { useAuth, type Role } from '../auth';
import { formatEuro } from '../format';
import { AddressAutocomplete, type AddressSuggestion } from '../components/AddressAutocomplete';

export interface ControleCreateDispositifInput {
  assujetti_id: number;
  type_id: number;
  zone_id?: number | null;
  adresse_rue?: string | null;
  adresse_cp?: string | null;
  adresse_ville?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  surface?: number;
  nombre_faces?: number;
  statut?: 'declare' | 'controle' | 'litigieux' | 'depose' | 'exonere';
  notes?: string | null;
}

export interface ControleDraftInput {
  dispositif_id: number | null;
  create_dispositif: ControleCreateDispositifInput | null;
}

export const CONTROLE_FILE_ACCEPT = 'image/jpeg,image/png';

interface ControleRow {
  id: number;
  dispositif_id: number | null;
  date_controle: string;
  latitude: number;
  longitude: number;
  surface_mesuree: number;
  nombre_faces_mesurees: number;
  ecart_detecte: boolean;
  ecart_description: string | null;
  statut: 'saisi' | 'cloture';
  dispositif_identifiant: string | null;
  dispositif_surface: number | null;
  dispositif_nombre_faces: number | null;
  assujetti_raison_sociale: string | null;
  agent_nom: string;
  photos_count: number;
}

interface DispositifOption {
  id: number;
  identifiant: string;
  assujetti_raison_sociale: string;
  surface: number;
  nombre_faces: number;
  adresse_rue: string | null;
  adresse_cp: string | null;
  adresse_ville: string | null;
}

interface AssujettiOption {
  id: number;
  raison_sociale: string;
  identifiant_tlpe: string;
}

interface TypeOption {
  id: number;
  libelle: string;
  categorie: string;
}

interface ZoneOption {
  id: number;
  libelle: string;
  coefficient: number;
}

interface ControleReportRow {
  controle_id: number;
  dispositif_id: number | null;
  dispositif_identifiant: string | null;
  assujetti_id: number | null;
  assujetti_raison_sociale: string | null;
  date_controle: string;
  categorie: string | null;
  type_libelle: string | null;
  surface_declaree: number | null;
  surface_mesuree: number;
  nombre_faces_declares: number | null;
  nombre_faces_mesurees: number;
  ecart_detecte: boolean;
  ecart_description: string | null;
  taxe_declaree: number;
  taxe_mesuree: number;
  delta_montant_taxe: number;
}

interface ControleRectificationResponse {
  ok: boolean;
  mode: 'declaration_office' | 'demande_contribuable';
  created: Array<{ declaration_id: number; numero: string; assujetti_id: number; annee: number; statut: string }>;
  conflicts: Array<{ assujetti_id: number; annee: number; declaration_id: number; numero: string; statut: string }>;
}

interface ControleRedressementResponse {
  ok: boolean;
  created: Array<{ contentieux_id: number; numero: string; assujetti_id: number; annee: number; montant_litige: number }>;
}

interface ControleFormState {
  dispositif_id: string;
  date_controle: string;
  latitude: string;
  longitude: string;
  surface_mesuree: string;
  nombre_faces_mesurees: string;
  ecart_detecte: boolean;
  ecart_description: string;
  statut: 'saisi' | 'cloture';
  create_dispositif: {
    assujetti_id: string;
    type_id: string;
    zone_id: string;
    adresse_rue: string;
    adresse_cp: string;
    adresse_ville: string;
    surface: string;
    nombre_faces: string;
    statut: 'declare' | 'controle' | 'litigieux' | 'depose' | 'exonere';
    notes: string;
  };
}

interface QueuedControlePhoto {
  name: string;
  type: string;
  blob: Blob;
}

export interface QueuedControleRecord {
  id: string;
  payload: {
    dispositif_id: number | null;
    create_dispositif: ControleCreateDispositifInput | null;
    date_controle: string;
    latitude: number;
    longitude: number;
    surface_mesuree: number;
    nombre_faces_mesurees: number;
    ecart_detecte: boolean;
    ecart_description: string | null;
    statut: 'saisi' | 'cloture';
  };
  photos: QueuedControlePhoto[];
  created_at: string;
}

const QUEUE_DB_NAME = 'tlpe-controles-offline';
const QUEUE_STORE_NAME = 'drafts';

export function canAccessControles(role: Role | null | undefined): boolean {
  return role === 'admin' || role === 'gestionnaire' || role === 'controleur';
}

export function canGenerateControleReport(role: Role | null | undefined): boolean {
  return role === 'admin' || role === 'gestionnaire';
}

export function countSelectedControleEcarts(
  rows: Array<Pick<ControleRow, 'id' | 'ecart_detecte'>>,
  selectedIds: ReadonlySet<number>,
): number {
  let count = 0;
  for (const row of rows) {
    if (selectedIds.has(row.id) && row.ecart_detecte) count += 1;
  }
  return count;
}

export function toggleControleSelection(selectedIds: ReadonlySet<number>, controleId: number): Set<number> {
  const next = new Set(selectedIds);
  if (next.has(controleId)) {
    next.delete(controleId);
  } else {
    next.add(controleId);
  }
  return next;
}

export function selectAllControles(rows: Array<Pick<ControleRow, 'id'>>): Set<number> {
  return new Set(rows.map((row) => row.id));
}

export function controleSubmissionMode(input: ControleDraftInput): 'existing' | 'create' {
  if (typeof input.dispositif_id === 'number' && input.dispositif_id > 0) return 'existing';
  if (input.create_dispositif) return 'create';
  throw new Error('Un contrôle doit cibler un dispositif existant ou créer une nouvelle fiche dispositif');
}

export function shouldQueueControleOffline(isOnline: boolean): boolean {
  return !isOnline;
}

export function readNavigatorOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine;
}

export function acquireControleSyncLock(syncRef: { current: boolean }): boolean {
  if (syncRef.current) return false;
  syncRef.current = true;
  return true;
}

function todayInputValue(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function createInitialForm(): ControleFormState {
  return {
    dispositif_id: '',
    date_controle: todayInputValue(),
    latitude: '',
    longitude: '',
    surface_mesuree: '',
    nombre_faces_mesurees: '1',
    ecart_detecte: false,
    ecart_description: '',
    statut: 'saisi',
    create_dispositif: {
      assujetti_id: '',
      type_id: '',
      zone_id: '',
      adresse_rue: '',
      adresse_cp: '',
      adresse_ville: '',
      surface: '',
      nombre_faces: '1',
      statut: 'controle',
      notes: 'Créé depuis un constat terrain',
    },
  };
}

function openQueueDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB indisponible sur ce navigateur'));
      return;
    }
    const request = indexedDB.open(QUEUE_DB_NAME, 1);
    request.onerror = () => reject(request.error ?? new Error('Ouverture IndexedDB impossible'));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE_NAME)) {
        db.createObjectStore(QUEUE_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function listQueuedControles(): Promise<QueuedControleRecord[]> {
  const db = await openQueueDb();
  return new Promise<QueuedControleRecord[]>((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE_NAME, 'readonly');
    const store = tx.objectStore(QUEUE_STORE_NAME);
    const request = store.getAll();
    request.onerror = () => reject(request.error ?? new Error('Lecture de la file hors-ligne impossible'));
    request.onsuccess = () => resolve((request.result as QueuedControleRecord[]).sort((a, b) => a.created_at.localeCompare(b.created_at)));
  }).finally(() => db.close());
}

async function putQueuedControle(record: QueuedControleRecord): Promise<void> {
  const db = await openQueueDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE_NAME, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Écriture de la file hors-ligne impossible'));
    tx.objectStore(QUEUE_STORE_NAME).put(record);
  }).finally(() => db.close());
}

async function deleteQueuedControle(id: string): Promise<void> {
  const db = await openQueueDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE_NAME, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Suppression de la file hors-ligne impossible'));
    tx.objectStore(QUEUE_STORE_NAME).delete(id);
  }).finally(() => db.close());
}

async function uploadControlePhotos(controleId: number, photos: File[]): Promise<void> {
  for (const photo of photos) {
    const formData = new FormData();
    formData.set('entite', 'controle');
    formData.set('entite_id', String(controleId));
    formData.set('fichier', photo);
    await api('/api/pieces-jointes', {
      method: 'POST',
      body: formData,
    });
  }
}

export async function downloadControleReportFile(
  path: string,
  payload: Record<string, unknown>,
  fallbackFilename: string,
  deps?: {
    request?: typeof apiBlobWithMetadata;
    createObjectUrl?: (blob: Blob) => string;
    revokeObjectUrl?: (url: string) => void;
    createAnchor?: () => HTMLAnchorElement;
    appendAnchor?: (anchor: HTMLAnchorElement) => void;
    removeAnchor?: (anchor: HTMLAnchorElement) => void;
  },
): Promise<string> {
  const request = deps?.request ?? apiBlobWithMetadata;
  const createObjectUrl = deps?.createObjectUrl ?? ((blob: Blob) => window.URL.createObjectURL(blob));
  const revokeObjectUrl = deps?.revokeObjectUrl ?? ((url: string) => window.URL.revokeObjectURL(url));
  const createAnchor = deps?.createAnchor ?? (() => document.createElement('a'));
  const appendAnchor = deps?.appendAnchor ?? ((anchor: HTMLAnchorElement) => document.body.appendChild(anchor));
  const removeAnchor = deps?.removeAnchor ?? ((anchor: HTMLAnchorElement) => anchor.remove());

  const { blob, filename } = await request(path, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const href = createObjectUrl(blob);
  const anchor = createAnchor();
  const downloadName = filename || fallbackFilename;
  anchor.href = href;
  anchor.download = downloadName;
  appendAnchor(anchor);
  try {
    anchor.click();
  } finally {
    removeAnchor(anchor);
    revokeObjectUrl(href);
  }
  return downloadName;
}

export async function syncQueuedControles(deps?: {
  listQueuedControles?: () => Promise<QueuedControleRecord[]>;
  createControle?: (payload: QueuedControleRecord['payload']) => Promise<{ id: number }>;
  uploadControlePhotos?: (controleId: number, photos: File[]) => Promise<void>;
  deleteQueuedControle?: (id: string) => Promise<void>;
}): Promise<{ synced: number; remaining: number }> {
  const listQueued = deps?.listQueuedControles ?? listQueuedControles;
  const createControle =
    deps?.createControle ??
    ((payload: QueuedControleRecord['payload']) =>
      api<{ id: number }>('/api/controles', {
        method: 'POST',
        body: JSON.stringify(payload),
      }));
  const uploadPhotos = deps?.uploadControlePhotos ?? uploadControlePhotos;
  const deleteQueued = deps?.deleteQueuedControle ?? deleteQueuedControle;

  const queued = await listQueued();
  let synced = 0;

  for (const draft of queued) {
    try {
      const created = await createControle(draft.payload);
      await deleteQueued(draft.id);
      const files = draft.photos.map((photo) => new File([photo.blob], photo.name, { type: photo.type }));
      await uploadPhotos(created.id, files);
      synced += 1;
    } catch {
      break;
    }
  }

  const remaining = (await listQueued()).length;
  return { synced, remaining };
}

function buildPayload(form: ControleFormState, creationMode: 'existing' | 'create') {
  const draft: ControleDraftInput = {
    dispositif_id: creationMode === 'existing' ? Number(form.dispositif_id) : null,
    create_dispositif:
      creationMode === 'create'
        ? {
            assujetti_id: Number(form.create_dispositif.assujetti_id),
            type_id: Number(form.create_dispositif.type_id),
            zone_id: form.create_dispositif.zone_id ? Number(form.create_dispositif.zone_id) : null,
            adresse_rue: form.create_dispositif.adresse_rue || null,
            adresse_cp: form.create_dispositif.adresse_cp || null,
            adresse_ville: form.create_dispositif.adresse_ville || null,
            latitude: form.latitude ? Number(form.latitude) : null,
            longitude: form.longitude ? Number(form.longitude) : null,
            surface: form.create_dispositif.surface ? Number(form.create_dispositif.surface) : Number(form.surface_mesuree),
            nombre_faces: Number(form.create_dispositif.nombre_faces || form.nombre_faces_mesurees),
            statut: form.create_dispositif.statut,
            notes: form.create_dispositif.notes || null,
          }
        : null,
  };

  const mode = controleSubmissionMode(draft);
  return {
    dispositif_id: mode === 'existing' ? draft.dispositif_id : null,
    create_dispositif: mode === 'create' ? draft.create_dispositif : null,
    date_controle: form.date_controle,
    latitude: Number(form.latitude),
    longitude: Number(form.longitude),
    surface_mesuree: Number(form.surface_mesuree),
    nombre_faces_mesurees: Number(form.nombre_faces_mesurees),
    ecart_detecte: form.ecart_detecte,
    ecart_description: form.ecart_description.trim() || null,
    statut: form.statut,
  };
}

export default function Controles() {
  const { user } = useAuth();
  const [rows, setRows] = useState<ControleRow[]>([]);
  const [dispositifs, setDispositifs] = useState<DispositifOption[]>([]);
  const [assujettis, setAssujettis] = useState<AssujettiOption[]>([]);
  const [types, setTypes] = useState<TypeOption[]>([]);
  const [zones, setZones] = useState<ZoneOption[]>([]);
  const [form, setForm] = useState<ControleFormState>(() => createInitialForm());
  const [creationMode, setCreationMode] = useState<'existing' | 'create'>('existing');
  const [selectedPhotos, setSelectedPhotos] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const syncInFlightRef = useRef(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const [isOnline, setIsOnline] = useState(() => readNavigatorOnline());
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [reporting, setReporting] = useState<'pdf' | 'xlsx' | null>(null);
  const [rectificationMode, setRectificationMode] = useState<'declaration_office' | 'demande_contribuable' | null>(null);
  const [redressementing, setRedressementing] = useState(false);
  const canAccess = canAccessControles(user?.role);
  const canReport = canGenerateControleReport(user?.role);

  const selectedDispositif = useMemo(
    () => dispositifs.find((dispositif) => String(dispositif.id) === form.dispositif_id) ?? null,
    [dispositifs, form.dispositif_id],
  );
  const selectedControleIds = useMemo(() => Array.from(selectedIds), [selectedIds]);
  const selectedRows = useMemo(() => rows.filter((row) => selectedIds.has(row.id)), [rows, selectedIds]);
  const selectedEcartsCount = useMemo(() => countSelectedControleEcarts(rows, selectedIds), [rows, selectedIds]);
  const selectedSurfaceDeltaTotal = useMemo(
    () => selectedRows.reduce((sum, row) => sum + (row.surface_mesuree - (row.dispositif_surface ?? row.surface_mesuree)), 0),
    [selectedRows],
  );
  const allSelected = rows.length > 0 && selectedIds.size === rows.length;
  const hasSelection = selectedIds.size > 0;

  const refreshQueueCount = useCallback(async () => {
    try {
      const queued = await listQueuedControles();
      setQueuedCount(queued.length);
    } catch {
      setQueuedCount(0);
    }
  }, []);

  const load = useCallback(async () => {
    const [controlesData, dispositifsData, assujettisData, typesData, zonesData] = await Promise.all([
      api<ControleRow[]>('/api/controles'),
      api<DispositifOption[]>('/api/dispositifs'),
      api<AssujettiOption[]>('/api/assujettis'),
      api<TypeOption[]>('/api/referentiels/types'),
      api<ZoneOption[]>('/api/referentiels/zones'),
    ]);
    setRows(controlesData);
    setDispositifs(dispositifsData);
    setAssujettis(assujettisData);
    setTypes(typesData);
    setZones(zonesData);
  }, []);

  useEffect(() => {
    if (!canAccess) return;
    load().catch((error) => setErr((error as Error).message));
    refreshQueueCount().catch(() => undefined);
  }, [canAccess, load, refreshQueueCount]);

  const handleOnline = useCallback(() => {
    setIsOnline(true);
    if (!acquireControleSyncLock(syncInFlightRef)) {
      return;
    }
    setInfo('Connexion rétablie, synchronisation des constats en attente…');
    void (async () => {
      setSyncing(true);
      try {
        const result = await syncQueuedControles();
        await load();
        await refreshQueueCount();
        setInfo(
          result.synced > 0
            ? `${result.synced} constat(s) synchronisé(s) depuis la file hors-ligne.`
            : 'Connexion rétablie, aucun constat en attente à synchroniser.',
        );
      } catch (error) {
        setErr((error as Error).message);
      } finally {
        syncInFlightRef.current = false;
        setSyncing(false);
      }
    })();
  }, [load, refreshQueueCount]);

  const handleOffline = useCallback(() => {
    setIsOnline(false);
    setInfo('Mode hors-ligne activé : les constats seront placés en file locale.');
  }, []);

  useEffect(() => {
    if (!canAccess || typeof window === 'undefined') return;
    const onlineListener = () => handleOnline();
    const offlineListener = () => handleOffline();
    window.addEventListener('online', onlineListener);
    window.addEventListener('offline', offlineListener);
    return () => {
      window.removeEventListener('online', onlineListener);
      window.removeEventListener('offline', offlineListener);
    };
  }, [canAccess, handleOnline, handleOffline]);

  if (!canAccess) {
    return <div className="alert warning">Le module de contrôles terrain est réservé aux profils admin, gestionnaire et contrôleur.</div>;
  }

  const updateCreateDispositif = (field: keyof ControleFormState['create_dispositif'], value: string) => {
    setForm((current) => ({
      ...current,
      create_dispositif: {
        ...current.create_dispositif,
        [field]: value,
      },
    }));
  };

  const useCurrentPosition = () => {
    setErr(null);
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setErr('La géolocalisation n’est pas disponible sur ce navigateur.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const latitude = position.coords.latitude.toFixed(6);
        const longitude = position.coords.longitude.toFixed(6);
        setForm((current) => ({
          ...current,
          latitude,
          longitude,
        }));
        setInfo('Coordonnées GPS récupérées depuis l’appareil.');
      },
      (error) => {
        setErr(`Impossible de récupérer la position GPS : ${error.message}`);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  };

  const queueCurrentControle = async (payload: ReturnType<typeof buildPayload>) => {
    const queuedId = `controle-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await putQueuedControle({
      id: queuedId,
      payload,
      photos: selectedPhotos.map((photo) => ({ name: photo.name, type: photo.type, blob: photo })),
      created_at: new Date().toISOString(),
    });
    await refreshQueueCount();
  };

  const resetForm = () => {
    setForm(createInitialForm());
    setSelectedPhotos([]);
    setCreationMode('existing');
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
  };

  const toggleSelection = (controleId: number) => {
    setSelectedIds((current) => toggleControleSelection(current, controleId));
  };

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : selectAllControles(rows));
  };

  const exportReport = async (format: 'pdf' | 'xlsx') => {
    if (!hasSelection) {
      setErr('Sélectionnez au moins un contrôle pour générer un rapport.');
      return;
    }

    setErr(null);
    setInfo(null);
    setReporting(format);
    try {
      const fallbackFilename = `rapport-controles-${new Date().toISOString().slice(0, 10)}.${format}`;
      const filename = await downloadControleReportFile(
        '/api/controles/report',
        { controle_ids: selectedControleIds, format },
        fallbackFilename,
      );
      setInfo(`Rapport ${format.toUpperCase()} généré (${filename}).`);
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setReporting(null);
    }
  };

  const proposeRectification = async (mode: 'declaration_office' | 'demande_contribuable') => {
    if (!hasSelection) {
      setErr('Sélectionnez au moins un contrôle pour proposer une rectification.');
      return;
    }

    setErr(null);
    setInfo(null);
    setRectificationMode(mode);
    try {
      const response = await api<ControleRectificationResponse>('/api/controles/proposer-rectification', {
        method: 'POST',
        body: JSON.stringify({ controle_ids: selectedControleIds, mode }),
      });
      await load();
      const createdSummary = response.created.length
        ? `${response.created.length} déclaration(s) créée(s) (${response.created.map((item) => item.numero).join(', ')})`
        : 'aucune nouvelle déclaration';
      const conflictSummary = response.conflicts.length
        ? ` Déjà existantes : ${response.conflicts.map((item) => item.numero).join(', ')}.`
        : '';
      setInfo(`Proposition de rectification enregistrée (${mode === 'declaration_office' ? 'déclaration d’office' : 'demande contribuable'}) : ${createdSummary}.${conflictSummary}`);
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setRectificationMode(null);
    }
  };

  const launchRedressement = async () => {
    if (!hasSelection) {
      setErr('Sélectionnez au moins un contrôle pour lancer un redressement.');
      return;
    }

    setErr(null);
    setInfo(null);
    setRedressementing(true);
    try {
      const response = await api<ControleRedressementResponse>('/api/controles/lancer-redressement', {
        method: 'POST',
        body: JSON.stringify({ controle_ids: selectedControleIds }),
      });
      const summary = response.created.map((item) => `${item.numero} (${formatEuro(item.montant_litige)})`).join(', ');
      setInfo(`Redressement(s) ouvert(s) automatiquement : ${summary}.`);
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setRedressementing(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setErr(null);
    setInfo(null);
    setSaving(true);
    try {
      const payload = buildPayload(form, creationMode);
      if (shouldQueueControleOffline(isOnline)) {
        await queueCurrentControle(payload);
        resetForm();
        setInfo('Constat enregistré dans la file hors-ligne. Il sera synchronisé automatiquement dès le retour de la connexion.');
        return;
      }

      const created = await api<{ id: number }>('/api/controles', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      await uploadControlePhotos(created.id, selectedPhotos);
      await load();
      await refreshQueueCount();
      resetForm();
      setInfo('Constat terrain enregistré et photos téléversées.');
    } catch (error) {
      const message = (error as Error).message;
      const isNetworkError = /Failed to fetch|NetworkError|fetch/i.test(message);
      if (isNetworkError) {
        try {
          const payload = buildPayload(form, creationMode);
          await queueCurrentControle(payload);
          resetForm();
          setInfo('Réseau indisponible : le constat a été placé en file hors-ligne.');
          return;
        } catch (queueError) {
          setErr((queueError as Error).message);
          return;
        }
      }
      setErr(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Contrôles terrain</h1>
          <p>Saisie web responsive des constats avec géolocalisation, rattachement dispositif et photos terrain.</p>
        </div>
      </div>

      {err && <div className="alert error">{err}</div>}
      {info && <div className="alert success">{info}</div>}

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <form className="card form" onSubmit={submit}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <h2 style={{ margin: 0 }}>Nouveau constat</h2>
              <div className="hint">Choisissez un dispositif existant ou créez immédiatement la fiche terrain.</div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className={`btn ${creationMode === 'existing' ? '' : 'secondary'}`} type="button" onClick={() => setCreationMode('existing')}>
                Dispositif existant
              </button>
              <button className={`btn ${creationMode === 'create' ? '' : 'secondary'}`} type="button" onClick={() => setCreationMode('create')}>
                Nouveau dispositif
              </button>
            </div>
          </div>

          {creationMode === 'existing' ? (
            <div>
              <label>Dispositif contrôlé</label>
              <select value={form.dispositif_id} onChange={(event) => setForm((current) => ({ ...current, dispositif_id: event.target.value }))} required>
                <option value="">Sélectionner un dispositif</option>
                {dispositifs.map((dispositif) => (
                  <option key={dispositif.id} value={dispositif.id}>
                    {dispositif.identifiant} — {dispositif.assujetti_raison_sociale}
                  </option>
                ))}
              </select>
              {selectedDispositif && (
                <div className="hint">
                  {selectedDispositif.surface} m² · {selectedDispositif.nombre_faces} face(s) · {[selectedDispositif.adresse_rue, selectedDispositif.adresse_cp, selectedDispositif.adresse_ville].filter(Boolean).join(', ')}
                </div>
              )}
            </div>
          ) : (
            <div className="grid cols-2">
              <div>
                <label>Assujetti</label>
                <select value={form.create_dispositif.assujetti_id} onChange={(event) => updateCreateDispositif('assujetti_id', event.target.value)} required>
                  <option value="">Sélectionner un assujetti</option>
                  {assujettis.map((assujetti) => (
                    <option key={assujetti.id} value={assujetti.id}>
                      {assujetti.raison_sociale} ({assujetti.identifiant_tlpe})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Type de dispositif</label>
                <select value={form.create_dispositif.type_id} onChange={(event) => updateCreateDispositif('type_id', event.target.value)} required>
                  <option value="">Sélectionner un type</option>
                  {types.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.libelle} ({type.categorie})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Zone tarifaire</label>
                <select value={form.create_dispositif.zone_id} onChange={(event) => updateCreateDispositif('zone_id', event.target.value)}>
                  <option value="">Calcul automatique si GPS disponible</option>
                  {zones.map((zone) => (
                    <option key={zone.id} value={zone.id}>
                      {zone.libelle} (coef. {zone.coefficient})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Statut initial</label>
                <select value={form.create_dispositif.statut} onChange={(event) => updateCreateDispositif('statut', event.target.value)}>
                  <option value="controle">Contrôlé</option>
                  <option value="litigieux">Litigieux</option>
                  <option value="declare">Déclaré</option>
                  <option value="depose">Déposé</option>
                  <option value="exonere">Exonéré</option>
                </select>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label>Adresse d’implantation</label>
                <AddressAutocomplete
                  value={form.create_dispositif.adresse_rue}
                  onValueChange={(next) => updateCreateDispositif('adresse_rue', next)}
                  onSelect={(suggestion: AddressSuggestion) => {
                    setForm((current) => ({
                      ...current,
                      latitude: suggestion.latitude !== null ? String(suggestion.latitude) : current.latitude,
                      longitude: suggestion.longitude !== null ? String(suggestion.longitude) : current.longitude,
                      create_dispositif: {
                        ...current.create_dispositif,
                        adresse_rue: suggestion.label,
                        adresse_cp: suggestion.codePostal ?? current.create_dispositif.adresse_cp,
                        adresse_ville: suggestion.ville ?? current.create_dispositif.adresse_ville,
                      },
                    }));
                  }}
                />
              </div>
              <div>
                <label>Code postal</label>
                <input value={form.create_dispositif.adresse_cp} onChange={(event) => updateCreateDispositif('adresse_cp', event.target.value)} />
              </div>
              <div>
                <label>Ville</label>
                <input value={form.create_dispositif.adresse_ville} onChange={(event) => updateCreateDispositif('adresse_ville', event.target.value)} />
              </div>
              <div>
                <label>Surface de la fiche créée (m²)</label>
                <input type="number" min="0.1" step="0.1" value={form.create_dispositif.surface} onChange={(event) => updateCreateDispositif('surface', event.target.value)} required />
              </div>
              <div>
                <label>Nombre de faces de la fiche créée</label>
                <input type="number" min="1" max="4" value={form.create_dispositif.nombre_faces} onChange={(event) => updateCreateDispositif('nombre_faces', event.target.value)} required />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label>Notes de création</label>
                <textarea rows={3} value={form.create_dispositif.notes} onChange={(event) => updateCreateDispositif('notes', event.target.value)} />
              </div>
            </div>
          )}

          <div className="form-row cols-3">
            <div>
              <label>Date du contrôle</label>
              <input type="date" value={form.date_controle} onChange={(event) => setForm((current) => ({ ...current, date_controle: event.target.value }))} required />
            </div>
            <div>
              <label>Latitude</label>
              <input type="number" step="0.000001" value={form.latitude} onChange={(event) => setForm((current) => ({ ...current, latitude: event.target.value }))} required />
            </div>
            <div>
              <label>Longitude</label>
              <input type="number" step="0.000001" value={form.longitude} onChange={(event) => setForm((current) => ({ ...current, longitude: event.target.value }))} required />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn secondary" type="button" onClick={useCurrentPosition}>Utiliser ma position GPS</button>
            <span className="toolbar-hint">Le navigateur demande l’autorisation de géolocalisation.</span>
          </div>

          <div className="form-row cols-3">
            <div>
              <label>Surface mesurée (m²)</label>
              <input type="number" min="0.1" step="0.1" value={form.surface_mesuree} onChange={(event) => setForm((current) => ({ ...current, surface_mesuree: event.target.value }))} required />
            </div>
            <div>
              <label>Nombre de faces mesurées</label>
              <input type="number" min="1" max="4" value={form.nombre_faces_mesurees} onChange={(event) => setForm((current) => ({ ...current, nombre_faces_mesurees: event.target.value }))} required />
            </div>
            <div>
              <label>Statut du constat</label>
              <select value={form.statut} onChange={(event) => setForm((current) => ({ ...current, statut: event.target.value as 'saisi' | 'cloture' }))}>
                <option value="saisi">Saisi</option>
                <option value="cloture">Clôturé</option>
              </select>
            </div>
          </div>

          <div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={form.ecart_detecte} onChange={(event) => setForm((current) => ({ ...current, ecart_detecte: event.target.checked }))} />
              Signaler une anomalie (dispositif non déclaré, surface erronée, écart terrain…)
            </label>
          </div>

          <div>
            <label>Description de l’écart</label>
            <textarea
              rows={4}
              value={form.ecart_description}
              onChange={(event) => setForm((current) => ({ ...current, ecart_description: event.target.value }))}
              placeholder="Ex. dispositif non déclaré constaté en façade sud, surface observée 13,5 m² au lieu de 12 m²"
              required={form.ecart_detecte}
            />
          </div>

          <div>
            <label>Photos / pièces du constat</label>
            <input
              type="file"
              accept={CONTROLE_FILE_ACCEPT}
              multiple
              onChange={(event) => setSelectedPhotos(Array.from(event.target.files ?? []))}
            />
            <div className="hint">Les fichiers sont téléversés après création du constat. Hors-ligne, ils sont stockés localement dans IndexedDB puis synchronisés au retour réseau.</div>
            {selectedPhotos.length > 0 && (
              <div className="hint">{selectedPhotos.length} fichier(s) sélectionné(s) : {selectedPhotos.map((photo) => photo.name).join(', ')}</div>
            )}
          </div>

          <div className="actions">
            <button className="btn secondary" type="button" onClick={resetForm} disabled={saving}>Réinitialiser</button>
            <button className="btn" type="submit" disabled={saving}>{saving ? 'Enregistrement…' : 'Enregistrer le constat'}</button>
          </div>
        </form>

        <div className="grid" style={{ gap: 16 }}>
          {canReport && (
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div>
                  <h2 style={{ marginTop: 0, marginBottom: 4 }}>Rapport de contrôle automatique</h2>
                  <p style={{ marginTop: 0 }}>
                    Sélectionnez un ou plusieurs constats clôturés pour générer un rapport PDF/Excel, proposer une rectification ou ouvrir un contentieux de redressement.
                  </p>
                  <div className="hint">
                    {hasSelection
                      ? `${selectedControleIds.length} contrôle(s) sélectionné(s) • ${selectedEcartsCount} avec anomalie • Δ surface totale ${selectedSurfaceDeltaTotal.toFixed(1)} m²`
                      : 'Aucun contrôle sélectionné pour le rapport.'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn secondary small" type="button" disabled={!hasSelection || reporting !== null} onClick={() => exportReport('pdf')}>
                    {reporting === 'pdf' ? 'Export PDF…' : 'Générer PDF'}
                  </button>
                  <button className="btn secondary small" type="button" disabled={!hasSelection || reporting !== null} onClick={() => exportReport('xlsx')}>
                    {reporting === 'xlsx' ? 'Export Excel…' : 'Exporter Excel'}
                  </button>
                  <button
                    className="btn secondary small"
                    type="button"
                    disabled={!hasSelection || rectificationMode !== null}
                    onClick={() => proposeRectification('demande_contribuable')}
                  >
                    {rectificationMode === 'demande_contribuable' ? 'Demande…' : 'Proposer rectification'}
                  </button>
                  <button
                    className="btn secondary small"
                    type="button"
                    disabled={!hasSelection || rectificationMode !== null}
                    onClick={() => proposeRectification('declaration_office')}
                  >
                    {rectificationMode === 'declaration_office' ? 'Déclaration…' : 'Déclaration d’office'}
                  </button>
                  <button className="btn small" type="button" disabled={!hasSelection || redressementing} onClick={launchRedressement}>
                    {redressementing ? 'Redressement…' : 'Lancer redressement'}
                  </button>
                  <button className="btn secondary small" type="button" disabled={!hasSelection} onClick={clearSelection}>
                    Effacer sélection
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="card">
            <h2 style={{ marginTop: 0 }}>Mode hors-ligne navigateur</h2>
            <p style={{ marginTop: 0 }}>
              Les constats terrain saisis sans connexion sont stockés localement dans le navigateur puis synchronisés automatiquement dès le retour en ligne.
            </p>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className={`badge ${queuedCount > 0 ? 'warn' : 'success'}`}>{queuedCount} constat(s) en attente</span>
              <span className={`badge ${isOnline ? 'success' : 'danger'}`}>
                {isOnline ? 'en ligne' : 'hors ligne'}
              </span>
              <button className="btn secondary small" type="button" disabled={syncing || queuedCount === 0 || !isOnline} onClick={() => handleOnline()}>
                {syncing ? 'Synchronisation…' : 'Synchroniser maintenant'}
              </button>
            </div>
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: 16, borderBottom: '1px solid var(--c-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <h2 style={{ margin: 0 }}>Derniers constats</h2>
                <div className="hint">{rows.length} constat(s) enregistrés</div>
              </div>
              {canReport && rows.length > 0 && (
                <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
                  Tout sélectionner
                </label>
              )}
            </div>
            <table className="table">
              <thead>
                <tr>
                  {canReport && <th>Sélection</th>}
                  <th>Date</th>
                  <th>Dispositif</th>
                  <th>Agent</th>
                  <th>Mesure</th>
                  <th>Anomalie</th>
                  <th>Photos</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={canReport ? 7 : 6} className="empty">Aucun contrôle saisi pour le moment.</td>
                  </tr>
                ) : rows.map((row) => (
                  <tr key={row.id}>
                    {canReport && (
                      <td>
                        <input type="checkbox" checked={selectedIds.has(row.id)} onChange={() => toggleSelection(row.id)} aria-label={`Sélectionner le contrôle ${row.id}`} />
                      </td>
                    )}
                    <td>{row.date_controle}</td>
                    <td>
                      <strong>{row.dispositif_identifiant ?? 'Nouvelle fiche terrain'}</strong>
                      <div className="hint">{row.assujetti_raison_sociale ?? 'Assujetti à confirmer'}</div>
                    </td>
                    <td>{row.agent_nom}</td>
                    <td>
                      {row.surface_mesuree} m² · {row.nombre_faces_mesurees} face(s)
                      {row.dispositif_surface !== null && (
                        <div className="hint">
                          Déclaré : {row.dispositif_surface} m² · {row.dispositif_nombre_faces ?? '-'} face(s)
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${row.ecart_detecte ? 'warn' : 'success'}`}>{row.ecart_detecte ? 'écart détecté' : 'conforme'}</span>
                      {row.ecart_description && <div className="hint">{row.ecart_description}</div>}
                    </td>
                    <td>{row.photos_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
