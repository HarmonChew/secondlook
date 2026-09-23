import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import type {
  ActionResult,
  Artifact,
  CreateRunInput,
  EvidencePayload,
  FilePayload,
  Policy,
  ProjectProfile,
  Run,
  RunDetail,
  ScenarioDefinition,
  StageAttempt,
} from '../../src/contracts';

type DriverOption = { id: string; name: string };
type ModelOption = { id: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean };
type ModelProvider = { id: string; name: string; apiKeyEnv: string; configured: boolean; models: ModelOption[] };
type SecondlookConfig = {
  drivers: DriverOption[];
  modelProviders: ModelProvider[];
  demo: {
    profile: ProjectProfile;
    scenarios: { bugfix: ScenarioDefinition[]; feature: ScenarioDefinition[] };
  };
  security: string;
  dataDir: string;
};

type Tab = 'review' | 'activity' | 'changes' | 'checks';
type BoardColumn = 'queued' | 'working' | 'attention' | 'review' | 'accepted';
type ActionName =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'verify'
  | 'accept'
  | 'feedback'
  | 'approve'
  | 'preview'
  | 'reset-preview'
  | 'close-preview';

const TOKEN_KEY = 'secondlook-review-token';

class ApiFailure extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiFailure';
    this.status = status;
  }
}

function tokenFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash.replace(/^#/, '');
  const token = new URLSearchParams(hash).get('token');
  if (token) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    window.sessionStorage.setItem(TOKEN_KEY, token);
    return token;
  }
  return window.sessionStorage.getItem(TOKEN_KEY);
}

async function api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('json') ? await response.json().catch(() => null) : await response.text();
  if (response.status === 401) throw new ApiFailure(401, 'Your session has expired. Enter the review token again.');
  if (!response.ok) {
    const message = typeof payload === 'object' && payload && 'error' in payload ? String(payload.error) : String(payload || response.statusText);
    throw new ApiFailure(response.status, message);
  }
  return payload as T;
}

function jsonBody(value: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(value) };
}

function formatDate(value?: string): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function shortDigest(value?: string): string {
  if (!value) return 'unavailable';
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value;
}

function prettyPhase(phase: Run['phase']): string {
  return phase.toLowerCase().replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusFor(run: Run): { column: BoardColumn; label: string; tone: 'good' | 'warning' | 'neutral' | 'danger' } {
  if (run.sourceStale && run.status !== 'running' && run.status !== 'queued') {
    return { column: 'attention', label: 'Evidence stale', tone: 'warning' };
  }
  if (run.acceptance) return { column: 'accepted', label: 'Accepted', tone: 'good' };
  if (run.status === 'complete' && run.phase === 'READY_FOR_REVIEW') return { column: 'review', label: 'Ready for review', tone: 'good' };
  if (run.status === 'blocked' || run.status === 'paused' || run.status === 'failed' || run.status === 'cancelled') {
    return { column: 'attention', label: run.status === 'cancelled' ? 'Cancelled' : run.status === 'paused' ? 'Paused' : 'Needs attention', tone: 'warning' };
  }
  if (run.status === 'queued') return { column: 'queued', label: 'Queued', tone: 'neutral' };
  return { column: 'working', label: 'Working', tone: 'neutral' };
}

function displayOutcome(side: 'baseline' | 'candidate', evidence?: Artifact<EvidencePayload>, stale = false): { label: string; tone: 'good' | 'warning' | 'danger' | 'neutral' } {
  if (stale) return { label: 'Evidence stale', tone: 'warning' };
  if (!evidence) return { label: 'Not tested', tone: 'neutral' };
  const payload = evidence.payload;
  if (payload.outcome === 'environment_error') return { label: 'Environment blocked', tone: 'warning' };
  if (payload.outcome === 'execution_error') return { label: 'Execution failed', tone: 'danger' };
  if (payload.outcome === 'cancelled') return { label: 'Cancelled', tone: 'warning' };
  if (side === 'baseline' && payload.outcome === 'assertion_failed' && payload.reproduced) return { label: 'Regression reproduced', tone: 'danger' };
  if (side === 'baseline' && payload.outcome === 'passed') return { label: 'Original failure not reproduced', tone: 'warning' };
  if (side === 'baseline' && payload.outcome === 'assertion_failed') return { label: 'Original failure not reproduced', tone: 'warning' };
  if (side === 'candidate' && payload.outcome === 'passed') return { label: 'Targeted scenario passed on candidate', tone: 'good' };
  if (side === 'candidate' && payload.outcome === 'assertion_failed') return { label: 'Scenario failed', tone: 'danger' };
  return { label: 'Not tested', tone: 'neutral' };
}

function isEvidenceArtifact(artifact: Artifact): artifact is Artifact<EvidencePayload> {
  const payload = artifact.payload as Partial<EvidencePayload>;
  return artifact.artifactType === 'evidence' && (payload.side === 'baseline' || payload.side === 'candidate') && Array.isArray(payload.actions);
}

function latestEvidence(detail: RunDetail, scenario: ScenarioDefinition, side: 'baseline' | 'candidate'): { artifact?: Artifact<EvidencePayload>; stale: boolean } {
  const all = detail.artifacts.filter((artifact) => isEvidenceArtifact(artifact) && artifact.payload.side === side && artifact.context?.scenarioId === scenario.id) as Artifact<EvidencePayload>[];
  const artifact = [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  if (!artifact) return { stale: false };
  const expectedCandidate = side === 'baseline' ? detail.run.baseline?.snapshotId : detail.run.candidate?.snapshotId;
  const context = artifact.context;
  const stale = detail.run.sourceStale || !context || context.scenarioRevision !== scenario.revision || context.projectProfileDigest !== detail.run.profileDigest || (!!expectedCandidate && context.candidate.snapshotId !== expectedCandidate);
  return { artifact, stale };
}

function latestCheck(detail: RunDetail, checkId: string): { artifact?: Artifact; stale: boolean } {
  const artifacts = detail.artifacts.filter((artifact) => artifact.artifactType === 'check' && (artifact.payload as { checkId?: string }).checkId === checkId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const artifact = artifacts.at(-1);
  if (!artifact) return { stale: false };
  const context = artifact.context;
  const stale = detail.run.sourceStale || !context || !detail.run.candidate || context.candidate.snapshotId !== detail.run.candidate.snapshotId || context.projectProfileDigest !== detail.run.profileDigest;
  return { artifact, stale };
}

function badge(label: string, tone: 'good' | 'warning' | 'danger' | 'neutral' = 'neutral'): ReactNode {
  return <span className={`badge badge-${tone}`}>{label}</span>;
}

function TokenEntry({ onSubmit, error }: { onSubmit: (token: string) => void; error?: string | null }) {
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const token = value.trim();
    if (token) onSubmit(token);
  };
  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="brand-mark" aria-hidden="true">e</div>
        <p className="eyebrow">Secondlook · local change review</p>
        <h1 id="auth-title">Review what your agent changed.</h1>
        <p className="lede">Enter the local review token printed when the service starts. It stays in this browser session and is never put in a URL.</p>
        <form onSubmit={submit} className="stack gap-3">
          <label className="field">
            <span>Review token</span>
            <div className="input-with-action">
              <input ref={inputRef} type={show ? 'text' : 'password'} value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" spellCheck={false} required aria-describedby={error ? 'auth-error' : undefined} />
              <button type="button" className="button button-quiet" onClick={() => setShow((current) => !current)}>{show ? 'Hide' : 'Show'}</button>
            </div>
          </label>
          {error && <p id="auth-error" className="inline-error" role="alert">{error}</p>}
          <button className="button button-primary button-block" type="submit">Open review workspace</button>
        </form>
        <p className="fine-print">The review service is loopback-only. Candidate applications open in a separate managed browser context.</p>
      </section>
    </main>
  );
}

function Header({ onHome, onNew, onSignOut, security }: { onHome: () => void; onNew: () => void; onSignOut: () => void; security?: string }) {
  return (
    <header className="app-header">
      <div className="header-inner">
        <button type="button" className="brand-button" onClick={onHome} aria-label="Open ticket board">
          <span className="brand-mark small" aria-hidden="true">e</span><span>Secondlook</span>
        </button>
        <span className="project-name">Change review</span>
        <div className="header-actions">
          <span className="security-note"><span className="status-dot" aria-hidden="true" />{security === 'trusted-host' ? 'Trusted host' : security || 'Local service'}</span>
          <button type="button" className="button button-primary" onClick={onNew}>New ticket</button>
          <button type="button" className="button button-quiet" onClick={onSignOut}>Sign out</button>
        </div>
      </div>
    </header>
  );
}

function DemoBanner({ onDemo, disabled }: { onDemo: (kind: 'bugfix' | 'feature') => void; disabled?: boolean }) {
  return (
    <section className="demo-banner" aria-labelledby="demo-heading">
      <div>
        <p className="eyebrow">No credentials needed</p>
        <h2 id="demo-heading">See the full review loop with a real browser run.</h2>
        <p>These deterministic demos use the same workspace, agent, and Playwright evidence pipeline. They are explicitly marked demo-only.</p>
      </div>
      <div className="row wrap gap-2">
        <button type="button" className="button button-primary" onClick={() => onDemo('bugfix')} disabled={disabled}>Run bug-fix demo</button>
        <button type="button" className="button" onClick={() => onDemo('feature')} disabled={disabled}>Run feature demo</button>
      </div>
    </section>
  );
}

function TicketCard({ run, onOpen }: { run: Run; onOpen: () => void }) {
  const status = statusFor(run);
  return (
    <button type="button" className="ticket-card" onClick={onOpen}>
      <span className="row between gap-2"><span className="ticket-kind">{run.kind === 'bugfix' ? 'Bug fix' : 'Feature'}</span>{run.demo && badge('Demo', 'warning')}</span>
      <strong>{run.title}</strong>
      <span className="ticket-request">{run.request}</span>
      <span className="row between ticket-meta"><span>{prettyPhase(run.phase)}</span><span>{status.label}</span></span>
      <span className="ticket-cta">Open review <span aria-hidden="true">→</span></span>
    </button>
  );
}

function Board({ runs, loading, onOpen, onDemo, onNew, error, submitting }: { runs: Run[]; loading: boolean; onOpen: (id: string) => void; onDemo: (kind: 'bugfix' | 'feature') => void; onNew: () => void; error?: string | null; submitting?: boolean }) {
  const columns: Array<{ id: BoardColumn; label: string }> = [
    { id: 'queued', label: 'Queued' },
    { id: 'working', label: 'Working' },
    { id: 'attention', label: 'Needs attention' },
    { id: 'review', label: 'Ready for review' },
    { id: 'accepted', label: 'Accepted' },
  ];
  const grouped = useMemo(() => {
    const result = new Map<BoardColumn, Run[]>(columns.map((column) => [column.id, []]));
    runs.forEach((run) => result.get(statusFor(run).column)?.push(run));
    return result;
  }, [runs]);
  return (
    <main className="page-shell">
      <section className="page-intro">
        <div><p className="eyebrow">Change queue</p><h1>One request, one ticket, a result you can try.</h1><p className="lede">Follow implementation progress, then inspect the exact candidate that produced its evidence.</p></div>
        <button type="button" className="button button-primary" onClick={onNew}>Create a ticket</button>
      </section>
      {error && <div className="notice notice-danger" role="alert">{error}</div>}
      {loading && !runs.length ? <div className="loading-card" role="status"><span className="spinner" aria-hidden="true" />Loading tickets…</div> : runs.length ? (
        <div className="board-grid">
          {columns.map((column) => {
            const items = grouped.get(column.id) ?? [];
            return <section className="board-column" key={column.id} aria-labelledby={`column-${column.id}`}><div className="column-heading"><h2 id={`column-${column.id}`}>{column.label}</h2><span>{items.length}</span></div>{items.length ? items.map((run) => <TicketCard key={run.id} run={run} onOpen={() => onOpen(run.id)} />) : <p className="empty-column">No tickets</p>}</section>;
          })}
        </div>
      ) : <>
        <div className="empty-state"><div className="empty-icon" aria-hidden="true">✦</div><h2>Your review queue is empty.</h2><p>Start with a deterministic fixture demo, or create a ticket for an approved project profile.</p><div className="row wrap centered gap-2"><button type="button" className="button button-primary" onClick={() => onDemo('bugfix')} disabled={submitting}>Run bug-fix demo</button><button type="button" className="button" onClick={onNew} disabled={submitting}>Create a ticket</button></div></div>
        <DemoBanner onDemo={onDemo} disabled={submitting} />
      </>}
      {!loading && runs.length > 0 && <DemoBanner onDemo={onDemo} disabled={submitting} />}
    </main>
  );
}

type NewForm = {
  title: string;
  request: string;
  repository: string;
  baseRef: string;
  kind: 'bugfix' | 'feature';
  driverId: string;
  providerId: string;
  modelId: string;
  profile: string;
  scenarios: string;
  policy: string;
  approved: boolean;
};

function NewTicketModal({ config, onClose, onSubmit, submitting, error }: { config: SecondlookConfig; onClose: () => void; onSubmit: (input: CreateRunInput) => void; submitting: boolean; error?: string | null }) {
  const [advanced, setAdvanced] = useState(false);
  const selectableDrivers = config.drivers.filter((driver) => driver.id !== 'demo');
  const defaultDriver = selectableDrivers.find((driver) => driver.id === 'codex')?.id ?? selectableDrivers[0]?.id ?? 'codex';
  const modelProviders = config.modelProviders ?? [];
  const defaultProvider = modelProviders.find((provider) => provider.configured) ?? modelProviders[0];
  const [form, setForm] = useState<NewForm>(() => ({
    title: '', request: '', repository: '', baseRef: 'HEAD', kind: 'feature', driverId: defaultDriver, providerId: defaultProvider?.id ?? '', modelId: defaultProvider?.models[0]?.id ?? '',
    profile: JSON.stringify(config.demo.profile, null, 2), scenarios: JSON.stringify(config.demo.scenarios.feature, null, 2), policy: JSON.stringify({ repairLimit: 1, infrastructureRetries: 1, requiredCheckIds: [], approvalBefore: [] }, null, 2), approved: false,
  }));
  const [parseError, setParseError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialogRef.current?.focus(); }, []);
  const update = (key: keyof NewForm, value: string | boolean) => setForm((current) => ({ ...current, [key]: value } as NewForm));
  const switchKind = (kind: 'bugfix' | 'feature') => setForm((current) => ({ ...current, kind, scenarios: JSON.stringify(config.demo.scenarios[kind], null, 2) }));
  const switchProvider = (providerId: string) => {
    const provider = modelProviders.find((candidate) => candidate.id === providerId);
    setForm((current) => ({ ...current, providerId, modelId: provider?.models[0]?.id ?? '' }));
  };
  const selectedProvider = modelProviders.find((provider) => provider.id === form.providerId);
  const selectedModel = selectedProvider?.models.find((model) => model.id === form.modelId);
  const piModelValid = form.driverId !== 'pi' || (!!selectedProvider?.configured && !!selectedModel);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      if (form.driverId === 'pi' && (!selectedProvider || !selectedProvider.configured || !selectedModel)) {
        setParseError('Select a configured model provider and model before creating a ticket.');
        return;
      }
      const profile = JSON.parse(form.profile) as ProjectProfile;
      const scenarios = JSON.parse(form.scenarios) as ScenarioDefinition[];
      const policy = JSON.parse(form.policy) as Policy;
      setParseError(null);
      const model = form.driverId === 'pi' ? { provider: form.providerId, id: form.modelId } : undefined;
      onSubmit({ title: form.title.trim(), request: form.request.trim(), repository: form.repository.trim(), baseRef: form.baseRef.trim() || 'HEAD', kind: form.kind, driverId: form.driverId, ...(model ? { model } : {}), profile, scenarios, policy, approved: true });
    } catch (error) {
      setParseError(error instanceof Error ? `Profile or scenario JSON is invalid: ${error.message}` : 'Profile or scenario JSON is invalid.');
    }
  };
  return <div className="modal-backdrop" role="presentation"><dialog open ref={dialogRef} className="modal" aria-labelledby="new-ticket-title" onCancel={onClose}>
    <div className="modal-header"><div><p className="eyebrow">Approved workflow</p><h2 id="new-ticket-title">Create a change ticket</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog">×</button></div>
    <form onSubmit={submit} className="stack gap-4">
      <div className="form-grid"><label className="field"><span>Title</span><input value={form.title} onChange={(event) => update('title', event.target.value)} maxLength={160} required placeholder="Add organization units page" /></label><label className="field"><span>Kind</span><select value={form.kind} onChange={(event) => switchKind(event.target.value as 'bugfix' | 'feature')}><option value="feature">New feature</option><option value="bugfix">Bug fix</option></select></label></div>
      <label className="field"><span>Request</span><textarea value={form.request} onChange={(event) => update('request', event.target.value)} maxLength={12000} required rows={4} placeholder="Describe the behavior and the expected result." /></label>
      <div className="form-grid"><label className="field"><span>Target repository</span><input value={form.repository} onChange={(event) => update('repository', event.target.value)} required placeholder="/Users/me/Code/project" /></label><label className="field"><span>Base ref</span><input value={form.baseRef} onChange={(event) => update('baseRef', event.target.value)} required /></label></div>
      <label className="field"><span>Agent driver</span><select value={form.driverId} onChange={(event) => update('driverId', event.target.value)}>{selectableDrivers.map((driver) => <option key={driver.id} value={driver.id}>{driver.name}</option>)}</select><small className="help-text">The deterministic demo driver is available through the explicit demo buttons.</small></label>
      {form.driverId === 'pi' && <div className="form-grid"><label className="field"><span>Model provider</span><select value={form.providerId} onChange={(event) => switchProvider(event.target.value)} required aria-describedby="model-provider-help"><option value="">Select a model provider</option>{modelProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}{provider.configured ? '' : ' (API key missing)'}</option>)}</select><small id="model-provider-help" className="help-text">{selectedProvider ? `${selectedProvider.configured ? 'Configured' : 'Missing API key'} · API environment: ${selectedProvider.apiKeyEnv || 'not specified'}` : 'No model provider is available. Configure an API key to use Pi.'}</small></label><label className="field"><span>Model</span><select value={form.modelId} onChange={(event) => update('modelId', event.target.value)} required disabled={!selectedProvider || selectedProvider.models.length === 0} aria-describedby="model-help"><option value="">Select a model</option>{selectedProvider?.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select><small id="model-help" className="help-text">{selectedModel ? `${selectedModel.id} · context ${selectedModel.contextWindow.toLocaleString()} · max output ${selectedModel.maxTokens.toLocaleString()}` : 'Choose a model from the selected provider.'}</small></label></div>}
      <button type="button" className="disclosure" aria-expanded={advanced} onClick={() => setAdvanced((current) => !current)}>{advanced ? 'Hide' : 'Show'} profile and scenario JSON <span aria-hidden="true">{advanced ? '⌃' : '⌄'}</span></button>
      {advanced && <div className="advanced-grid"><label className="field"><span>Approved project profile</span><textarea value={form.profile} onChange={(event) => update('profile', event.target.value)} rows={12} spellCheck={false} /></label><label className="field"><span>Approved scenarios</span><textarea value={form.scenarios} onChange={(event) => update('scenarios', event.target.value)} rows={12} spellCheck={false} /></label><label className="field advanced-policy"><span>Workflow policy</span><textarea value={form.policy} onChange={(event) => update('policy', event.target.value)} rows={7} spellCheck={false} /></label><p className="help-text">Executable extensions and repository configuration are not discovered or run automatically. Review this JSON before approving the ticket.</p></div>}
      <label className="approval-check"><input type="checkbox" checked={form.approved} onChange={(event) => update('approved', event.target.checked)} required /><span><strong>I approve this workflow to run on the trusted host.</strong><small>Commands, setup, scenarios, and the selected agent driver may execute in isolated workspaces with host permissions.</small>{form.driverId === 'pi' && <small>Pi sends this request, the approved scenario summary, and approved source files read by the model to {selectedProvider?.name ?? 'the selected provider'}.</small>}</span></label>
      {(parseError || error) && <div className="notice notice-danger" role="alert">{parseError || error}</div>}
      <div className="modal-footer"><button type="button" className="button" onClick={onClose}>Cancel</button><button type="submit" className="button button-primary" disabled={!form.approved || submitting || !piModelValid}>{submitting ? 'Creating…' : 'Create approved ticket'}</button></div>
    </form>
  </dialog></div>;
}

function ActionList({ actions }: { actions: ActionResult[] }) {
  if (!actions.length) return <p className="muted">No action assertions were captured.</p>;
  return <div className="action-list">{actions.map((action) => {
    const assertion = action.type === 'assert';
    const label = action.status === 'passed' ? (assertion ? 'Passed' : 'Action completed') : action.status === 'failed' ? 'Failed' : 'Not run';
    const tone = action.status === 'passed' ? (assertion ? 'good' : 'neutral') : action.status === 'failed' ? 'danger' : 'warning';
    const detail = action.status === 'passed'
      ? assertion ? `Expected ${String(action.expected ?? 'the assertion')}; observed ${String(action.actual ?? 'pass')}.` : 'Action completed.'
      : action.error || `Status: ${action.status}.`;
    return <div className="action-row" key={action.id}><div className="action-symbol" aria-hidden="true">{action.status === 'passed' ? '✓' : action.status === 'failed' ? '!' : '·'}</div><div><strong>{action.label}</strong><div className="action-detail">{detail}</div></div>{badge(label, tone)}</div>;
  })}</div>;
}

function ArtifactMedia({ artifactId, token, file, onError }: { artifactId: string; token: string; file?: FilePayload; onError?: (message: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    fetch(`/api/artifacts/${encodeURIComponent(artifactId)}`, { headers: { Authorization: `Bearer ${token}` } }).then(async (response) => {
      if (!response.ok) throw new Error(`Artifact request failed (${response.status}).`);
      const blob = await response.blob();
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch((caught) => { if (!active) return; const message = caught instanceof Error ? caught.message : 'Artifact unavailable.'; setError(message); onError?.(message); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [artifactId, token, onError]);
  if (error) return <span className="file-unavailable">{file?.name || artifactId}: unavailable</span>;
  if (!url) return <span className="file-loading">Loading {file?.name || 'evidence'}…</span>;
  const mediaType = file?.mediaType || '';
  if (mediaType.startsWith('image/')) return <img className="evidence-image" src={url} alt={file?.name || 'Captured evidence'} />;
  if (mediaType.startsWith('video/')) return <video className="evidence-video" controls preload="metadata" src={url} />;
  return <a className="file-link" href={url} download={file?.name || artifactId}>{file?.name || 'Download artifact'}</a>;
}

function EvidenceCard({ side, result, token, fileMap }: { side: 'baseline' | 'candidate'; result: { artifact?: Artifact<EvidencePayload>; stale: boolean }; token: string; fileMap: Map<string, Artifact<FilePayload>> }) {
  const outcome = displayOutcome(side, result.artifact, result.stale);
  const payload = result.artifact?.payload;
  const files = payload?.files ?? [];
  return <article className={`evidence-card evidence-${side}`}><div className="row between gap-2"><div><p className="eyebrow">{side === 'baseline' ? 'Before' : 'After'}</p><h4>{side === 'baseline' ? 'Base workspace' : 'Candidate workspace'}</h4></div>{badge(outcome.label, outcome.tone)}</div>{result.artifact ? <><p className="observation">{payload?.observation || 'No observation recorded.'}</p><ActionList actions={payload?.actions || []} />{payload?.limitations?.length ? <div className="limitations"><strong>Limitations</strong><ul>{payload.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul></div> : null}{files.length > 0 && <div className="artifact-files"><strong>Captured evidence</strong>{files.map((id) => <div key={id}><ArtifactMedia artifactId={id} token={token} file={fileMap.get(id)?.payload} /></div>)}</div>}<p className="fine-print">Captured {formatDate(payload?.finishedAt || result.artifact.createdAt)} · evidence revision {result.artifact.contentRevision}</p></> : <p className="muted">No runtime evidence was captured for this side.</p>}</article>;
}

function ScenarioReview({ detail, scenario, token, selected, onSelect, onAction }: { detail: RunDetail; scenario: ScenarioDefinition; token: string; selected: boolean; onSelect: () => void; onAction: (action: ActionName, scenarioId?: string) => void }) {
  const baseline = latestEvidence(detail, scenario, 'baseline');
  const candidate = latestEvidence(detail, scenario, 'candidate');
  const fileMap = new Map(detail.artifacts.filter((artifact) => artifact.artifactType === 'file').map((artifact) => [artifact.id, artifact as Artifact<FilePayload>]));
  return <section className={`scenario-review ${selected ? 'scenario-selected' : ''}`}><div className="scenario-heading"><div><button type="button" className="scenario-title" onClick={onSelect} aria-expanded={selected}><span aria-hidden="true">{selected ? '⌄' : '›'}</span><span>{scenario.name}</span></button><p className="scenario-meta">{scenario.route} · {scenario.viewport.width}×{scenario.viewport.height} · {scenario.fixture.mode === 'simulated' ? 'Simulated API' : scenario.fixture.mode === 'isolated-test' ? 'Isolated local test backend' : 'Live test backend'}</p></div><div className="row wrap gap-2">{badge(scenario.fixture.mode === 'simulated' ? 'Simulated API' : scenario.fixture.mode === 'isolated-test' ? 'Isolated backend' : 'Live backend', scenario.fixture.mode === 'simulated' ? 'warning' : 'neutral')}<button type="button" className="button button-small" onClick={() => onAction('preview', scenario.id)}>Open candidate</button></div></div>{selected && <div className="scenario-body"><div className="row wrap between gap-2 scenario-actions"><button type="button" className="button button-small" onClick={() => onAction('reset-preview', scenario.id)}>Reset scenario</button><button type="button" className="button button-small" onClick={() => onAction('close-preview', scenario.id)}>Close candidate</button><span className="muted">Interactive exploration uses a separate managed browser context.</span></div><div className={`evidence-grid ${detail.run.kind === 'feature' ? 'feature-evidence' : ''}`}>{detail.run.kind === 'bugfix' ? <EvidenceCard side="baseline" result={baseline} token={token} fileMap={fileMap} /> : <article className="evidence-card baseline-not-applicable"><p className="eyebrow">Before</p><h4>Baseline not applicable</h4><p className="muted">New feature scenarios show the implemented behavior without inventing a broken before state.</p></article>}<EvidenceCard side="candidate" result={candidate} token={token} fileMap={fileMap} /></div></div>}</section>;
}

function ReviewPanel({ detail, token, selectedScenarioId, onScenario, onAction }: { detail: RunDetail; token: string; selectedScenarioId: string | null; onScenario: (id: string) => void; onAction: (action: ActionName, scenarioId?: string) => void }) {
  return <section className="stack gap-4"><div className="section-heading"><div><p className="eyebrow">Observed behavior</p><h2>Approved scenarios</h2></div><p className="muted">Same route, fixture, identity, viewport, and assertions for every comparable run.</p></div>{detail.run.scenarios.map((scenario) => <ScenarioReview key={`${scenario.id}-${scenario.revision}`} detail={detail} scenario={scenario} token={token} selected={selectedScenarioId === scenario.id} onSelect={() => onScenario(scenario.id)} onAction={onAction} />)}</section>;
}

function ActivityPanel({ detail, token }: { detail: RunDetail; token: string }) {
  const agentResults = detail.artifacts.filter((artifact) => artifact.artifactType === 'agent-result');
  const files = detail.artifacts.filter((artifact) => artifact.artifactType === 'file') as Artifact<FilePayload>[];
  return <section className="stack gap-4"><div className="section-heading"><div><p className="eyebrow">Durable record</p><h2>Activity</h2></div><p className="muted">Events and stage attempts persisted by the local service.</p></div><div className="surface"><div className="timeline">{detail.events.length ? detail.events.map((event) => <div className="timeline-item" key={event.id}><span className="timeline-dot" aria-hidden="true" /><div><strong>{event.message}</strong><p>{event.type} · {formatDate(event.at)}</p>{event.data ? <details><summary>Event details</summary><pre>{JSON.stringify(event.data, null, 2)}</pre></details> : null}</div></div>) : <p className="muted">No events have been recorded yet.</p>}</div></div><div className="surface"><h3>Stage attempts</h3>{detail.attempts.length ? <div className="attempt-list">{detail.attempts.map((attempt) => <AttemptRow key={attempt.id} attempt={attempt} />)}</div> : <p className="muted">No stage attempts have been recorded yet.</p>}</div>{agentResults.map((artifact) => { const payload = artifact.payload as { summary?: string; reason?: string; outcome?: string; usage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } }; return <div className="surface commentary-card" key={artifact.id}><div className="row between gap-2"><h3>Agent commentary</h3>{badge(payload.outcome === 'completed' ? 'Completed' : 'Blocked', payload.outcome === 'completed' ? 'neutral' : 'warning')}</div><p>{payload.summary || 'No summary supplied.'}</p>{payload.reason && <p className="muted">{payload.reason}</p>}<p className="fine-print">Token usage: {payload.usage ? `${payload.usage.inputTokens ?? 0} in · ${payload.usage.outputTokens ?? 0} out${payload.usage.cachedInputTokens ? ` · ${payload.usage.cachedInputTokens} cached` : ''}` : 'unavailable'} · commentary, not verification.</p></div>; })}{files.length > 0 && <div className="surface"><div className="row between gap-2"><h3>Logs and captured files</h3><span className="muted">Protected artifact downloads</span></div><div className="artifact-list">{files.map((artifact) => <div className="artifact-list-row" key={artifact.id}><div><strong>{artifact.payload.name}</strong><p>{artifact.payload.mediaType} · {artifact.payload.size} bytes · {shortDigest(artifact.payload.sha256)}</p></div><ArtifactMedia artifactId={artifact.id} token={token} file={artifact.payload} /></div>)}</div></div>}</section>;
}

function AttemptRow({ attempt }: { attempt: StageAttempt }) {
  return <div className="attempt-row"><div><strong>{prettyPhase(attempt.phase)}</strong><p>{formatDate(attempt.startedAt)}{attempt.finishedAt ? ` → ${formatDate(attempt.finishedAt)}` : ''}</p></div>{badge(attempt.status === 'passed' ? 'Stage completed' : attempt.status === 'running' ? 'Running' : attempt.status === 'interrupted' ? 'Interrupted' : attempt.status === 'cancelled' ? 'Cancelled' : 'Failed', attempt.status === 'passed' ? 'neutral' : attempt.status === 'running' ? 'neutral' : 'warning')}{attempt.error && <p className="attempt-error">{attempt.error}</p>}</div>;
}

function ChangesPanel({ detail }: { detail: RunDetail }) {
  const run = detail.run;
  return <section className="stack gap-4"><div className="section-heading"><div><p className="eyebrow">Source inspection</p><h2>Changes</h2></div><span className="muted">Diff is read-only</span></div><div className="surface"><h3>Request</h3><p className="request-copy">{run.request}</p><dl className="metadata-grid"><div><dt>Repository</dt><dd>{run.repository}</dd></div><div><dt>Base commit</dt><dd><code>{shortDigest(run.baseCommit)}</code></dd></div><div><dt>Candidate snapshot</dt><dd><code>{shortDigest(run.candidate?.snapshotId)}</code></dd></div><div><dt>Source digest</dt><dd><code>{shortDigest(run.candidate?.sourceDigest)}</code></dd></div><div><dt>Candidate workspace</dt><dd>{run.workspace?.candidatePath || 'Unavailable'}</dd></div><div><dt>Branch</dt><dd>{run.workspace?.branch || 'Unavailable'}</dd></div></dl></div><div className="surface diff-surface"><div className="row between gap-2"><h3>Actual code diff</h3><span className="muted">Escaped plain text</span></div><pre className="diff">{detail.diff || 'No diff was recorded for this candidate.'}</pre></div><div className="notice notice-info">Acceptance only records this candidate as reviewed. It does not commit, merge, push, or deploy code.</div></section>;
}

function ChecksPanel({ detail }: { detail: RunDetail }) {
  const profileChecks = new Map(detail.run.profile.checks.map((check) => [check.id, check]));
  const requiredCheckIds = new Set(detail.run.policy.requiredCheckIds);
  const externalCheckIds = detail.artifacts
    .filter((artifact) => artifact.artifactType === 'check')
    .map((artifact) => (artifact.payload as { checkId?: string }).checkId)
    .filter((checkId): checkId is string => !!checkId);
  const checkIds = [...new Set([...profileChecks.keys(), ...requiredCheckIds, ...externalCheckIds])];
  return <section className="stack gap-4"><div className="section-heading"><div><p className="eyebrow">Verification</p><h2>Checks and limitations</h2></div><p className="muted">Each row comes from an execution result or is explicitly marked untested.</p></div><div className="surface"><h3>Project checks</h3>{checkIds.length ? checkIds.map((checkId) => {
    const check = profileChecks.get(checkId);
    const required = !!check?.required || requiredCheckIds.has(checkId);
    const current = latestCheck(detail, checkId);
    const result = current.artifact?.payload as { status?: string; summary?: string; details?: string } | undefined;
    const status = current.stale ? 'stale' : result?.status || 'not-tested';
    const summary = current.stale ? 'A previous result belongs to another candidate or review revision.' : result?.summary || result?.details || 'Not tested.';
    return <div className="check-row" key={checkId}><div><strong>{check?.name || `External check: ${checkId}`}</strong><p>{summary}</p></div><div className="row wrap end gap-2">{required && badge('Required', 'neutral')}{badge(status === 'passed' ? 'Passed' : status === 'failed' ? 'Failed' : status === 'blocked' ? 'Blocked' : status === 'stale' ? 'Evidence stale' : 'Not tested', status === 'passed' ? 'good' : status === 'failed' ? 'danger' : status === 'blocked' || status === 'stale' ? 'warning' : 'neutral')}</div></div>;
  }) : <p className="muted">No project checks are configured in the approved profile.</p>}</div><div className="surface"><h3>Scenario coverage</h3>{detail.run.scenarios.map((scenario) => { const candidate = latestEvidence(detail, scenario, 'candidate'); const result = displayOutcome('candidate', candidate.artifact, candidate.stale); return <div className="check-row" key={scenario.id}><div><strong>{scenario.name}</strong><p>{scenario.fixture.mode === 'simulated' ? 'Simulated API' : scenario.fixture.mode === 'isolated-test' ? 'Isolated local test backend' : 'Live test backend'} · revision {scenario.revision}</p></div>{badge(result.label, result.tone)}</div>; })}</div><div className="surface"><h3>What remains uncertain</h3><ul className="plain-list"><li>Missing evidence is shown as Not tested and does not count as a pass.</li><li>Agent commentary is separate from assertions and command results.</li><li>Hosted model usage is shown only when the selected driver supplies reliable usage data.</li><li>Browser capture redaction is not guaranteed; avoid using real credentials in fixtures.</li></ul></div></section>;
}

function FeedbackForm({ scenarios, onSubmit, onCancel, submitting }: { scenarios: ScenarioDefinition[]; onSubmit: (text: string, scenarioId?: string, actionId?: string) => void; onCancel: () => void; submitting: boolean }) {
  const [text, setText] = useState('');
  const [scenarioId, setScenarioId] = useState(scenarios[0]?.id || '');
  const [actionId, setActionId] = useState('');
  return <form className="feedback-form surface" onSubmit={(event) => { event.preventDefault(); if (text.trim()) onSubmit(text.trim(), scenarioId || scenarios[0]?.id, actionId || undefined); }}><div className="row between gap-2"><div><h3>Request a correction</h3><p className="muted">Attach a small, specific observation to the scenario that needs another attempt.</p></div><button type="button" className="icon-button" onClick={onCancel} aria-label="Close feedback">×</button></div><label className="field"><span>What should change?</span><textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={1000} rows={4} required autoFocus placeholder="For example: search should also match the organization code." /></label><div className="form-grid"><label className="field"><span>Scenario</span><select value={scenarioId} onChange={(event) => setScenarioId(event.target.value)} required>{scenarios.map((scenario) => <option value={scenario.id} key={scenario.id}>{scenario.name}</option>)}</select></label><label className="field"><span>Action (optional)</span><input value={actionId} onChange={(event) => setActionId(event.target.value)} placeholder="assert-persisted-name" /></label></div><div className="row end gap-2"><button type="button" className="button" onClick={onCancel}>Cancel</button><button type="submit" className="button button-primary" disabled={submitting || !text.trim()}>{submitting ? 'Sending…' : 'Request changes'}</button></div></form>;
}

function PendingApproval({ run, onAction }: { run: Run; onAction: (action: ActionName) => void }) {
  if (!run.pendingApproval) return null;
  return <div className="notice notice-warning pending-approval"><div><strong>Approval required before {run.pendingApproval.operation}</strong><p>The workflow is paused until you explicitly approve operation <code>{run.pendingApproval.key}</code>.</p></div><button type="button" className="button button-small" onClick={() => onAction('approve')}>Approve operation</button></div>;
}

function ReviewActions({ detail, onAction, onFeedback, actionBusy }: { detail: RunDetail; onAction: (action: ActionName) => void; onFeedback: () => void; actionBusy?: string | null }) {
  const run = detail.run;
  const requiredCheckIds = new Set([...run.profile.checks.filter((check) => check.required).map((check) => check.id), ...run.policy.requiredCheckIds]);
  const checksPassed = [...requiredCheckIds].every((checkId) => { const current = latestCheck(detail, checkId); return !current.stale && (current.artifact?.payload as { status?: string } | undefined)?.status === 'passed'; });
  const scenariosPassed = run.scenarios.every((scenario) => { const result = latestEvidence(detail, scenario, 'candidate'); return !result.stale && result.artifact?.payload.outcome === 'passed'; });
  const canAccept = run.status === 'complete' && run.phase === 'READY_FOR_REVIEW' && !!run.candidate && !run.sourceStale && !run.acceptance && checksPassed && scenariosPassed;
  const active = run.status === 'running' || run.status === 'queued';
  const canResume = run.status === 'paused' || run.status === 'blocked' || run.status === 'failed';
  const canVerify = ['complete', 'failed', 'paused', 'blocked'].includes(run.status) && !!run.workspace?.candidatePath;
  const canRequestChanges = !!run.candidate && !active && run.status !== 'cancelled' && !actionBusy;
  return <div className="review-actions"><div className="row wrap gap-2"><button type="button" className="button" onClick={onFeedback} disabled={!canRequestChanges}>Request changes</button>{canAccept ? <button type="button" className="button button-primary" onClick={() => onAction('accept')} disabled={!!actionBusy}>{actionBusy === 'accept' ? 'Accepting…' : 'Accept behavior'}</button> : <button type="button" className="button button-primary" disabled title="Fresh candidate evidence and required checks must pass before acceptance">Accept behavior</button>}{canVerify && <button type="button" className="button" onClick={() => onAction('verify')} disabled={!!actionBusy}>{actionBusy === 'verify' ? 'Verifying…' : 'Run verification again'}</button>}{active && <button type="button" className="button button-quiet" onClick={() => onAction(run.status === 'queued' ? 'cancel' : 'pause')} disabled={!!actionBusy}>{actionBusy === 'pause' ? 'Stopping…' : actionBusy === 'cancel' ? 'Cancelling…' : run.status === 'queued' ? 'Cancel ticket' : 'Pause safely'}</button>}{canResume && <button type="button" className="button" onClick={() => onAction('resume')} disabled={!!actionBusy}>{actionBusy === 'resume' ? 'Resuming…' : 'Resume run'}</button>}{(run.status === 'blocked' || run.status === 'failed') && <button type="button" className="button button-quiet" onClick={() => onAction('cancel')} disabled={!!actionBusy}>{actionBusy === 'cancel' ? 'Cancelling…' : 'Cancel run'}</button>}</div><p className="fine-print">{run.acceptance ? `Accepted ${formatDate(run.acceptance.acceptedAt)} · candidate remains unchanged and unpublished.` : !run.sourceStale && canAccept ? 'All required candidate evidence and checks are fresh.' : 'Acceptance is disabled until all required candidate checks pass on the displayed revision.'}</p>{(run.status === 'paused' || run.status === 'blocked') && <p className="manual-edit-note">You can edit the candidate safely while paused. Resume will fingerprint source files, preserve your changes, and invalidate stale evidence if needed.</p>}</div>;
}

function DetailView({ detail, token, onBack, onAction, actionBusy, onRefresh, notice, error, onFeedback, feedbackOpen, selectedScenarioId, onScenario }: { detail: RunDetail; token: string; onBack: () => void; onAction: (action: ActionName, scenarioId?: string) => void; actionBusy?: string | null; onRefresh: () => void; notice?: string | null; error?: string | null; onFeedback: () => void; feedbackOpen: boolean; selectedScenarioId: string | null; onScenario: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>('review');
  const run = detail.run;
  const status = statusFor(run);
  const tabButton = (id: Tab, label: string) => <button type="button" className="tab-button" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>;
  return <main className="page-shell detail-shell"><button type="button" className="back-link" onClick={onBack}>← All tickets</button><section className="detail-header"><div><div className="row wrap gap-2"><p className="eyebrow">{run.kind === 'bugfix' ? 'Bug fix' : 'New feature'} · {run.demo ? 'Deterministic demo' : 'Project run'}</p>{badge(status.label, status.tone)}</div><h1>{run.title}</h1><p className="lede request-copy">{run.request}</p></div><button type="button" className="button button-quiet" onClick={onRefresh} disabled={!!actionBusy}>Refresh</button></section><div className="candidate-strip"><div><span className="strip-label">Candidate under review</span><strong>{shortDigest(run.candidate?.snapshotId)}</strong><span className="muted">Source {shortDigest(run.candidate?.sourceDigest)} · review revision r{run.reviewRevision}</span><span className="muted">Driver {run.driverId}{run.model ? ` · Model ${run.model.provider}/${run.model.id}` : ''}</span></div><div className="row wrap gap-2">{run.sourceStale && badge('Evidence stale', 'warning')}{run.demo && badge('Demo · fake driver', 'warning')}<span className="muted">{prettyPhase(run.phase)}</span></div></div>{run.blockingReason && <div className="notice notice-warning" role="status"><strong>{run.status === 'blocked' ? 'Blocked' : 'Last workflow message'}</strong><p>{run.blockingReason}</p></div>}{run.lastError && <div className="notice notice-danger" role="alert">{run.lastError}</div>}{error && <div className="notice notice-danger" role="alert">{error}</div>}{notice && <div className="notice notice-info" role="status">{notice}</div>}<PendingApproval run={run} onAction={onAction} /><nav className="tabs" aria-label="Review sections">{tabButton('review', 'Review')}{tabButton('activity', 'Activity')}{tabButton('changes', 'Changes')}{tabButton('checks', 'Checks')}</nav><div className="tab-content">{tab === 'review' && <ReviewPanel detail={detail} token={token} selectedScenarioId={selectedScenarioId} onScenario={onScenario} onAction={onAction} />}{tab === 'activity' && <ActivityPanel detail={detail} token={token} />}{tab === 'changes' && <ChangesPanel detail={detail} />}{tab === 'checks' && <ChecksPanel detail={detail} />}</div>{feedbackOpen && <FeedbackForm scenarios={run.scenarios} onSubmit={(text, scenarioId, actionId) => onAction('feedback', scenarioId || actionId ? `${scenarioId || ''}|${actionId || ''}|${text}` : text)} onCancel={() => onFeedback()} submitting={actionBusy === 'feedback'} />}{!feedbackOpen && <ReviewActions detail={detail} onAction={onAction} onFeedback={onFeedback} actionBusy={actionBusy} />}</main>;
}

function App() {
  const [token, setToken] = useState<string | null>(() => tokenFromLocation());
  const [config, setConfig] = useState<SecondlookConfig | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const mounted = useRef(true);
  const polling = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const signOut = useCallback(() => { window.sessionStorage.removeItem(TOKEN_KEY); setToken(null); setConfig(null); setRuns([]); setDetail(null); setSelectedId(null); }, []);
  const handleFailure = useCallback((caught: unknown) => { if (caught instanceof ApiFailure && caught.status === 401) signOut(); else setError(caught instanceof Error ? caught.message : 'Request failed.'); }, [signOut]);

  const refresh = useCallback(async (initial = false) => {
    if (!token || polling.current) return;
    polling.current = true;
    if (initial) setLoading(true);
    try {
      const [nextConfig, result] = await Promise.all([config ? Promise.resolve(config) : api<SecondlookConfig>(token, '/api/config'), api<{ runs: Run[] }>(token, '/api/runs')]);
      if (!mounted.current) return;
      setConfig(nextConfig);
      setRuns(result.runs);
      if (selectedId) {
        const current = await api<RunDetail>(token, `/api/runs/${encodeURIComponent(selectedId)}`);
        if (mounted.current) {
          setDetail(current);
          setSelectedScenarioId((currentSelection) => currentSelection ?? current.run.scenarios[0]?.id ?? null);
        }
      }
      setError(null);
    } catch (caught) { if (mounted.current) handleFailure(caught); } finally { polling.current = false; if (mounted.current) setLoading(false); }
  }, [config, handleFailure, selectedId, token]);

  useEffect(() => { if (!token) return; void refresh(true); const timer = window.setInterval(() => void refresh(false), 1500); return () => window.clearInterval(timer); }, [refresh, token]);

  const openRun = useCallback(async (id: string) => {
    if (!token) return;
    setSelectedId(id); setSelectedScenarioId(null); setFeedbackOpen(false); setNotice(null); setError(null); setLoading(true);
    try { const result = await api<RunDetail>(token, `/api/runs/${encodeURIComponent(id)}`); if (mounted.current) { setDetail(result); setSelectedScenarioId(result.run.scenarios[0]?.id ?? null); } } catch (caught) { handleFailure(caught); } finally { if (mounted.current) setLoading(false); }
  }, [handleFailure, token]);

  const returnHome = useCallback(() => { setSelectedId(null); setDetail(null); setFeedbackOpen(false); setNotice(null); setError(null); }, []);

  const runDemo = useCallback(async (kind: 'bugfix' | 'feature') => {
    if (!token) return;
    setSubmitting(true); setError(null); setNotice(null);
    try { const result = await api<{ run: Run }>(token, '/api/demo', jsonBody({ kind })); setNotice(`${kind === 'bugfix' ? 'Bug-fix' : 'Feature'} demo queued.`); await refresh(true); await openRun(result.run.id); } catch (caught) { handleFailure(caught); } finally { if (mounted.current) setSubmitting(false); }
  }, [handleFailure, openRun, refresh, token]);

  const createTicket = useCallback(async (input: CreateRunInput) => {
    if (!token) return;
    setSubmitting(true); setError(null);
    try { const result = await api<{ run: Run }>(token, '/api/runs', jsonBody(input)); setShowNew(false); setNotice('Approved ticket created and queued.'); await refresh(true); await openRun(result.run.id); } catch (caught) { handleFailure(caught); } finally { if (mounted.current) setSubmitting(false); }
  }, [handleFailure, openRun, refresh, token]);

  const runAction = useCallback(async (action: ActionName, scenarioId?: string) => {
    if (!token || !detail) return;
    const run = detail.run;
    if (action === 'accept' && (!run.candidate || run.sourceStale)) return;
    setActionBusy(action); setError(null); setNotice(null);
    let payload: Record<string, unknown> = { action };
    if (scenarioId && ['preview', 'reset-preview', 'close-preview'].includes(action)) payload.scenarioId = scenarioId;
    if (action === 'accept' && run.candidate) { payload.candidateSnapshotId = run.candidate.snapshotId; payload.reviewRevision = run.reviewRevision; }
    if (action === 'feedback') {
      const pieces = (scenarioId || '').split('|');
      const maybeScenario = pieces.length > 1 ? pieces[0] : undefined;
      const maybeAction = pieces.length > 1 ? pieces[1] : undefined;
      const text = pieces.length > 1 ? pieces.slice(2).join('|') : scenarioId || '';
      payload.feedback = text;
      if (maybeScenario) {
        payload.scenarioId = maybeScenario;
        if (maybeAction) payload.actionId = maybeAction;
      }
    }
    try { const result = await api<{ run: Run; message?: string }>(token, `/api/runs/${encodeURIComponent(run.id)}/actions`, jsonBody(payload)); setNotice(result.message || (action === 'preview' ? 'Candidate opened in the managed browser.' : action === 'reset-preview' ? 'Candidate scenario reset.' : action === 'close-preview' ? 'Candidate browser closed.' : action === 'accept' ? 'Behavior accepted for this candidate. Nothing was merged or deployed.' : action === 'feedback' ? 'Feedback recorded. Previous evidence is now stale.' : `Action ${action} accepted.`)); if (action === 'feedback') setFeedbackOpen(false); const current = await api<RunDetail>(token, `/api/runs/${encodeURIComponent(run.id)}`); if (mounted.current) { setDetail(current); setRuns((items) => items.map((item) => item.id === current.run.id ? current.run : item)); } } catch (caught) { handleFailure(caught); } finally { if (mounted.current) setActionBusy(null); }
  }, [detail, handleFailure, token]);

  if (!token) return <TokenEntry onSubmit={(next) => { window.sessionStorage.setItem(TOKEN_KEY, next); setToken(next); setError(null); }} error={error} />;
  return <div className="app"><Header onHome={returnHome} onNew={() => { setShowNew(true); setError(null); }} onSignOut={signOut} security={config?.security} />{selectedId && detail ? <DetailView detail={detail} token={token} onBack={returnHome} onAction={runAction} actionBusy={actionBusy} onRefresh={() => void refresh(true)} notice={notice} error={error} onFeedback={() => setFeedbackOpen((current) => !current)} feedbackOpen={feedbackOpen} selectedScenarioId={selectedScenarioId} onScenario={setSelectedScenarioId} /> : <Board runs={runs} loading={loading} onOpen={openRun} onDemo={runDemo} onNew={() => setShowNew(true)} error={error} submitting={submitting} />}<div className="sr-only" aria-live="polite">{notice || error || ''}</div>{showNew && config && <NewTicketModal config={config} onClose={() => setShowNew(false)} onSubmit={createTicket} submitting={submitting} error={error} />}</div>;
}

export default App;
