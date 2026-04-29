import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api, apiBlobWithMetadata } from '../api';
import { useAuth } from '../auth';
import {
  buildExportPersonnaliseFilename,
  buildSavedTemplatePayload,
  defaultConfigForEntity,
  normalizeTemplateConfig,
  resolveEntityConfig,
  shouldShowExportsLoadingState,
  type ExportEntityKey,
  type ExportFileFormat,
  type ExportFilter,
  type ExportFilterOperator,
  type ExportOrder,
  type ExportTemplateConfig,
} from './exportsPersonnalises';

type ColumnDefinition = {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'boolean';
  filterOperators: ExportFilterOperator[];
};

type EntityDefinition = {
  key: ExportEntityKey;
  label: string;
  defaultColumns: string[];
  defaultOrder: ExportOrder;
  columns: ColumnDefinition[];
};

type OperatorDefinition = {
  value: ExportFilterOperator;
  label: string;
};

type PreviewResponse = {
  columns: Array<{ key: string; label: string; type: string }>;
  rows: Array<Record<string, string | number | null>>;
  total: number;
};

type TemplateResponse = {
  id: number;
  nom: string;
  entite: ExportEntityKey;
  configuration: ExportTemplateConfig & { entite: ExportEntityKey };
  created_at: string;
  updated_at: string;
};

export default function ExportsPersonnalises() {
  const { user } = useAuth();
  const canManage = user?.role === 'admin' || user?.role === 'gestionnaire' || user?.role === 'financier';

  const [entities, setEntities] = useState<EntityDefinition[]>([]);
  const [operators, setOperators] = useState<OperatorDefinition[]>([]);
  const [selectedEntity, setSelectedEntity] = useState<ExportEntityKey>('assujettis');
  const [selectedColumns, setSelectedColumns] = useState<string[]>(defaultConfigForEntity('assujettis').colonnes);
  const [filters, setFilters] = useState<ExportFilter[]>([]);
  const [order, setOrder] = useState<ExportOrder | null>(defaultConfigForEntity('assujettis').ordre);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [templates, setTemplates] = useState<TemplateResponse[]>([]);
  const [templateName, setTemplateName] = useState('');
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState<ExportFileFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    if (!canManage) return;
    setLoading(true);
    Promise.all([
      api<{ entities: EntityDefinition[]; operators: OperatorDefinition[] }>('/api/exports-personnalises/meta'),
      api<TemplateResponse[]>('/api/exports-personnalises/templates'),
    ])
      .then(([meta, savedTemplates]) => {
        setEntities(meta.entities);
        setOperators(meta.operators);
        setTemplates(savedTemplates);
        if (meta.entities.length > 0) {
          const resolved = resolveEntityConfig(meta.entities, meta.entities[0].key);
          setSelectedEntity(resolved.selectedEntity);
          setSelectedColumns(resolved.selectedColumns);
          setFilters(resolved.filters);
          setOrder(resolved.order);
        }
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [canManage]);

  const entity = useMemo(() => entities.find((item) => item.key === selectedEntity) ?? null, [entities, selectedEntity]);

  const config = useMemo(
    () => normalizeTemplateConfig({ colonnes: selectedColumns, filtres: filters, ordre: order }),
    [selectedColumns, filters, order],
  );

  const toggleColumn = (columnKey: string) => {
    setSelectedColumns((prev) => {
      if (prev.includes(columnKey)) {
        return prev.length === 1 ? prev : prev.filter((value) => value !== columnKey);
      }
      return [...prev, columnKey];
    });
  };

  const addFilter = () => {
    const defaultColumn = entity?.columns[0];
    if (!defaultColumn) return;
    setFilters((prev) => [...prev, { colonne: defaultColumn.key, operateur: defaultColumn.filterOperators[0], valeur: '' }]);
  };

  const updateFilter = (index: number, patch: Partial<ExportFilter>) => {
    setFilters((prev) => prev.map((filter, i) => {
      if (i !== index) return filter;
      const next = { ...filter, ...patch };
      if (patch.colonne && entity) {
        const column = entity.columns.find((item) => item.key === patch.colonne);
        if (column && !column.filterOperators.includes(next.operateur)) {
          next.operateur = column.filterOperators[0];
        }
      }
      return next;
    }));
  };

  const removeFilter = (index: number) => setFilters((prev) => prev.filter((_, i) => i !== index));

  const resetForEntity = (entityKey: ExportEntityKey) => {
    const resolved = resolveEntityConfig(entities, entityKey);
    setSelectedEntity(resolved.selectedEntity);
    setSelectedColumns(resolved.selectedColumns);
    setFilters(resolved.filters);
    setOrder(resolved.order);
    setPreview(null);
    setInfo(null);
    setError(null);
  };

  const loadPreview = async () => {
    setPreviewing(true);
    setError(null);
    setInfo(null);
    try {
      const payload = await api<PreviewResponse>('/api/exports-personnalises/preview', {
        method: 'POST',
        body: JSON.stringify({ entite: selectedEntity, colonnes: config.colonnes, filtres: config.filtres, ordre: config.ordre }),
      });
      setPreview(payload);
      setInfo(`Aperçu chargé (${Math.min(payload.rows.length, 50)} lignes sur ${payload.total}).`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const exportData = async (format: ExportFileFormat) => {
    setExporting(format);
    setError(null);
    setInfo(null);
    try {
      const { blob, filename } = await apiBlobWithMetadata(`/api/exports-personnalises/export?format=${format}`, {
        method: 'POST',
        body: JSON.stringify({ entite: selectedEntity, colonnes: config.colonnes, filtres: config.filtres, ordre: config.ordre }),
      });
      const href = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = filename || buildExportPersonnaliseFilename(selectedEntity, format);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(href);
      setInfo(`Export ${format.toUpperCase()} téléchargé.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExporting(null);
    }
  };

  const saveTemplate = async (event: FormEvent) => {
    event.preventDefault();
    if (!templateName.trim()) return;
    setSaving(true);
    setError(null);
    setInfo(null);
    try {
      const payload = buildSavedTemplatePayload(templateName.trim(), selectedEntity, config);
      const saved = await api<TemplateResponse>('/api/exports-personnalises/templates', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const savedTemplates = await api<TemplateResponse[]>('/api/exports-personnalises/templates');
      setTemplates(savedTemplates);
      setTemplateName('');
      setInfo(`Modèle « ${saved.nom} » enregistré.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const applyTemplate = (template: TemplateResponse) => {
    setSelectedEntity(template.entite);
    setSelectedColumns(template.configuration.colonnes);
    setFilters(template.configuration.filtres);
    setOrder(template.configuration.ordre);
    setPreview(null);
    setInfo(`Modèle « ${template.nom} » chargé.`);
    setError(null);
  };

  if (!canManage) {
    return <div className="empty">Cette page est réservée aux rôles admin, gestionnaire et financier.</div>;
  }

  if (shouldShowExportsLoadingState(loading, entity, error)) {
    return <div className="empty">Chargement des exports personnalisés...</div>;
  }

  if (!entity) {
    return (
      <>
        {error && <div className="alert error">{error}</div>}
        <div className="empty">Impossible de charger la configuration des exports personnalisés.</div>
      </>
    );
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Exports personnalisés</h1>
          <p>Choix de l’entité, des colonnes, des filtres, prévisualisation 50 lignes et export CSV / Excel.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn secondary" type="button" disabled={previewing || exporting !== null} onClick={() => { void loadPreview(); }}>
            {previewing ? 'Prévisualisation...' : 'Prévisualiser'}
          </button>
          <button className="btn secondary" type="button" disabled={config.colonnes.length === 0 || exporting !== null} onClick={() => { void exportData('csv'); }}>
            {exporting === 'csv' ? 'Export CSV...' : 'Export CSV'}
          </button>
          <button className="btn secondary" type="button" disabled={config.colonnes.length === 0 || exporting !== null} onClick={() => { void exportData('xlsx'); }}>
            {exporting === 'xlsx' ? 'Export Excel...' : 'Export Excel'}
          </button>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}
      {info && <div className="alert success">{info}</div>}

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="card form">
          <div className="form-row cols-2">
            <div>
              <label>Entité</label>
              <select value={selectedEntity} onChange={(event) => resetForEntity(event.target.value as ExportEntityKey)}>
                {entities.map((item) => (
                  <option key={item.key} value={item.key}>{item.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label>Tri</label>
              <div className="export-order-row">
                <select value={order?.colonne ?? ''} onChange={(event) => setOrder((prev) => ({ colonne: event.target.value, direction: prev?.direction ?? 'asc' }))}>
                  {entity.columns.map((column) => (
                    <option key={column.key} value={column.key}>{column.label}</option>
                  ))}
                </select>
                <select value={order?.direction ?? 'asc'} onChange={(event) => setOrder((prev) => ({ colonne: prev?.colonne ?? entity.columns[0].key, direction: event.target.value as 'asc' | 'desc' }))}>
                  <option value="asc">Croissant</option>
                  <option value="desc">Décroissant</option>
                </select>
              </div>
            </div>
          </div>

          <div>
            <label>Colonnes à exporter</label>
            <div className="export-columns-grid">
              {entity.columns.map((column) => (
                <label className="export-checkbox" key={column.key}>
                  <input type="checkbox" checked={selectedColumns.includes(column.key)} onChange={() => toggleColumn(column.key)} />
                  <span>{column.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="toolbar" style={{ marginBottom: 8 }}>
              <strong>Filtres</strong>
              <div className="spacer" />
              <button className="btn small secondary" type="button" onClick={addFilter}>Ajouter un filtre</button>
            </div>
            {filters.length === 0 ? (
              <div className="empty" style={{ padding: 16 }}>Aucun filtre — l’export portera sur tout le périmètre de l’entité.</div>
            ) : (
              <div className="export-filters-stack">
                {filters.map((filter, index) => {
                  const column = entity.columns.find((item) => item.key === filter.colonne) ?? entity.columns[0];
                  return (
                    <div className="export-filter-row" key={`${filter.colonne}-${index}`}>
                      <select value={filter.colonne} onChange={(event) => updateFilter(index, { colonne: event.target.value })}>
                        {entity.columns.map((item) => (
                          <option key={item.key} value={item.key}>{item.label}</option>
                        ))}
                      </select>
                      <select value={filter.operateur} onChange={(event) => updateFilter(index, { operateur: event.target.value as ExportFilterOperator })}>
                        {column.filterOperators.map((operator) => (
                          <option key={operator} value={operator}>{operators.find((item) => item.value === operator)?.label ?? operator}</option>
                        ))}
                      </select>
                      <input value={filter.valeur} onChange={(event) => updateFilter(index, { valeur: event.target.value })} placeholder="Valeur" />
                      <button className="btn small secondary" type="button" onClick={() => removeFilter(index)}>Retirer</button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="card form">
          <div>
            <h3 style={{ marginTop: 0 }}>Modèles sauvegardés</h3>
            {templates.length === 0 ? (
              <div className="empty" style={{ padding: 16 }}>Aucun modèle enregistré.</div>
            ) : (
              <div className="export-templates-stack">
                {templates.map((template) => (
                  <button className="btn secondary" type="button" key={template.id} onClick={() => applyTemplate(template)}>
                    {template.nom} — {template.entite}
                  </button>
                ))}
              </div>
            )}
          </div>

          <form onSubmit={saveTemplate}>
            <label>Nom du modèle</label>
            <input value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="Ex. Titres en retard" />
            <div className="actions">
              <button className="btn" type="submit" disabled={saving || config.colonnes.length === 0 || !templateName.trim()}>
                {saving ? 'Enregistrement...' : 'Enregistrer le modèle'}
              </button>
            </div>
          </form>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16, padding: 0 }}>
        <div className="toolbar" style={{ padding: '16px 20px 0' }}>
          <strong>Aperçu</strong>
          <div className="spacer" />
          <span className="toolbar-hint">50 premières lignes maximum</span>
        </div>
        {preview ? (
          <>
            <div className="toolbar" style={{ padding: '0 20px 8px' }}>
              <span className="toolbar-hint">{preview.total} lignes correspondantes</span>
            </div>
            <table className="table">
              <thead>
                <tr>
                  {preview.columns.map((column) => (
                    <th key={column.key}>{column.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.length === 0 ? (
                  <tr>
                    <td colSpan={Math.max(preview.columns.length, 1)}>
                      <div className="empty" style={{ padding: 16 }}>Aucune ligne pour cette configuration.</div>
                    </td>
                  </tr>
                ) : (
                  preview.rows.map((row, index) => (
                    <tr key={`preview-${index}`}>
                      {preview.columns.map((column) => (
                        <td key={column.key}>{row[column.key] ?? ''}</td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </>
        ) : (
          <div className="empty">Lancez une prévisualisation pour afficher les 50 premières lignes.</div>
        )}
      </div>
    </>
  );
}
