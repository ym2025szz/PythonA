import './compat.js';
import { WorkspaceStore } from './core/workspace-store.js';
import { DocumentSession } from './core/document-session.js';
import {
  NativePythonPackageClient,
  NativeRuntimePackClient,
  RuntimeAdapter
} from './core/runtime-adapter.js';
import { NativeBroker, NativeWorkspaceClient } from './core/native-broker.js';
import { LanguageService, offsetToPosition, positionToOffset, toDocumentUri } from './core/language-service.js';
import { DshAgentController } from './core/dsh-controller.js';
import { DshGateway } from './core/dsh-gateway.js';
import { DshStreamView } from './ui/dsh-stream-view.js';
import { AppDialogs, validateWorkspacePath } from './ui/dialogs.js';
import { ModelPicker } from './ui/model-picker.js';
import { renderTestResults } from './ui/test-results-view.js';
import { icon } from './ui/icons.js';
import { EditorDraftClient } from './core/editor-drafts.js';
import { ConversationClient } from './core/conversation-client.js';
import { InlineCompletionClient } from './core/inline-completion-client.js';
import { InlineCompletionController } from './core/inline-completion-controller.js';
import { createDshTurn, applyDshStreamEvent, finishDshTurn, summarizeDshContext, contextUsage } from './core/dsh-stream-state.js';
import {
  createOfficialDshState,
  findOfficialModel,
  modelReasoningLevels,
  normalizeOfficialCatalog
} from './core/dsh-official.js';
import { ProjectModelService } from './core/project-model.js';
import { ProjectIndexService } from './core/project-index.js';
import { ProjectContextIndexer } from './core/context-indexer.js';
import { RunConfigurationStore } from './core/run-configurations.js';
import { captureRenameBase, createRenameTransaction, validateRenameBase } from './core/refactor.js';
import { TestAdapter, createTestResultTree, normalizeTestResult } from './core/test-adapter.js';
import { createDefaultServiceRegistry } from './core/service-registry.js';
import { createPatch } from './core/patch-engine.js';
import { computeDshLayout, normalizeTerminalTab, withoutDiagnosticsForPath } from './core/ui-policy.js';
import { EditorCoordinator } from './editor/editor-coordinator.js';
import { MergeDiffView } from './editor/editor-adapter.js';
import { PerformanceDiagnostics, shouldSubmitPrompt, runtimeStartupState, dshStartupState, normalizeCursorPositions, dshErrorMessage, boundDshTranscript } from './core/diagnostics.js';
import { collectRunResult } from './core/run-result.js';
import { FileOperationHistory } from './core/file-operations.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const isPythonPath = (path) => /\.pyi?$/i.test(String(path || ''));
const UI_STORAGE_KEY = 'pythona.ui.v1';
const TERMINAL_MAX_CHUNKS = 2_000;
const TERMINAL_MAX_CHARACTERS = 2 * 1024 * 1024;
const TERMINAL_MERGE_CHARACTERS = 32 * 1024;
const DSH_MAX_MESSAGES = 200;
const DSH_MAX_ACTIVITIES = 300;
let terminalCharacters = 0;
const diagnostics = new PerformanceDiagnostics();
for (const metric of ['webviewStartMs', 'runtimeReadyMs', 'languageReadyMs', 'dshCatalogMs']) diagnostics.start(metric);
let cursorPersistTimer = null;
let inputFramePending = false;
let dshComposing = false;
const savePromises = new Map();

function safeParse(value, fallback) {
  try { return JSON.parse(value) || fallback; } catch (error) { return fallback; }
}

const defaultUi = {
  theme: 'dark',
  mode: 'adaptive',
  projectOpen: true,
  dshOpen: true,
  terminalOpen: true,
  terminalHeight: 200,
  terminalMaximized: false,
  codeTools: true,
  conversationId: null,
  projectWidth: 228,
  dshWidth: 320,
  leftTool: 'project',
  dshTab: 'chat',
  terminalTab: 'terminal',
  openTabs: ['src/train.py'],
  activePath: 'src/train.py',
  folderOpen: { '': true, src: true, tests: false },
  cursorPositions: {},
  settings: {
    editorSize: 16,
    autosave: 2,
    lineNumbers: true,
    foldGutter: true,
    autocomplete: true,
    inlineEnabled: true,
    inlineModel: '',
    recentModels: [],
    wordWrap: false,
    tabSize: 4,
    uiFont: 'system',
    codeFont: 'jetbrains',
    dshFont: 'ui',
    restore: true,
    livePreview: true,
    approval: true,
    interpreter: '由运行环境自动检测',
    background: false,
    gateway: '',
    dshMode: 'official',
    dshProvider: '',
    dshModel: '',
    dshReasoning: 'off',
    codeUpload: true,
    externalFiles: false,
    network: false
  }
};

let persistedUi = {};
try {
  persistedUi = safeParse(globalThis.localStorage?.getItem(UI_STORAGE_KEY), {});
} catch (error) {
  // Android WebView/file origins may disable DOM storage. The in-memory UI
  // state remains fully usable; persistence is simply skipped for this run.
  persistedUi = {};
}
// "启动时恢复工作区" keeps preferences but may intentionally discard the
// previous tab/folder session. The workspace contents remain local-first and
// persistent either way.
const restoredSessionUi = persistedUi.settings?.restore === false
  ? { ...persistedUi, openTabs: defaultUi.openTabs, activePath: defaultUi.activePath, folderOpen: defaultUi.folderOpen, cursorPositions: {} }
  : persistedUi;
const ui = {
  ...defaultUi,
  ...restoredSessionUi,
  settings: { ...defaultUi.settings, ...(persistedUi.settings || {}) },
  folderOpen: { ...defaultUi.folderOpen, ...(restoredSessionUi.folderOpen || {}) },
  messages: [{ role: 'assistant', text: 'DSH 可以读取工作区、提出修改并运行脚本。请求前会展示上下文清单，任何写入或运行都需要确认。' }],
  activities: [],
  dshTurn: null,
  dshContext: null,
  dshContextMode: 'preview',
  dshAttachments: [],
  dshSelection: null,
  changedTransactions: [],
  pendingPatch: null,
  pendingCommand: null,
  pendingApproval: null,
  settingsDraft: null,
  diffPatch: null,
  eventCount: 0,
  autosaveTimer: null,
  toastTimer: null,
  workspaceReconcileQueued: false,
  editingRunId: null,
  runEnvironmentSecrets: {},
  runtimePack: {
    phase: 'checking',
    title: '正在检查运行包能力',
    detail: '只接受 PythonA Ed25519 签名包。',
    result: null,
    busy: false
  },
  pythonPackage: {
    phase: 'checking',
    title: '正在检查 wheel 安装能力',
    detail: '仅接受平台无关的纯 Python wheel。',
    result: null,
    busy: false
  },
  initialized: false
};
ui.cursorPositions = normalizeCursorPositions(restoredSessionUi.cursorPositions, ui.openTabs);

const startupStatus = Object.fromEntries(['dsh', 'runtime', 'language'].map(service => [service, { state: 'pending', detail: '正在准备…' }]));
const serviceFailureCycles = new Set();
function renderStartupStatus() {
  const panel = $('#startup-status'); if (!panel) return;
  const labels = { ready: '就绪', pending: '准备中…', retrying: '重试中…', error: '启动失败', unavailable: '当前不可用', idle: '等待 Python 文件' };
  for (const [id, status] of Object.entries(startupStatus)) {
    const { state, detail } = status;
    const row = $('#startup-' + id + '-row'); if (!row) continue;
    row.dataset.state = state;
    row.querySelector('.startup-state').textContent = detail || labels[state] || state;
    row.title = detail || labels[state] || '';
  }
  const visible = Object.values(startupStatus).some(({ state }) => ['pending', 'retrying', 'error'].includes(state));
  panel.hidden = !visible && !ui.servicesExpanded;
  $('#service-status-button').setAttribute('aria-expanded', String(!panel.hidden));
}
function markStartup(service, state, detail) {
  if(state==='ready')serviceFailureCycles.delete(service);
  startupStatus[service] = { state, detail: detail?.message || (typeof detail === 'string' ? detail : '') };
  if (state === 'ready') diagnostics.finish({ runtime: 'runtimeReadyMs', language: 'languageReadyMs', dsh: 'dshCatalogMs' }[service]);
  renderStartupStatus();
}

// Older prototypes stored a portrait mode. PythonA is tablet-first landscape;
// migrate any stale value instead of leaving the layout selector blank.
// 0.2 prototypes stored landscape/compact/portrait. 0.3 has one adaptive
// landscape policy and preserves only the actual panel open state.
ui.mode = 'adaptive';
ui.settings.interpreter = '由运行环境自动检测';
ui.settings.background = false;
ui.settings.externalFiles = false;
ui.settings.network = false;
ui.settings.livePreview = true;
ui.settings.approval = true;

const nativeBroker = new NativeBroker({ timeoutMs: 120_000 });
const nativeWorkspace = nativeBroker.available ? new NativeWorkspaceClient(nativeBroker, { workspaceId: 'default' }) : null;
const store = new WorkspaceStore({ nativeClient: nativeWorkspace });
const documentSession = new DocumentSession(store);
const fileOperations = new FileOperationHistory(store);
const language = new LanguageService({ bridge: nativeBroker.available ? nativeBroker : null });
const runtime = new RuntimeAdapter({ bridge: nativeBroker.available ? nativeBroker : null });
const tests = new TestAdapter({ bridge: nativeBroker.available ? nativeBroker : null });
const runtimePack = new NativeRuntimePackClient(nativeBroker);
const pythonPackages = new NativePythonPackageClient(nativeBroker, { environmentId: 'default' });
const projectModel = new ProjectModelService({ bridge: nativeBroker.available ? nativeBroker : null, workspaceName: store.workspaceName });
const projectIndex = new ProjectIndexService({ bridge: nativeBroker.available ? nativeBroker : null, workspace: store });
const contextIndexer = new ProjectContextIndexer({ workspace: store, projectIndex });
const runConfigurations = new RunConfigurationStore({ bridge: nativeBroker.available ? nativeBroker : null });
const serviceRegistry = createDefaultServiceRegistry();
const dshGateway = nativeBroker.available ? new DshGateway(nativeBroker) : undefined;
const dialogs = new AppDialogs();
const conversations = new ConversationClient(nativeBroker, { workspaceId:'default' });
documentSession.attachDrafts(new EditorDraftClient(nativeBroker, 'default'));
let inlineController = null;
let inlineModelVersion = 0;
let inlineServiceGeneration = 0;
const inlineClient = new InlineCompletionClient(nativeBroker);
let conversationPage = null;
let conversationSwitch = 0;
let conversationDraftTimer = null;
let conversationListOffset = 0;
let dshProfiles = [];
let dshProviderKinds = [];
const officialDsh = createOfficialDshState();
let officialDshCatalog = officialDsh.value.catalog;
const modelPicker = new ModelPicker({ dialog:$('#dsh-model-dialog'), button:$('#dsh-model-button'),
  onSelect: selection => setOfficialSelection(selection),
  onRefresh: () => refreshOfficialDsh(), onManage: () => { showSettings(); $('[data-settings-page="dsh"]').click(); } });
let officialDshGeneration = 0;
let officialDshRefreshTimer = null;
let dshRenderFrame = null;
let dshFullRenderPending = false;
let dshLastPaint = 0;
let dshContextSequence = 0;
let dshContextRendered = null;
const dshStreamView = new DshStreamView($('#dsh-stream'), { jumpButton: $('#dsh-jump-latest'), maxRows: 80,
  onContext: context => {ui.dshContext=summarizeDshContext(context);ui.dshContextMode='history';ui.dshHistoryUsage=context.usage;renderDshContext();$('#dsh-context').open=true;},
  onHistoricalPatch: patch => {if(patch.files?.length)renderMultiFileDiff(patch.files,'历史 Diff（只读）');else if(patch.path)renderDiff(patch);},
  onRetry: prompt => {if(ui.dshBusy || ui.historyLoading)return;$('#dsh-input').value=prompt;$('#dsh-form').requestSubmit();},
  onOpenLocation: location => openFile(location.path).then(() => {
    if (location.line > 0) editorCoordinator.goTo(positionToOffset(documentSession.buffer, { line: location.line - 1, character: 0 }));
  }).catch(error => showToast(error.message)) });
$('#dsh-stream').prepend($('#dsh-history-pages'));
let completionFilesCache = [];
let completionFilesDirty = true;

function getCompletionFiles() {
  if (completionFilesDirty) {
    completionFilesCache = store.listFiles();
    completionFilesDirty = false;
  }
  if (!documentSession.path || !documentSession.dirty) return completionFilesCache;
  const index = completionFilesCache.findIndex((file) => file.path === documentSession.path);
  const active = index >= 0
    ? { ...completionFilesCache[index], content: documentSession.buffer, bufferVersion: documentSession.bufferVersion }
    : { path: documentSession.path, content: documentSession.buffer, bufferVersion: documentSession.bufferVersion };
  if (index < 0) return [...completionFilesCache, active];
  const files = completionFilesCache.slice();
  files[index] = active;
  return files;
}

if (nativeBroker.available) {
  for (const [selector, label] of [
    ['#import-workspace', 'Android 工作区目录导入将在后续 SAF 版本开放'],
    ['#export-workspace', 'Android 工作区导出将在后续 SAF 版本开放']
  ]) {
    const button = $(selector);
    button.disabled = true;
    button.title = label;
  }
}
const unsubscribeNativeStatus = nativeBroker.subscribeStatus((event) => {
  if (['disconnected', 'reconnecting', 'binding-died', 'null-binding', 'service-crashed', 'service-disconnected'].includes(event.type)) {
    if(!event.channel || event.channel==='dsh'){inlineController?.invalidate('disconnected');inlineClient.setCapabilities(null);}
    const services=event.channel ? [event.channel==='test'?'runtime':event.channel].filter(service=>['runtime','dsh','language'].includes(service)) : ['runtime','dsh','language'];
    for (const service of services) markStartup(service, event.type === 'reconnecting' ? 'retrying' : 'error', event.error?.message || '连接中断，等待服务恢复');
  }
  if ((!event.channel || event.channel==='dsh') && ['disconnected', 'reconnecting', 'binding-died', 'null-binding', 'service-crashed', 'service-disconnected'].includes(event.type)) {
    officialDsh.disconnected();
    officialDshCatalog = officialDsh.value.catalog;
    renderOfficialSelectors();
  }
  if (['connected', 'reconnected'].includes(event.type) && ui.initialized) {
    runtime.refreshCapabilities({ timeoutMs: 120_000 });
    tests.refreshCapabilities({ timeoutMs: 120_000 });
    refreshRuntimePackCapabilities({ quiet: true });
    refreshPythonPackageCapabilities({ quiet: true, validateInstall: true });
    scheduleOfficialDshRefresh();
    verifyLanguageReady().catch(() => {});
  }
});
if (!nativeBroker.available) {
  markStartup('dsh', 'unavailable', '浏览器预览：官方 dsh 不可用');
  markStartup('language', 'unavailable', '浏览器预览：仅基础提示，不支持语义重构');
  markStartup('runtime', 'unavailable', '浏览器预览：原生 Runtime 不可用');
}
const unsubscribeStartupEvents = nativeBroker.subscribe('*', (event, envelope) => {
  const service = envelope.channel;
  if (!['dsh', 'runtime', 'language'].includes(service)) return;
  if (['service-crashed', 'service-disconnected', 'runtime-stopped'].includes(event.type)) {
    if(!serviceFailureCycles.has(service)){diagnostics.record(service + 'Restarts',1);serviceFailureCycles.add(service);}
    markStartup(service, 'error', event.message || '服务已停止，可以重试');
  }
  if (service !== 'dsh') return;
  if (Number.isSafeInteger(event.generation) && event.generation !== inlineServiceGeneration) { inlineController?.invalidate('generation'); inlineServiceGeneration=event.generation; }
  if (['runtime-stopped','runtime-error','runtime-failed','service-crashed','service-disconnected'].includes(event.type)) {
    inlineController?.invalidate('runtime-stopped');inlineClient.setCapabilities(null);
    officialDsh.disconnected();officialDshCatalog=officialDsh.value.catalog;renderOfficialSelectors();
  }
  if (['service-connected','service-reconnected'].includes(event.type) && ui.initialized) scheduleOfficialDshRefresh();
  const phaseLabels = { 'runtime-preparing': '正在准备官方 dsh', 'runtime-extracting': '正在解压官方 dsh', 'runtime-verifying': '正在校验官方 dsh', 'runtime-validating': '正在验证运行包', 'runtime-repairing': '正在修复运行包', 'runtime-starting': '正在启动官方 dsh', 'runtime-started': '正在启动官方 dsh', 'runtime-ready': '正在读取模型目录' };
  const phase = event.type === 'runtime-progress' ? 'runtime-' + (event.phase || event.state) : event.type;
  if (phaseLabels[phase]) {
    const percent = Number(event.total) > 0 ? ` · ${Math.min(100, Math.round(Number(event.completed || 0) / Number(event.total) * 100))}%` : '';
    markStartup('dsh', 'pending', phaseLabels[phase] + percent);
  } else if (['runtime-error', 'runtime-failed', 'runtime-stopped'].includes(phase)) {
    markStartup('dsh', 'error', event.message || event.detail || '官方 dsh 准备失败');
  }
});
language.subscribe(event => {
  if (event.providerId !== 'bridge') return;
  if (event.type === 'request-partial') markStartup('language', 'ready', 'Jedi/Parso 语义响应已验证');
  if (event.type === 'provider-error' && !['content-modified', 'cancelled'].includes(event.error?.code)) markStartup('language', 'error', event.error);
});
const dsh = new DshAgentController({
  store,
  document: documentSession,
  gateway: dshGateway,
  projectIndex,
  contextIndexer,
  runtime: { runConfiguration: (configurationId) => runCurrent(configurationId, { approvedByUser: true }) }
});
officialDsh.subscribe((next) => {
  officialDshCatalog = next.catalog;
  renderOfficialSelectors();
});
const editorCoordinator = new EditorCoordinator({
  parent: $('#code-editor'),
  settings: { ...ui.settings, theme: ui.theme },
  languageService: language,
  getDocument: () => documentSession.snapshot(),
  getWorkspaceFiles: getCompletionFiles,
  onChange: (content, metadata) => documentSession.editPath(metadata?.path || documentSession.path, content, {
    source: 'editor',
    skipHistory: true,
    composing: Boolean(metadata?.composing),
    changes: metadata?.changes || null
  }),
  onCompositionEnd: () => flushLanguageQueue(true),
  onInlineDismiss: () => inlineController?.reject(),
  onInputFrame: () => {
    if(inputFramePending)return;
    inputFramePending=true;diagnostics.start('inputFrameMs');diagnostics.start('localCompletionMs');
    requestAnimationFrame(()=>{inputFramePending=false;diagnostics.finish('inputFrameMs');});
  },
  getInlineIdentity: () => ({ uri:toDocumentUri(documentSession.path || ''), epoch:language.document(toDocumentUri(documentSession.path || ''))?.epoch || 0, modelSelectionVersion:inlineModelVersion, generation:inlineServiceGeneration }),
  onInlineState: state => {
    if(state?.visible && state.source==='local')diagnostics.finish('localCompletionMs');
    if(!state?.visible && ['blur','restore','preview','dismiss','stale','open'].includes(state?.reason))diagnostics.cancel('localCompletionMs');
    $('#inline-accept').disabled = !state?.visible;
    $('#inline-reject').disabled = !state?.visible;
    $('#inline-status').textContent = state?.visible ? (state.source === 'ai' ? 'AI 建议 · Tab 接受' : '本地建议 · Tab 接受') : '';
  },
  onCursor: ({ line, column, offset }) => {
    inlineController?.invalidate('cursor');
    inlineController?.schedule();
    $('#status-cursor').textContent = 'Ln ' + line + ', Col ' + column;
    if (documentSession.path && !documentSession.preview) {
      documentSession.setViewState(documentSession.path, { cursor:offset, scroll:editorCoordinator.adapter.capture().scroll || {top:0,left:0} });
      ui.cursorPositions[documentSession.path] = offset;
      clearTimeout(cursorPersistTimer);
      cursorPersistTimer = setTimeout(persistUi, 300);
    }
  },
  onHistory: ({ canUndo, canRedo }) => {
    $('#undo-button').disabled = !canUndo;
    $('#redo-button').disabled = !canRedo;
  },
  onSave: () => saveCurrent(),
  onRun: () => runCurrent(),
  onHover: (offset) => requestHover(offset),
  onSignatureHelp: (offset) => requestSignatureHelp(offset),
  onDefinition: (offset) => goToDefinition(offset),
  onReferences: (offset) => findReferences(offset),
  onRename: (offset) => renameSymbol(offset)
});
const mergeDiffView = new MergeDiffView($('#diff-content'), { theme: ui.theme });
inlineController = new InlineCompletionController({ client:inlineClient, enabled:ui.settings.inlineEnabled !== false,
  getSnapshot: () => ({ ...editorCoordinator.adapter.inlineSnapshot(), codeUpload:ui.settings.codeUpload !== false }),
  isEligible: snapshot => snapshot.eligible && !ui.dshBusy && !dialogs.open && !$('#settings-dialog').open && !documentSession.conflict,
  getSelection: () => {
    const selected=ui.settings.inlineModel ? selectorModelParts(ui.settings.inlineModel) : officialDshCatalog.selected || {};
    const pair=findOfficialModel(officialDshCatalog,selected.providerId,selected.model);
    return { provider:selected.providerId, model:selected.model, profileId:pair.provider?.official ? '' : selected.providerId,
      officialMode:pair.provider?.official !== false, modelSelectionVersion:inlineModelVersion, generation:inlineServiceGeneration };
  },
  onSuggestion: value => {
    if (value) editorCoordinator.adapter.setInlineSuggestion({text:value.text,token:value.snapshot,source:'ai'});
    else if(editorCoordinator.adapter.inlineState().source==='ai')editorCoordinator.adapter.clearInlineSuggestion();
  },
  onState: state => {
    if(state.status==='requesting')diagnostics.start('inlineCompletionMs');
    if(['ready','cooldown','paused'].includes(state.status))diagnostics.finish('inlineCompletionMs');
    if(state.status==='idle' && state.reason)diagnostics.cancel('inlineCompletionMs');
    if (editorCoordinator.adapter.inlineState().visible) return;
    const labels={requesting:'AI 补全中…',paused:'AI 鉴权暂停',cooldown:'AI 稍后重试',disabled:'AI 已关闭',ready:'AI 建议'};
    $('#inline-status').textContent=labels[state.status] || '';
    $('#inline-status').title=state.code || '';
  }
});
editorCoordinator.adapter.view.contentDOM.addEventListener('focus',()=>inlineController.schedule());
editorCoordinator.adapter.view.contentDOM.addEventListener('blur',()=>inlineController.invalidate('blur'));
editorCoordinator.adapter.view.contentDOM.addEventListener('compositionstart',()=>inlineController.invalidate('composition'));
editorCoordinator.adapter.view.contentDOM.addEventListener('compositionend',()=>queueMicrotask(()=>inlineController.schedule()));

let languageSync = Promise.resolve();
let languagePendingJob = null;
let languageWorkerRunning = false;
let languageActivePath = null;
let diagnosticTimer = null;
let languageDiagnostics = [];
let searchSequence = 0;
let indexTimer = null;
let workspaceRenderFrame = null;
let searchTimer = null;
let runAdmissionPending = false;

function scheduleWorkspaceRender() {
  if (workspaceRenderFrame != null) return;
  workspaceRenderFrame = requestAnimationFrame(() => {
    workspaceRenderFrame = null;
    renderTree(); renderSearch(); renderProblems(); renderRunConfigurations();
  });
}

async function verifyLanguageReady() {
  if (!nativeBroker.available) return;
  await store.ready;
  await languageSync;
  const path = isPythonPath(documentSession.path) ? documentSession.path : store.listFiles().find(file => file.editable !== false && isPythonPath(file.path))?.path;
  if (!path) { markStartup('language', 'idle', '打开 Python 文件后验证语义服务'); return; }
  const uri = toDocumentUri(path);
  if (!language.document(uri)) {
    const record = await store.readAsync(path);
    await language.openDocument({ uri, path, text: record.content, bufferVersion: 0 });
  }
  const current = language.document(uri);
  try { await language.documentSymbols({ uri, epoch: current.epoch, version: current.version }); }
  catch (error) { markStartup('language', 'error', error); }
}

async function measureProjectIndex() {
  diagnostics.start('projectIndexMs');
  try { return await projectIndex.index(); }
  finally { diagnostics.finish('projectIndexMs'); }
}

function renderIndexStatus() {
  const status = projectIndex.status();
  const label = $('#index-status');
  label.textContent = `Index · ${status.state}`;
  label.className = `index-chip is-${status.state}`;
  label.title = status.error || `${status.fileCount} files · generation ${status.generation}`;
}

function scheduleProjectIndex(delay = 120) {
  projectIndex.markStale();
  renderIndexStatus();
  clearTimeout(indexTimer);
  indexTimer = setTimeout(async () => {
    renderIndexStatus();
    try { await measureProjectIndex(); }
    catch (error) { appendTerminal('Project index failed: ' + error.message, 'error'); }
    renderIndexStatus();
    if ($('#search-input').value.trim()) renderSearch();
  }, delay);
}

function persistUi() {
  const durable = {
    theme: ui.theme,
    mode: ui.mode,
    projectOpen: ui.projectOpen,
    dshOpen: ui.dshOpen,
    terminalOpen: ui.terminalOpen,
    terminalHeight: ui.terminalHeight,
    terminalMaximized: ui.terminalMaximized,
    codeTools: ui.codeTools,
    conversationId: ui.conversationId,
    projectWidth: ui.projectWidth,
    dshWidth: ui.dshWidth,
    leftTool: ui.leftTool,
    dshTab: ui.dshTab,
    terminalTab: ui.terminalTab,
    openTabs: ui.openTabs,
    activePath: ui.activePath,
    folderOpen: ui.folderOpen,
    cursorPositions: normalizeCursorPositions(ui.cursorPositions, ui.openTabs),
    settings: ui.settings
  };
  try {
    globalThis.localStorage?.setItem(UI_STORAGE_KEY, JSON.stringify(durable));
  } catch (error) {
    // Keep the session usable when storage is unavailable or quota-limited.
  }
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2400);
}

function escapeText(value) {
  return String(value ?? '');
}

function fileName(path) {
  return String(path || '').split('/').pop() || '';
}

function pathFromUri(uri) {
  const prefix = 'pythona://workspace/';
  if (!String(uri || '').startsWith(prefix)) return null;
  return String(uri).slice(prefix.length).split('/').map((part) => decodeURIComponent(part)).join('/');
}

async function synchronizeLanguageJob(job) {
  const { kind, captured, capturedChanges } = job;
  const pythonPath = isPythonPath(captured.path) ? captured.path : null;
  if (languageActivePath && languageActivePath !== pythonPath && !ui.openTabs.includes(languageActivePath)) {
    const closedPath = languageActivePath;
    await language.closeDocument(closedPath);
    languageActivePath = null;
    languageDiagnostics = withoutDiagnosticsForPath(languageDiagnostics, closedPath);
    renderProblems();
  }
  if (!pythonPath) return;
  const uri = toDocumentUri(pythonPath);
  let current = language.document(uri);
  if (!current) {
    await language.openDocument({
      uri,
      path: pythonPath,
      text: captured.buffer,
      bufferVersion: captured.bufferVersion
    });
    languageActivePath = pythonPath;
    current = language.document(uri);
  } else if (current.version !== captured.bufferVersion || current.text !== captured.buffer) {
    const canApplyIncrementally = capturedChanges?.length
      && captured.bufferVersion === current.version + 1;
    const change = {
      uri,
      epoch: current.epoch,
      bufferVersion: captured.bufferVersion
    };
    if (canApplyIncrementally) change.changes = capturedChanges;
    else change.text = captured.buffer;
    await language.changeDocument(change);
    current = language.document(uri);
  }
  if (kind === 'saved' && current) {
    await language.saveDocument({
      uri,
      epoch: current.epoch,
      version: current.version,
      revision: captured.revision,
      text: captured.buffer
    });
  }
  scheduleLanguageDiagnostics(captured);
}

function flushLanguageQueue(releaseDeferred = false) {
  if (releaseDeferred && languagePendingJob) languagePendingJob.deferred = false;
  if (languageWorkerRunning || !languagePendingJob || languagePendingJob.deferred) return languageSync;
  languageWorkerRunning = true;
  languageSync = (async () => {
    while (languagePendingJob && !languagePendingJob.deferred) {
      const job = languagePendingJob;
      languagePendingJob = null;
      try {
        await synchronizeLanguageJob(job);
      } catch (error) {
        appendTerminal('Language service: ' + error.message, 'error');
      }
    }
  })().finally(() => {
    languageWorkerRunning = false;
    if (languagePendingJob && !languagePendingJob.deferred) queueMicrotask(flushLanguageQueue);
  });
  return languageSync;
}

function queueLanguageDocument(kind, snapshot = documentSession.snapshot(), changes = null, options = {}) {
  const captured = { ...snapshot };
  const capturedChanges = Array.isArray(changes)
    ? changes.map((change) => ({
      ...change,
      range: change.range ? {
        start: { ...change.range.start },
        end: { ...change.range.end }
      } : undefined
    }))
    : null;
  // Keep at most one in-flight synchronization and one latest snapshot. A
  // slow first-launch Jedi extraction must not turn fast typing (especially
  // IME composition frames) into an unbounded chain of stale didChange calls.
  languagePendingJob = {
    kind,
    captured,
    capturedChanges: languagePendingJob ? null : capturedChanges,
    deferred: Boolean(options.defer)
  };
  return options.defer ? languageSync : flushLanguageQueue();
}

function scheduleLanguageDiagnostics(snapshot = documentSession.snapshot()) {
  clearTimeout(diagnosticTimer);
  if (!isPythonPath(snapshot.path)) return;
  const token = { path: snapshot.path, bufferVersion: snapshot.bufferVersion };
  diagnosticTimer = setTimeout(async () => {
    await languageSync;
    const currentSnapshot = documentSession.snapshot();
    if (currentSnapshot.path !== token.path || currentSnapshot.bufferVersion !== token.bufferVersion) return;
    const uri = toDocumentUri(token.path);
    const current = language.document(uri);
    if (!current || current.version !== token.bufferVersion) return;
    try {
      const response = await language.diagnose({ uri, epoch: current.epoch, version: current.version });
      if (!response) return;
      languageDiagnostics = (response.diagnostics || []).map((diagnostic) => ({
        path: token.path,
        line: Number(diagnostic.range?.start?.line || 0) + 1,
        tool: 'Python 语法诊断',
        text: diagnostic.message || String(diagnostic)
      }));
      renderProblems();
    } catch (error) {
      // Local completion remains usable when Jedi/Parso is restarting.
    }
  }, 220);
}

async function requestHover(offset) {
  await languageSync;
  const snapshot = documentSession.snapshot();
  if (!isPythonPath(snapshot.path)) return null;
  const uri = toDocumentUri(snapshot.path);
  const current = language.document(uri);
  if (!current || current.version !== snapshot.bufferVersion) return null;
  const response = await language.hover({
    uri,
    epoch: current.epoch,
    version: current.version,
    position: offsetToPosition(snapshot.buffer, offset)
  });
  return response?.result || null;
}

async function requestSignatureHelp(offset) {
  await languageSync;
  const snapshot = documentSession.snapshot();
  if (!isPythonPath(snapshot.path)) return;
  const uri = toDocumentUri(snapshot.path);
  const current = language.document(uri);
  if (!current || current.version !== snapshot.bufferVersion) return;
  const response = await language.signatureHelp({
    uri,
    epoch: current.epoch,
    version: current.version,
    position: offsetToPosition(snapshot.buffer, offset)
  });
  const signature = response?.result?.signatures?.[response.result.activeSignature || 0];
  if (signature?.label) showToast(signature.label);
}

async function goToDefinition(offset) {
  await languageSync;
  const snapshot = documentSession.snapshot();
  if (!isPythonPath(snapshot.path)) return;
  const uri = toDocumentUri(snapshot.path);
  const current = language.document(uri);
  const position = offsetToPosition(snapshot.buffer, offset);
  const response = current && current.version === snapshot.bufferVersion
    ? await language.definition({ uri, epoch: current.epoch, version: current.version, position })
    : null;
  let location = Array.isArray(response?.result) ? response.result[0] : response?.result;
  if (!location) {
    try { location = await projectIndex.definition(uri, position); }
    catch (error) { /* keep local editing available while indexing */ }
  }
  const path = pathFromUri(location?.uri || location?.targetUri);
  const targetPosition = location?.range?.start || location?.targetSelectionRange?.start;
  if (!path || !targetPosition || !store.has(path)) {
    showToast('未找到定义');
    return;
  }
  await openFile(path);
  editorCoordinator.goTo(positionToOffset(documentSession.buffer, targetPosition));
}

async function findReferences(offset) {
  await languageSync;
  const snapshot = documentSession.snapshot();
  if (!isPythonPath(snapshot.path)) return;
  const uri = toDocumentUri(snapshot.path);
  const current = language.document(uri);
  if (!current || current.version !== snapshot.bufferVersion) return;
  try {
    const response = await language.references({
      uri, epoch: current.epoch, version: current.version,
      position: offsetToPosition(snapshot.buffer, offset)
    });
    const locations = Array.isArray(response?.result) ? response.result : [];
    if (!response) return [];
    setLeftTool('search');
    ++searchSequence; // invalidate an asynchronous text search while showing references
    const results = $('#search-results');
    results.replaceChildren();
    locations.forEach((location) => {
      const row = document.createElement('div');
      row.className = 'result-row';
      row.innerHTML = '<strong></strong><span></span>';
      const line = Number(location.range?.start?.line || 0);
      row.querySelector('strong').textContent = `${location.path || pathFromUri(location.uri) || location.uri}:${line + 1}`;
      row.querySelector('span').textContent = '引用';
      row.addEventListener('click', async () => {
        const path = location.path || pathFromUri(location.uri);
        if (!path || !store.has(path)) return;
        await openFile(path);
        editorCoordinator.goTo(positionToOffset(documentSession.buffer, location.range?.start || { line: 0, character: 0 }));
      });
      results.append(row);
    });
    if (!locations.length) results.textContent = '未找到工作区引用';
    showToast(locations.length ? `找到 ${locations.length} 个引用` : '未找到工作区引用');
    return locations;
  } catch (error) {
    showToast('引用查找失败：' + (error.message || error));
    return [];
  }
}

async function renameSymbol(offset) {
  if(!nativeBroker.available){showToast('浏览器预览不支持语义重命名');return;}
  if(documentSession.dirtyPaths().length){
    if(!(await requestUserApproval('先保存再重命名','跨文件语义重构需要一致的磁盘版本；保存未保存文件后重新计算修改。')))return;
    try{await documentSession.saveAllAsync();}catch(error){showToast('保存失败：'+error.message);return;}
  }
  await flushLanguageQueue(true);
  await languageSync;
  const snapshot = documentSession.snapshot();
  if (!isPythonPath(snapshot.path)) return;
  const uri = toDocumentUri(snapshot.path);
  const current = language.document(uri);
  if (!current || current.version !== snapshot.bufferVersion) return;
  const oldWord = (snapshot.buffer.slice(0, offset).match(/[\p{ID_Start}_][\p{ID_Continue}_]*$/u)?.[0] || '')
    + (snapshot.buffer.slice(offset).match(/^[\p{ID_Continue}_]*/u)?.[0] || '');
  const requested = await dialogs.text('重命名 Python 标识符', oldWord, { validate: value => value ? '' : '请输入新名称' });
  if (requested == null || !requested.trim()) return;
  const newName = requested.trim();
  try {
    const base = captureRenameBase(store, documentSession.snapshot());
    const response = await language.rename({
      uri, epoch: current.epoch, version: current.version,
      position: offsetToPosition(snapshot.buffer, offset), newName
    });
    if (!response) throw new Error('重命名请求已过期');
    const transaction = createRenameTransaction(response.result, base);
    const files = transaction.files;
    documentSession.assertClean(files.map(file => file.path));
    validateRenameBase(store, documentSession.snapshot(), base, transaction);
    renderMultiFileDiff(transaction.files, `Rename ${oldWord} → ${newName}`);
    const approved = await requestUserApproval('确认重命名', `${oldWord} → ${newName} · ${files.length} 个文件将原子修改`);
    if (!approved) { renderDiff(null); return null; }
    await store.flush();
    documentSession.assertClean(files.map(file => file.path));
    validateRenameBase(store, documentSession.snapshot(), base, transaction);
    await store.applyBatchAsync(transaction, { source: 'rename' });
    renderDiff(null);
    showToast(`已重命名 ${files.length} 个文件`);
    return transaction;
  } catch (error) {
    renderDiff(null);
    showToast('重命名失败：' + (error.message || error));
    return null;
  }
}

function extensionIcon(path) {
  if (isPythonPath(path)) return '⌘';
  if (path.endsWith('.md')) return '¶';
  if (path.endsWith('.toml')) return '⚙';
  return '·';
}

function buildTree(files) {
  const root = { name: '', path: '', folders: new Map(), files: [] };
  files.forEach((file) => {
    const parts = file.path.split('/');
    const name = parts.pop();
    let node = root;
    parts.forEach((part) => {
      const path = node.path ? node.path + '/' + part : part;
      if (!node.folders.has(part)) node.folders.set(part, { name: part, path, folders: new Map(), files: [] });
      node = node.folders.get(part);
    });
    node.files.push({ ...file, name });
  });
  return root;
}

function renderTree() {
  const container = $('#project-tree');
  const focusedPath = container.contains(document.activeElement) ? document.activeElement?.dataset.path : null;
  const tree = buildTree(store.listFiles());
  container.replaceChildren();
  const renderFolder = (node, depth) => {
    if (node.path) {
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.style.paddingLeft = `${6 + Math.max(0,depth) * 16}px`;
      wireTreeRow(row, node.path, true, depth);
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-expanded', String(ui.folderOpen[node.path] !== false));
      row.innerHTML = '<span class="tree-chevron">⌄</span><span class="tree-icon">' + icon('folder') + '</span><span class="tree-label"></span>';
      row.querySelector('.tree-label').textContent = node.name;
      row.addEventListener('click', (event) => {
        if (row.__longPressed) { row.__longPressed = false; event.preventDefault(); return; }
        ui.selectedTreePath = node.path;
        ui.folderOpen[node.path] = !(ui.folderOpen[node.path] !== false);
        persistUi();
        renderTree();
      });
      container.append(row);
      if (ui.folderOpen[node.path] === false) return;
    }
    [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).forEach((folder) => renderFolder(folder, depth + 1));
    node.files.sort((a, b) => a.name.localeCompare(b.name)).forEach((file) => {
      const row = document.createElement('div');
      row.className = 'tree-row' + (file.path === ui.activePath ? ' is-selected' : '');
      row.style.paddingLeft = `${6 + Math.max(0,depth + 1) * 16}px`;
      wireTreeRow(row, file.path, false, depth + 1);
      row.setAttribute('role', 'treeitem');
      row.innerHTML = '<span class="tree-chevron"></span><span class="tree-icon"></span><span class="tree-label"></span><span class="tree-badge"></span>';
      row.querySelector('.tree-icon').innerHTML = icon('file');
      row.querySelector('.tree-label').textContent = file.name;
      row.querySelector('.tree-badge').textContent = file.editable === false
        ? 'BIN'
        : (store.isModified(file.path) ? 'M' : '');
      if (file.editable === false) {
        row.title = `${file.size || 0} bytes · 二进制/大文件不载入编辑器`;
      }
      row.setAttribute('aria-selected', String(file.path === ui.activePath));
      row.addEventListener('click', event => {
        if (row.__longPressed) { row.__longPressed = false; event.preventDefault(); return; }
        ui.selectedTreePath = file.path; openFile(file.path);
      });
      container.append(row);
    });
  };
  renderFolder(tree, -1);
  const rows = [...container.querySelectorAll('.tree-row')];
  const focused = rows.find(row => row.dataset.path === focusedPath);
  if (focused) focused.focus({ preventScroll:true });
  if (!rows.some(row => row.tabIndex === 0) && rows[0]) rows[0].tabIndex = 0;
}

function wireTreeRow(row, path, folder, depth) {
  row.dataset.path = path; row.dataset.folder = String(folder); row.tabIndex = path === (ui.selectedTreePath || ui.activePath) ? 0 : -1;
  row.setAttribute('aria-level', String(Math.max(1,depth + 1)));
  row.addEventListener('contextmenu', event => { event.preventDefault(); openFileMenu(path); });
  let timer, origin;
  const cancel = () => { clearTimeout(timer); timer = null; };
  row.addEventListener('pointerdown', event => { if (event.pointerType === 'mouse') return; origin={x:event.clientX,y:event.clientY}; timer=setTimeout(()=>{row.__longPressed=true;openFileMenu(path);},500); });
  row.addEventListener('pointermove',event=>{if(origin && Math.hypot(event.clientX-origin.x,event.clientY-origin.y)>8)cancel();});
  row.addEventListener('pointerup',cancel); row.addEventListener('pointercancel',cancel);
  row.addEventListener('keydown',event=>{
    const rows=[...$('#project-tree').querySelectorAll('.tree-row')], index=rows.indexOf(row);
    if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
      event.preventDefault(); const next=event.key==='Home'?rows[0]:event.key==='End'?rows.at(-1):rows[Math.max(0,Math.min(rows.length-1,index+(event.key==='ArrowDown'?1:-1)))];
      rows.forEach(item=>item.tabIndex=item===next?0:-1); ui.selectedTreePath=next.dataset.path;next.focus();next.scrollIntoView({block:'nearest'});
    } else if (event.key==='Enter'||event.key===' ') {event.preventDefault();row.click();}
    else if (event.key==='F2'&&!folder) {event.preventDefault();ui.selectedTreePath=path;$('#rename-file-button').click();}
    else if ((event.key==='ArrowRight'&&folder&&ui.folderOpen[path]===false)||(event.key==='ArrowLeft'&&folder&&ui.folderOpen[path]!==false)) {event.preventDefault();row.click();}
    else if (event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')) {event.preventDefault();openFileMenu(path);}
  });
}

function openFileMenu(path = ui.selectedTreePath || documentSession.path) {
  ui.selectedTreePath = path;
  $('#project-action-path').textContent = path || '工作区';
  $('#project-action-menu').hidden = false;
  renderFileOperations();
}

function renderTabs() {
  const container = $('#editor-tabs');
  container.replaceChildren();
  ui.openTabs.forEach((path) => {
    const tab = document.createElement('div');
    tab.className = 'editor-tab' + (path === ui.activePath ? ' is-active' : '');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(path === ui.activePath));
    const button = document.createElement('button');
    button.className = 'editor-tab-main';
    const snapshot = documentSession.snapshotFor(path);
    const dirty = Boolean(snapshot?.dirty);
    button.innerHTML = '<span class="tab-icon"></span><span class="tab-name"></span><span class="dirty-mark"></span>';
    button.querySelector('.tab-icon').innerHTML = icon('file');
    button.querySelector('.tab-name').textContent = fileName(path);
    button.querySelector('.dirty-mark').textContent = snapshot?.conflict || snapshot?.saveError ? '!' : snapshot?.saving ? '…' : dirty ? '●' : '';
    button.title = `${path}${snapshot?.conflict ? ' · 外部冲突' : snapshot?.saveError ? ' · 保存失败' : snapshot?.saving ? ' · 保存中' : dirty ? ' · 未保存' : ' · 已保存'}`;
    button.addEventListener('click', () => openFile(path));
    button.addEventListener('auxclick', (event) => { if (event.button === 1) closeTab(path); });
    tab.append(button);
    {
      const close = document.createElement('button');
      close.className = 'tab-close';
      close.type = 'button';
      close.textContent = '×';
      close.setAttribute('aria-label', `关闭 ${fileName(path)}`);
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        closeTab(path);
      });
      tab.append(close);
    }
    container.append(tab);
  });
  editorCoordinator.retain(ui.openTabs);
}

async function closeTab(path) {
  const snapshot = documentSession.snapshotFor(path);
  if (snapshot?.saving) { showToast('文件正在保存，请稍后关闭'); return; }
  let discard = false;
  if (snapshot?.dirty || snapshot?.conflict) {
    clearTimeout(ui.autosaveTimer);
    const action = await chooseDirtyTabAction(path);
    if (action === 'cancel') { scheduleAutosave(); return; }
    if (action === 'save') { try { await documentSession.savePathAsync(path); } catch (error) { showToast(error.message); return; } }
    discard = action === 'discard';
  }
  const index = ui.openTabs.indexOf(path);
  if (!documentSession.close(path, { discard })) { showToast('文件仍有修改或正在保存，请稍后关闭'); return; }
  ui.openTabs = ui.openTabs.filter((item) => item !== path);
  language.closeDocument(path).catch(() => {});
  editorCoordinator.close(path);
  if (ui.activePath === path && ui.openTabs.length) await openFile(ui.openTabs[Math.max(0, index - 1)]);
  else if (!ui.openTabs.length) { ui.activePath = null; renderAll(); }
  else renderTabs();
  persistUi();
}

function chooseDirtyTabAction(path) {
  const dialog = $('#dirty-tab-dialog');
  if (dialog.open) return Promise.resolve('cancel');
  $('#dirty-tab-name').textContent = fileName(path) + ' 有未保存的修改';
  dialog.returnValue = 'cancel';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue || 'cancel'), { once: true }));
}

async function openFile(path) {
  await store.ready;
  if (!store.has(path) && !documentSession.snapshotFor(path)?.dirty) return;
  const target = store.has(path) ? store.read(path) : {editable:true};
  if (target.editable === false) {
    showToast(`${fileName(path)} 是二进制或大文件，只保留在工作区中`);
    return;
  }
  if (documentSession.path && documentSession.path !== path) { await flushLanguageQueue(true); await documentSession.flushDrafts(); }
  const restoreOffset = ui.cursorPositions[path];
  const switching = documentSession.path !== path;
  if (!ui.openTabs.includes(path)) ui.openTabs.push(path);
  ui.activePath = path;
  await documentSession.openAsync(path);
  if (documentSession.path !== path) return;
  ui.activePath = path;
  $('#dsh-file-label').textContent = '· ' + fileName(path);
  persistUi();
  renderAll();
  if (switching && Number.isSafeInteger(restoreOffset)) editorCoordinator.goTo(Math.min(restoreOffset, documentSession.buffer.length));
}

async function reconcileWorkspaceSession() {
  ui.workspaceReconcileQueued = false;
  const current = documentSession.path;
  ui.openTabs = ui.openTabs.filter((path) => store.has(path) || path === current || documentSession.snapshotFor(path)?.dirty || documentSession.snapshotFor(path)?.conflict);
  if (current) {
    ui.activePath = current;
    if (!ui.openTabs.includes(current)) ui.openTabs.unshift(current);
    persistUi();
    renderAll();
    return;
  }
  const fallback = store.listFiles().find((file) => file.editable !== false)?.path || null;
  ui.activePath = fallback;
  if (fallback) {
    if (!ui.openTabs.includes(fallback)) ui.openTabs.unshift(fallback);
    await documentSession.openAsync(fallback);
    $('#dsh-file-label').textContent = '· ' + fileName(fallback);
  } else {
    ui.openTabs = [];
    $('#dsh-file-label').textContent = '· No file';
  }
  persistUi();
  renderAll();
}

function scheduleWorkspaceReconcile() {
  if (ui.workspaceReconcileQueued) return;
  ui.workspaceReconcileQueued = true;
  queueMicrotask(reconcileWorkspaceSession);
}

function renderEditor() {
  const snapshot = documentSession.snapshot();
  editorCoordinator.present(snapshot, { ...ui.settings, theme: ui.theme });
  mergeDiffView.configure({ theme: ui.theme });
  $('#breadcrumbs').textContent = store.workspaceName + '  ›  ' + (snapshot.path || 'No file');
  const state = $('#editor-state');
  state.textContent = !snapshot.path ? (ui.initialized?'打开文件开始编辑':'正在载入文件…') : snapshot.conflict ? '冲突' : snapshot.saveError ? '保存失败' : snapshot.saving ? '保存中…' : snapshot.preview ? 'DSH 预览' : snapshot.dirty ? '未保存' : '已保存';
  const notice=snapshot.saveError ? '保存失败：'+(snapshot.saveError.message || snapshot.saveError) : ui.draftWarning ? '草稿保存/恢复失败：'+ui.draftWarning : '';
  $('#editor-notice').hidden=!notice;$('#editor-notice-text').textContent=notice;
  state.classList.toggle('is-dirty', snapshot.dirty || Boolean(snapshot.conflict));
  $('#save-button').disabled = snapshot.saving || !snapshot.dirty || Boolean(snapshot.preview);
  $('#live-preview').hidden = !snapshot.preview;
  if (snapshot.preview) $('#live-preview-label').textContent = 'DSH 正在预览 hunk ' + (snapshot.preview.hunk || 1) + '/' + (snapshot.preview.total || 1);
  const conflictBanner = $('#conflict-banner');
  conflictBanner.hidden = !snapshot.conflict;
  if (snapshot.conflict) {
    conflictBanner.querySelector('strong').textContent = snapshot.conflict.deleted ? '文件已在外部删除' : '文件在外部发生修改';
    conflictBanner.querySelector('span').textContent = snapshot.conflict.deleted
      ? '保留本地内容将重建文件；接受远端将关闭当前文档'
      : '保留本地内容或接受远端版本';
  }
  renderTabs();
}

function renderDiff(patch = ui.diffPatch) {
  $('#diff-content').classList.remove('is-multi-file');
  ui.diffPatch = patch;
  const panel = $('#diff-panel');
  if (!patch) {
    panel.hidden = true;
    mergeDiffView.destroy();
    return;
  }
  panel.hidden = false;
  $('#diff-title').textContent = patch.path + ' · +' + patch.additions + ' −' + patch.removals;
  mergeDiffView.show(patch);
}

function renderMultiFileDiff(files = [], title = 'Rename Diff') {
  const panel = $('#diff-panel');
  const content = $('#diff-content');
  content.classList.add('is-multi-file');
  ui.diffPatch = null;
  panel.hidden = false;
  $('#diff-title').textContent = `${title} · ${files.length} 个文件`;
  mergeDiffView.destroy();
  content.replaceChildren();
  files.forEach((file) => {
    const section = document.createElement('section');
    section.className = 'multi-file-diff';
    const heading = document.createElement('strong');
    heading.textContent = `${file.path} · +${file.additions} −${file.removals}`;
    const body = document.createElement('pre');
    body.textContent = file.patch.operations.map((operation) => {
      const prefix = operation.type === 'add' ? '+' : operation.type === 'remove' ? '-' : ' ';
      return prefix + ' ' + operation.line;
    }).join('\n');
    section.append(heading, body);
    content.append(section);
  });
}

async function renderSearch() {
  const sequence = ++searchSequence;
  const query = $('#search-input').value.trim().toLowerCase();
  const results = $('#search-results');
  results.replaceChildren();
  if (!query) return;
  let matches = [];
  try { matches = await projectIndex.search(query, { limit: 100 }); }
  catch (error) { /* indexing may still be warming */ }
  if (sequence !== searchSequence) return;
  matches.forEach((match) => {
    const row = document.createElement('div');
    row.className = 'result-row';
    const title = document.createElement('strong');
    const line = Number(match.line ?? match.range?.start?.line);
    title.textContent = match.path + (Number.isFinite(line) ? ':' + (line + 1) : '');
    const detail = document.createElement('span');
    detail.textContent = match.kind === 'symbol'
      ? `${match.symbolKind || 'Symbol'} · ${match.qualifiedName}`
      : (match.text?.trim() || match.kind || 'file');
    row.append(title, detail);
    row.addEventListener('click', () => openFile(match.path));
    results.append(row);
  });
  if (!results.children.length) results.textContent = '没有匹配结果';
}

function analyzeProblems() {
  const problems = [...languageDiagnostics];
  // Include the active editor buffer so diagnostics update while typing instead
  // of waiting for an explicit save. Other files use the persisted workspace.
  const files = store.listFiles().map((file) => (
    file.path === documentSession.path && documentSession.dirty
      ? { ...file, content: documentSession.buffer }
      : file
  ));
  files.filter((file) => isPythonPath(file.path)).forEach((file) => {
    file.content.split('\n').forEach((line, index) => {
      if (/\bTODO\b/.test(line)) problems.push({ path: file.path, line: index + 1, tool: 'Inspection', text: '待完成的 TODO' });
      if (/\t/.test(line)) problems.push({ path: file.path, line: index + 1, tool: 'Editor style hint', text: '建议使用空格代替 Tab 缩进' });
    });
  });
  return problems;
}

function renderProblems() {
  const problems = analyzeProblems();
  $('#problem-count').textContent = String(problems.length);
  renderProblemList($('#problems-results'), problems);
  renderProblemList($('#terminal-problems'), problems);
}

function renderProblemList(container, problems) {
  if (!container) return;
  container.replaceChildren();
  problems.forEach((problem) => {
    const row = document.createElement('div');
    row.className = 'result-row';
    row.innerHTML = '<strong></strong><span></span>';
    row.querySelector('strong').textContent = problem.tool + ' · ' + problem.path + ':' + problem.line;
    row.querySelector('span').textContent = problem.text;
    row.addEventListener('click', () => openFile(problem.path));
    container.append(row);
  });
  if (!problems.length) container.textContent = '当前工作区没有诊断问题';
}

function setPythonPackageState(phase, title, detail, result = null) {
  ui.pythonPackage = {
    phase,
    title,
    detail,
    result,
    busy: ['checking', 'verifying'].includes(phase)
  };
  renderPythonPackage();
}

function renderPythonPackage() {
  const button = $('#install-python-wheel');
  const status = $('#python-package-status');
  if (!button || !status) return;
  const capabilities = pythonPackages.capabilities();
  const pickerReady = capabilities.available && capabilities.pickerAvailable;
  button.disabled = ui.pythonPackage.busy || !pickerReady;
  button.textContent = ui.pythonPackage.phase === 'verifying'
    ? '正在校验并安装…'
    : '选择纯 Python .whl…';
  button.title = pickerReady
    ? '仅接受 py3/py314-none-any 的纯 Python wheel'
    : (capabilities.available ? '当前 Android 构建未提供 SAF 选择入口' : '仅 Android 应用可用');

  const allowedPhases = new Set([
    'checking', 'ready', 'unavailable', 'verifying', 'awaiting-validation', 'activated', 'error'
  ]);
  const phase = allowedPhases.has(ui.pythonPackage.phase) ? ui.pythonPackage.phase : 'ready';
  status.className = 'pack-status is-' + phase;
  status.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'pack-status-dot';
  dot.setAttribute('aria-hidden', 'true');
  const copy = document.createElement('span');
  const title = document.createElement('strong');
  const detail = document.createElement('small');
  title.textContent = ui.pythonPackage.title;
  detail.textContent = ui.pythonPackage.detail;
  copy.append(title, detail);
  status.append(dot, copy);
}

function applyPythonPackageResult(result) {
  const status = String(result?.status || 'unknown');
  if (/cancel/i.test(status)) {
    setPythonPackageState('ready', '已取消 wheel 导入', 'Python 环境未发生变化。', result);
    return;
  }
  if (result?.accepted && status === 'installed') {
    const label = [result.name || result.normalizedName, result.version].filter(Boolean).join(' ')
      || result.wheel
      || '纯 Python wheel';
    setPythonPackageState(
      result.restartRequired ? 'awaiting-validation' : 'activated',
      result.restartRequired ? '已安装，Runtime 正在重启' : '纯 Python wheel 已安装',
      `${label} · ${result.tag || 'py3/py314-none-any'} · 不包含原生扩展`,
      result
    );
    return;
  }
  const detail = result?.reason
    || result?.detail
    || (status === 'runtime-busy'
      ? '请先停止正在运行的 Python 脚本，再安装 wheel。'
      : `状态：${status}`);
  setPythonPackageState('error', '纯 Python wheel 安装失败', detail, result);
}

async function refreshPythonPackageCapabilities({ quiet = false, validateInstall = false } = {}) {
  if (!quiet) {
    setPythonPackageState(
      'checking',
      '正在检查 wheel 安装能力',
      '仅接受 py3/py314-none-any；拒绝 sdist 与任何原生二进制。'
    );
  }
  try {
    const capabilities = await pythonPackages.refreshCapabilities();
    if (!capabilities.available) {
      setPythonPackageState(
        'unavailable',
        '纯 Python wheel 导入仅在 Android 应用内可用',
        '浏览器预览不会读取或安装本地 wheel。'
      );
    } else if (!capabilities.pickerAvailable) {
      setPythonPackageState(
        'unavailable',
        '当前 Android 构建未提供 wheel 文件选择入口',
        '原生策略存在，但必须由 Android SAF 提供 content:// URI。'
      );
    } else if (validateInstall && ui.pythonPackage.phase === 'awaiting-validation') {
      const expected = ui.pythonPackage.result;
      const listed = await pythonPackages.list({ timeoutMs: 60_000 });
      const installed = listed.packages.find((item) => {
        if (expected?.sha256 && item.sha256 === expected.sha256) return true;
        return expected?.normalizedName
          && item.normalizedName === expected.normalizedName
          && (!expected.version || item.version === expected.version);
      });
      if (installed) {
        setPythonPackageState(
          'activated',
          `${installed.name || installed.normalizedName} 已可用于新运行`,
          `${installed.version || ''} · ${installed.tag || 'none-any'} · Runtime 已重启验证`.trim(),
          installed
        );
      } else {
        setPythonPackageState(
          'error',
          'Runtime 重启后未找到刚安装的 wheel',
          '安装未被宣告成功；请重新选择文件或检查 Runtime 日志。',
          expected
        );
      }
    } else if (!quiet || ['checking', 'unavailable', 'error'].includes(ui.pythonPackage.phase)) {
      setPythonPackageState(
        'ready',
        '可导入纯 Python wheel',
        `${capabilities.pythonTags.join('/')} - ${capabilities.abiTag || 'none'} - ${capabilities.platformTag || 'any'}；安装后会重启 Runtime。`
      );
    } else {
      renderPythonPackage();
    }
    return capabilities;
  } catch (error) {
    setPythonPackageState('error', '无法读取 wheel 安装能力', error.message || String(error));
    if (!quiet) showToast('wheel 能力检查失败：' + (error.message || error));
    return pythonPackages.capabilities();
  }
}

async function installPurePythonWheel(options = {}) {
  if (ui.pythonPackage.busy) return;
  if (!options.approvedByUser) {
    const approved = await requestUserApproval(
      '确认安装 Python 包',
      '选择并安装一个经过原生校验的纯 Python wheel；安装后 Runtime 将重启。'
    );
    if (!approved) return;
  }
  setPythonPackageState(
    'verifying',
    '正在选择、校验并安装 wheel',
    '请选择 py3/py314-none-any 的 .whl；不接受 sdist 或原生扩展。'
  );
  try {
    const result = await pythonPackages.pickAndInstall({
      confirmed: true,
      skipCapabilityRefresh: true,
      timeoutMs: 5 * 60_000
    });
    applyPythonPackageResult(result);
    if (result.accepted) {
      await runtime.listPackages({ environment: 'default' }).catch(() => []);
      renderPackages();
    }
  } catch (error) {
    setPythonPackageState('error', '纯 Python wheel 安装失败', error.message || String(error));
  }
}

function setRuntimePackState(phase, title, detail, result = null) {
  ui.runtimePack = {
    phase,
    title,
    detail,
    result,
    busy: ['checking', 'verifying', 'rolling-back'].includes(phase)
  };
  renderRuntimePack();
}

function runtimePackIdentifier(result = ui.runtimePack.result) {
  const capabilities = runtimePack.capabilities();
  return result?.packId
    || capabilities.active.find((item) => item.present !== false)?.packId
    || null;
}

function renderRuntimePack() {
  const capabilities = runtimePack.capabilities();
  const pickerReady = capabilities.available && capabilities.pickerAvailable;
  const input = $('#package-input');
  const installButton = $('#install-package');
  const rollbackButton = $('#rollback-package');
  const status = $('#runtime-pack-status');
  const packId = runtimePackIdentifier();
  const rollbackBuild = ui.runtimePack.result?.previousBuildId
    || capabilities.active.find((item) => item.packId === packId)?.previousBuildId;

  if (!capabilities.available) {
    input.placeholder = '仅 PythonA Android 应用可导入签名运行包';
  } else if (!capabilities.pickerAvailable) {
    input.placeholder = '此 Android 构建尚未提供 SAF 文件选择器';
  } else {
    input.placeholder = '仅接受 PythonA Ed25519 签名 .pya-pack';
  }
  installButton.disabled = ui.runtimePack.busy || !pickerReady;
  installButton.textContent = ui.runtimePack.phase === 'verifying'
    ? '正在校验并安装…'
    : '选择签名 .pya-pack…';
  installButton.title = pickerReady
    ? '使用 Android 系统文件选择器导入运行包'
    : (capabilities.available ? '当前 Android 构建未提供 SAF 选择入口' : '仅 Android 应用可用');

  rollbackButton.hidden = !(packId && rollbackBuild);
  rollbackButton.disabled = ui.runtimePack.busy;
  rollbackButton.dataset.packId = packId || '';

  const allowedPhases = new Set(['checking', 'ready', 'unavailable', 'verifying', 'awaiting-validation', 'activated', 'error', 'rolling-back']);
  const phase = allowedPhases.has(ui.runtimePack.phase) ? ui.runtimePack.phase : 'ready';
  status.className = 'pack-status is-' + phase;
  status.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'pack-status-dot';
  dot.setAttribute('aria-hidden', 'true');
  const copy = document.createElement('span');
  const title = document.createElement('strong');
  const detail = document.createElement('small');
  title.textContent = ui.runtimePack.title;
  detail.textContent = ui.runtimePack.detail;
  copy.append(title, detail);
  status.append(dot, copy);
}

function applyRuntimePackResult(result, operation = 'install') {
  const status = String(result?.status || 'unknown');
  if (operation === 'rollback' && result?.accepted && status === 'rolled-back') {
    setRuntimePackState(
      'awaiting-validation',
      '已回滚，等待 Runtime 重启验证',
      `${result.packId || '运行包'} · build ${result.buildId || 'previous'}`,
      result
    );
    return;
  }
  if (result?.accepted && status === 'activation-pending-restart') {
    setRuntimePackState(
      'awaiting-validation',
      '等待 Runtime 重启验证',
      `${result.packId || '运行包'} ${result.buildId || ''} · 尚未宣告激活`.trim(),
      result
    );
    return;
  }
  if (result?.accepted && ['verified-staged', 'staged-not-activated', 'installed'].includes(status)) {
    const smokeReason = result.smokeTest?.reason || result.smokeTest?.detail || '等待兼容的 Runtime 验证';
    setRuntimePackState(
      'awaiting-validation',
      '签名与哈希校验通过，尚未激活',
      `${result.packId || '运行包'} 已安全暂存 · ${smokeReason}`,
      result
    );
    return;
  }
  if (/cancel/i.test(status)) {
    setRuntimePackState('ready', '已取消导入', '未修改当前 Runtime 环境。', result);
    return;
  }
  const detail = result?.detail
    || (result?.requiresUserConfirmation ? '需要在 Android 原生界面确认此安装。' : `状态：${status}`);
  setRuntimePackState('error', operation === 'rollback' ? '运行包回滚失败' : '运行包校验或安装失败', detail, result);
}

async function confirmRuntimePackActivation() {
  if (ui.runtimePack.phase !== 'awaiting-validation') return false;
  const expected = ui.runtimePack.result;
  if (!expected?.packId) return false;
  try {
    const capabilities = await runtimePack.refreshCapabilities();
    const active = capabilities.active.find((item) => item.present !== false
      && item.packId === expected.packId
      && (!expected.buildId || item.buildId === expected.buildId));
    if (!active || !runtime.capabilities().available) return false;
    setRuntimePackState(
      'activated',
      `Runtime 已验证并激活 ${active.packId}`,
      `${active.version || ''} · build ${active.buildId || 'unknown'}`.trim(),
      active
    );
    renderPackages();
    return true;
  } catch (error) {
    return false;
  }
}

async function refreshRuntimePackCapabilities({ quiet = false } = {}) {
  if (!quiet) setRuntimePackState('checking', '正在检查运行包能力', '只接受 PythonA Ed25519 签名包。');
  try {
    const capabilities = await runtimePack.refreshCapabilities();
    if (!capabilities.available) {
      setRuntimePackState(
        'unavailable',
        '签名运行包导入仅在 Android 应用内可用',
        '浏览器预览不会读取、校验或安装本地文件。'
      );
    } else if (!capabilities.pickerAvailable) {
      setRuntimePackState(
        'unavailable',
        '当前 Android 构建未提供 SAF 文件选择入口',
        '原生安装器存在，但必须由受信任的 Android 导入层提供 content:// URI。'
      );
    } else {
      const active = capabilities.active.find((item) => item.present !== false);
      setRuntimePackState(
        active ? 'activated' : 'ready',
        active ? `已激活 ${active.packId}` : '可导入签名运行包',
        active
          ? `${active.version || ''} · build ${active.buildId || 'unknown'}`.trim()
          : 'Android SAF 选择文件后将执行 Ed25519、SHA-256 与运行验证。',
        active || null
      );
    }
    renderPackages();
    return capabilities;
  } catch (error) {
    setRuntimePackState('error', '无法读取运行包能力', error.message || String(error));
    if (!quiet) showToast('运行包能力检查失败：' + (error.message || error));
    return runtimePack.capabilities();
  }
}

async function installSignedRuntimePack(options = {}) {
  if (ui.runtimePack.busy) return;
  if (!options.approvedByUser) {
    const approved = await requestUserApproval(
      '确认导入 Runtime Pack',
      '选择一个 PythonA Ed25519 签名的 .pya-pack；文件将被校验并暂存。'
    );
    if (!approved) return;
  }
  setRuntimePackState('verifying', '正在选择、校验并安装运行包', '请在 Android 系统文件选择器中选择 .pya-pack。');
  try {
    const result = await runtimePack.pickAndInstall({
      confirmed: true,
      skipCapabilityRefresh: true,
      timeoutMs: 5 * 60_000
    });
    applyRuntimePackResult(result, 'install');
    if (result.accepted) {
      if (result.requiresActivation || ['verified-staged', 'staged-not-activated'].includes(result.status)) {
        const approved = await requestUserApproval(
          '确认激活 Runtime Pack',
          `${result.packId || 'Runtime Pack'} · build ${result.buildId || 'unknown'} · 激活会重启 Runtime`
        );
        if (!approved) {
          setRuntimePackState(
            'awaiting-validation',
            '运行包已安全暂存，等待激活确认',
            `${result.packId || 'Runtime Pack'} · build ${result.buildId || 'unknown'}`,
            result
          );
          return;
        }
        const activation = await runtime.activatePack(result.packId, {
          buildId: result.buildId,
          confirmed: true
        });
        if (!activation.supported || activation.ok === false) {
          throw new Error(activation.reason || 'Runtime 不支持激活此运行包');
        }
        applyRuntimePackResult({ ...result, ...activation, accepted: true }, 'activate');
      } else {
        await runtime.refreshCapabilities({ timeoutMs: 120_000 });
      }
      await runtime.listPackages().catch(() => []);
      await runtimePack.refreshCapabilities().catch(() => runtimePack.capabilities());
      await confirmRuntimePackActivation();
      renderPackages();
    }
  } catch (error) {
    setRuntimePackState('error', '运行包导入失败', error.message || String(error));
  }
}

async function rollbackSignedRuntimePack() {
  const packId = $('#rollback-package').dataset.packId || runtimePackIdentifier();
  if (!packId || ui.runtimePack.busy) return;
  const approved = await requestUserApproval(
    '确认回滚 Runtime Pack',
    `${packId} 将切换到上一已验证版本并重启 Runtime。`
  );
  if (!approved) return;
  setRuntimePackState('rolling-back', '正在回滚运行包', `${packId} 将切换到上一已验证版本。`);
  try {
    const result = await runtimePack.rollback(packId, { confirmed: true, timeoutMs: 60_000 });
    applyRuntimePackResult(result, 'rollback');
    if (result.accepted) {
      await runtime.refreshCapabilities();
      await runtimePack.refreshCapabilities().catch(() => runtimePack.capabilities());
      renderPackages();
    }
  } catch (error) {
    setRuntimePackState('error', '运行包回滚失败', error.message || String(error));
  }
}

function renderPackages() {
  const capabilities = runtime.capabilities();
  $('#runtime-capabilities').textContent = 'Mode: ' + capabilities.mode
    + '\nPython: ' + capabilities.python
    + '\nABI: ' + capabilities.abi
    + '\nConsole: ' + capabilities.terminal
    + '\nPyTorch: ' + capabilities.pytorch;
  renderPythonPackage();
  renderRuntimePack();
  const container = $('#package-results');
  container.replaceChildren();
  runtimePack.capabilities().active.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'result-row';
    const strong = document.createElement('strong');
    const detail = document.createElement('span');
    strong.textContent = `${item.packId || 'Runtime Pack'} · ${item.version || item.buildId || 'active'}`;
    detail.textContent = item.present === false ? '活动指针无效' : `已激活 · build ${item.buildId || 'unknown'}`;
    row.append(strong, detail);
    container.append(row);
  });
  [...runtime.packageSet].forEach((item) => {
    const row = document.createElement('div');
    row.className = 'result-row';
    const strong = document.createElement('strong');
    strong.textContent = item;
    const detail = document.createElement('span');
    detail.textContent = capabilities.available
      ? (item.includes('optional') ? '需要 Android Runtime 能力检查' : '由 Runtime provider 报告')
      : '等待原生 Runtime provider';
    row.append(strong, detail);
    container.append(row);
  });
}

function parseArgumentLine(value) {
  const result = [];
  String(value || '').replace(/"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|(\S+)/g, (_, double, single, plain) => {
    result.push(String(double ?? single ?? plain ?? '').replace(/\\([\\"'])/g, '$1'));
    return '';
  });
  return result;
}

function parseEnvironment(value) {
  const result = {};
  String(value || '').split(/\r?\n/).forEach((line) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) result[match[1]] = match[2];
  });
  return result;
}

function sensitiveEnvironmentName(name) {
  return /(?:KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH)/i.test(String(name || ''));
}

function maskedEnvironmentText(environment = {}) {
  ui.runEnvironmentSecrets = {};
  return Object.entries(environment).map(([key, value]) => {
    const sensitive = sensitiveEnvironmentName(key);
    if (sensitive) ui.runEnvironmentSecrets[key] = String(value);
    return `${key}=${sensitive ? '••••••' : value}`;
  }).join('\n');
}

function loadRunConfiguration(configuration = null) {
  ui.editingRunId = configuration?.id || null;
  $('#run-name').value = configuration?.name || fileName(documentSession.path || 'Python');
  $('#run-config-type').value = configuration?.type || 'python';
  $('#run-framework').value = configuration?.framework || 'pytest';
  $('#run-node-id').value = configuration?.nodeId || '';
  $('#run-target-kind').value = configuration?.targetKind || 'file';
  $('#run-target').value = configuration?.target || documentSession.path || '';
  $('#run-args').value = (configuration?.type === 'test' ? configuration.testArgs || [] : configuration?.args || []).map((item) => /\s/.test(item) ? JSON.stringify(item) : item).join(' ');
  $('#run-working-directory').value = configuration?.workingDirectory || '/';
  $('#run-environment').value = maskedEnvironmentText(configuration?.environment || {});
  $('#run-env-files').value = (configuration?.envFiles || []).join(', ');
}

async function saveRunConfigurationForm() {
  const environment = parseEnvironment($('#run-environment').value);
  for (const [key, original] of Object.entries(ui.runEnvironmentSecrets || {})) {
    if (environment[key] === '••••••') environment[key] = original;
  }
  const value = {
    name: $('#run-name').value.trim(),
    type: $('#run-config-type').value,
    framework: $('#run-framework').value,
    targetKind: $('#run-target-kind').value,
    target: $('#run-target').value.trim(),
    paths: $('#run-config-type').value === 'test' ? [$('#run-target').value.trim()] : [],
    nodeId: $('#run-node-id').value.trim() || null,
    testArgs: $('#run-config-type').value === 'test' ? parseArgumentLine($('#run-args').value) : [],
    args: parseArgumentLine($('#run-args').value),
    workingDirectory: $('#run-working-directory').value.trim() || '/',
    interpreterId: 'bundled-cpython',
    environment,
    envFiles: $('#run-env-files').value.split(',').map((item) => item.trim()).filter(Boolean),
    beforeRun: [{ type: 'saveAll' }],
    shared: false
  };
  try {
    if (ui.editingRunId) await runConfigurations.update(ui.editingRunId, value);
    else await runConfigurations.create(value);
    ui.editingRunId = null;
    ui.runEnvironmentSecrets = {};
    renderRunConfigurations();
    showToast('Run Configuration 已保存');
  } catch (error) { showToast('保存运行配置失败：' + error.message); }
}

function renderRunConfigurations() {
  const configurations = runConfigurations.list();
  const select = $('#run-config');
  const selected = select.value || 'current-file';
  select.replaceChildren(new Option('当前文件', 'current-file'));
  configurations.forEach((configuration) => select.append(new Option(configuration.name, configuration.id)));
  select.value = configurations.some((item) => item.id === selected) ? selected : 'current-file';
  const container = $('#run-configuration-list');
  container.replaceChildren();
  configurations.forEach((configuration) => {
    const row = document.createElement('div');
    row.className = 'result-row';
    row.innerHTML = '<strong></strong><span></span><div class="change-actions"></div>';
    row.querySelector('strong').textContent = configuration.name;
    row.querySelector('span').textContent = configuration.type === 'test'
      ? `Tests · ${configuration.framework || 'pytest'} · ${configuration.target}`
      : `${configuration.targetKind} · ${configuration.target}`;
    row.addEventListener('click', () => loadRunConfiguration(configuration));
    const run = document.createElement('button');
    run.className = 'text-button';
    run.textContent = '运行';
    run.addEventListener('click', (event) => { event.stopPropagation(); runCurrent(configuration.id); });
    const remove = document.createElement('button');
    remove.className = 'text-button';
    remove.textContent = '删除';
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      await runConfigurations.remove(configuration.id);
      renderRunConfigurations();
    });
    row.querySelector('.change-actions').append(run, remove);
    container.append(row);
  });
  if (!configurations.length) container.textContent = '尚未保存配置；当前文件仍可直接运行。';
}

function renderTool() {
  const tools = serviceRegistry.list('ToolWindowProvider')
    .filter((tool) => ['project', 'search', 'problems', 'packages', 'run'].includes(tool.id));
  const toolIds = tools.map((tool) => tool.id);
  const titleMap = Object.fromEntries(tools.map((tool) => [tool.id,
    tool.id === 'search' ? 'Search everywhere'
      : tool.id === 'packages' ? 'Python environment'
        : tool.id === 'run' ? 'Run Configurations' : tool.title]));
  const effective = toolIds.includes(ui.leftTool) ? ui.leftTool : 'project';
  $('#workspace-panel-title').textContent = titleMap[effective];
  toolIds.forEach((tool) => {
    $('#' + tool + '-view').hidden = tool !== effective;
  });
  $$('.rail-button[data-tool]').forEach((button) => {
    const tool = button.dataset.tool;
    const active = tool === effective
      || (tool === 'dsh' && ui.dshOpen)
      || (tool === 'python-console' && ui.terminalOpen);
    button.classList.toggle('is-active', active);
  });
  if (effective === 'search') renderSearch();
  if (effective === 'problems') renderProblems();
  if (effective === 'packages') renderPackages();
  if (effective === 'run') renderRunConfigurations();
}

const REASONING_LABELS = { off: '关闭', low: '低', medium: '中', high: '高', max: '最高' };

function officialConnectionLabel() {
  if (officialDshCatalog.official && officialDshCatalog.connected) return '官方 dsh · 已连接';
  if (officialDsh.value.status === 'connecting') return '正在连接内置 dsh…';
  if (officialDshCatalog.connected && officialDshCatalog.providers.length) return '兼容 Provider';
  return '内置 dsh 未连接';
}

function setSelectOptions(select, options, selectedValue, { groups = false, placeholder = '' } = {}) {
  if (!select) return;
  const fragment = document.createDocumentFragment();
  if (placeholder && !options.length) fragment.append(new Option(placeholder, ''));
  if (groups) {
    options.forEach((group) => {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.label;
      group.options.forEach((option) => optgroup.append(new Option(option.label, option.value)));
      if (group.options.length) fragment.append(optgroup);
    });
  } else options.forEach((option) => fragment.append(new Option(option.label, option.value)));
  select.replaceChildren(fragment);
  if (selectedValue && Array.from(select.options).some((option) => option.value === selectedValue)) select.value = selectedValue;
  else if (select.options.length) select.selectedIndex = 0;
}

function renderOfficialSelectors() {
  const catalog = officialDshCatalog || normalizeOfficialCatalog();
  const selected = catalog.selected || {};
  modelPicker.update(catalog, ui.settings.recentModels || []);
  const inlineChoice=inlineController?.getSelection?.() || {};
  $('#settings-inline-capability').textContent = inlineClient.supports(inlineChoice)
    ? `${inlineChoice.officialMode===false?'兼容 Provider':'官方 dsh'} 补全可用，Key 仅由 DSH 进程使用。`
    : '所选路线的 AI 补全暂不可用；本地补全仍可使用。';
  const inlineSelect = $('#settings-inline-model');
  const previousInline = ui.settings.inlineModel || '';
  inlineSelect.replaceChildren(new Option('跟随 DSH 当前模型', ''));
  for (const provider of catalog.providers || []) for (const model of provider.models || []) inlineSelect.append(new Option(`${provider.displayName} · ${model.name}`, `${provider.providerId}\u0000${model.id}`));
  inlineSelect.value = previousInline;
  const providerSelect = $('#dsh-provider-select');
  const modelSelect = $('#dsh-model-select');
  const reasoningSelect = $('#dsh-reasoning-select');
  const settingProvider = $('#settings-official-provider');
  const settingModel = $('#settings-official-model');
  const settingReasoning = $('#settings-official-reasoning');
  const modelSearch = String($('#dsh-model-search')?.value || '').trim().toLocaleLowerCase();
  const providers = catalog.providers || [];
  const providerOptions = providers.map((provider) => ({
    value: provider.providerId,
    label: `${provider.displayName}${provider.hasKey ? '' : ' · 未配置 Key'}${provider.official ? '' : ' · 兼容'}`
  }));
  const modelGroups = providers.map((provider) => ({
    label: provider.displayName,
    options: provider.models.filter((model) => model.enabled !== false && (!modelSearch || `${model.id} ${model.name} ${model.description}`.toLocaleLowerCase().includes(modelSearch))).map((model) => ({
      value: `${provider.providerId}\u0000${model.id}`,
      label: model.name === model.id ? model.name : `${model.name} · ${model.id}`
    }))
  })).filter((group) => group.options.length);
  const selectedModelValue = selected.providerId && selected.model
    ? `${selected.providerId}\u0000${selected.model}` : '';
  setSelectOptions(providerSelect, providerOptions, selected.providerId, { placeholder: '无可用 Provider' });
  setSelectOptions(modelSelect, modelGroups.flatMap((group) => group.options), selectedModelValue, { placeholder: '无可用模型' });
  if (modelSelect && modelGroups.length) {
    const fragment = document.createDocumentFragment();
    modelGroups.forEach((group) => {
      const optgroup = document.createElement('optgroup'); optgroup.label = group.label;
      group.options.forEach((option) => optgroup.append(new Option(option.label, option.value)));
      fragment.append(optgroup);
    });
    modelSelect.replaceChildren(fragment);
    if (selectedModelValue && Array.from(modelSelect.options).some((option) => option.value === selectedModelValue)) modelSelect.value = selectedModelValue;
  }
  if ($('#dsh-model-search')) $('#dsh-model-search').value = modelSearch;
  const selectedPair = findOfficialModel(catalog, selected.providerId, selected.model);
  const levels = modelReasoningLevels(selectedPair.model, selectedPair.provider);
  const levelOptions = levels.map((level) => ({ value: level, label: REASONING_LABELS[level] || level }));
  setSelectOptions(reasoningSelect, levelOptions, selected.reasoningLevel);
  setSelectOptions(settingProvider, providerOptions, selected.providerId, { placeholder: '无可用 Provider' });
  setSelectOptions(settingModel, modelGroups.flatMap((group) => group.options), selectedModelValue, { placeholder: '无可用模型' });
  setSelectOptions(settingReasoning, levelOptions, selected.reasoningLevel);
  const state = $('#dsh-connection-state');
  if (state) {
    state.textContent = officialConnectionLabel();
    state.classList.toggle('is-ready', catalog.official && catalog.connected);
    state.classList.toggle('is-connecting', officialDsh.value.status === 'connecting');
    state.classList.toggle('is-error', !catalog.connected && officialDsh.value.status !== 'connecting');
  }
  const status = $('#settings-official-status');
  const detail = $('#settings-official-detail');
  const summary = $('#settings-official-summary');
  if (status) status.textContent = officialConnectionLabel();
  if (detail) detail.textContent = catalog.official
    ? `${catalog.providers.length} 个 Provider · ${catalog.models.length} 个模型 · 协议 ${catalog.protocol || 'ACP'}`
    : '未发现官方目录；兼容 Provider 仍可用于旧桥或浏览器回退。';
  if (summary) {
    summary.replaceChildren();
    const values = [
      ['Provider', catalog.providers.length],
      ['模型', catalog.models.length],
      ['工具', catalog.capabilities.tools ? '支持' : '关闭'],
      ['流式', catalog.capabilities.streaming ? '支持' : '关闭']
    ];
    values.forEach(([label, value]) => { const badge = document.createElement('span'); badge.textContent = `${label} ${value}`; summary.append(badge); });
  }
  if (providerSelect) providerSelect.disabled = !providers.length || officialDsh.value.status === 'connecting';
  if (modelSelect) modelSelect.disabled = !catalog.models.length || officialDsh.value.status === 'connecting';
  if (reasoningSelect) reasoningSelect.disabled = !selectedPair.model;
}

function setOfficialSelection(selection, { notify = true } = {}) {
  const next = { ...(officialDshCatalog.selected || {}), ...selection };
  inlineModelVersion++;
  inlineController?.invalidate('model');
  if (next.providerId && next.model) ui.settings.recentModels = [...new Set([`${next.providerId}\u0000${next.model}`, ...(ui.settings.recentModels || [])])].slice(0,5);
  const pair = findOfficialModel(officialDshCatalog, next.providerId, next.model);
  if (pair.provider && !next.model) next.model = pair.provider.models[0]?.id || '';
  const levels = modelReasoningLevels(pair.model, pair.provider);
  if (!levels.includes(next.reasoningLevel)) next.reasoningLevel = levels[0] || 'off';
  officialDsh.applySelection(next);
  officialDshCatalog = officialDsh.value.catalog;
  ui.settings.dshProvider = next.providerId || '';
  ui.settings.dshModel = next.model || '';
  ui.settings.dshReasoning = next.reasoningLevel || 'off';
  persistUi();
  renderOfficialSelectors();
  const selectedPair = findOfficialModel(officialDshCatalog, next.providerId, next.model);
  if (notify && dshGateway?.available && officialDshCatalog.official && selectedPair.provider?.official) {
    dshGateway.selectModel(next, { timeoutMs: 8_000 }).catch(() => {
      // Older bridges have no mutable model endpoint; the request snapshot
      // still carries this selection and the compatibility flow remains live.
    });
  }
}

async function refreshOfficialDsh({ quiet = false } = {}) {
  const generation = officialDsh.beginConnection();
  officialDshGeneration = generation;
  if (!dshGateway?.available) {
    const fallback = normalizeOfficialCatalog({ profiles: dshProfiles }, { profiles: dshProfiles });
    officialDsh.applyCatalog(fallback, { profiles: dshProfiles }, generation);
    officialDshCatalog = officialDsh.value.catalog;
    markStartup('dsh', 'unavailable', '浏览器预览：官方 dsh 不可用');
    renderOfficialSelectors();
    return officialDshCatalog;
  }
  const results = await Promise.allSettled([
    dshGateway.capabilities({ timeoutMs: 120_000 }),
    dshGateway.listModels({ timeoutMs: 120_000 }),
    dshGateway.listProviders({ timeoutMs: 120_000 }),
    dshGateway.listProfiles({ timeoutMs: 120_000 })
  ]);
  if (generation !== officialDsh.value.generation) return officialDshCatalog;
  const value = (index) => results[index]?.status === 'fulfilled' ? results[index].value : {};
  const capabilities = await dshGateway.capabilities({timeoutMs:8000}).catch(()=>value(0));
  if (generation !== officialDsh.value.generation) return officialDshCatalog;
  const nextServiceGeneration = Number(capabilities.generation || 0);
  if (nextServiceGeneration !== inlineServiceGeneration) inlineController?.invalidate('generation');
  inlineServiceGeneration = nextServiceGeneration;
  inlineClient.setCapabilities(capabilities.inlineCompletion);
  const models = value(1);
  const providerKinds = value(2);
  const profilesResult = value(3);
  dshProfiles = profilesResult.profiles || dshProfiles;
  renderSavedProvider();
  dshProviderKinds = providerKinds.providers || dshProviderKinds;
  const officialEnabled = capabilities.official === true || capabilities.mode === 'official' || models.official === true || Array.isArray(models.providers);
  const payload = {
    ...capabilities,
    ...(officialEnabled ? models : {}),
    providers: officialEnabled ? (models.providers || models.providerCatalog || models.catalog || []) : [],
    selected: capabilities.selected || models.selected || capabilities.selection || models.selection,
    profiles: dshProfiles
  };
  const catalog = normalizeOfficialCatalog(payload, {
    profiles: dshProfiles,
    providerId: ui.settings.dshProvider || ui.settings.gateway,
    model: ui.settings.dshModel,
    reasoningLevel: ui.settings.dshReasoning
  });
  officialDsh.applyCatalog(catalog, { profiles: dshProfiles }, generation);
  officialDshCatalog = officialDsh.value.catalog;
  const catalogError = results[1].status === 'rejected' ? results[1].reason : null;
  const startup = dshStartupState(catalogError ? null : catalog, catalogError);
  markStartup('dsh', startup.state, startup.detail);
  if (catalog.selected?.providerId) {
    ui.settings.dshProvider = catalog.selected.providerId;
    ui.settings.dshModel = catalog.selected.model || '';
    ui.settings.dshReasoning = catalog.selected.reasoningLevel || 'off';
  }
  renderOfficialSelectors();
  if (!quiet && !officialDshCatalog.official) showToast('内置 dsh 运行时尚未就绪，已保留兼容 Provider');
  inlineController?.schedule();
  return officialDshCatalog;
}

function scheduleOfficialDshRefresh() {
  clearTimeout(officialDshRefreshTimer);
  officialDshRefreshTimer = setTimeout(() => refreshOfficialDsh({ quiet: true }).catch(() => {}), 180);
}

function scheduleDshRender({ messagesOnly = false } = {}) {
  dshFullRenderPending ||= !messagesOnly;
  if (dshRenderFrame != null) return;
  const callback = () => {
    dshRenderFrame = null;
    dshLastPaint = performance.now();
    renderDshMessages();
    if (dshFullRenderPending) {
      renderDshActivity();
      renderDshChanges();
      renderEditor();
      setDshTab(ui.dshTab);
    }
    dshFullRenderPending = false;
  };
  // Consume every event, paint at most 30 times a second on long responses.
  dshRenderFrame = setTimeout(() => {
    if (typeof requestAnimationFrame === 'function') dshRenderFrame = requestAnimationFrame(callback);
    else callback();
  }, Math.max(0, 33 - (performance.now() - dshLastPaint)));
}

function trimDshState() {
  const bounded = boundDshTranscript(ui.messages, ui.activities);
  ui.messages = bounded.messages;
  ui.activities = bounded.activities;
}

function renderDshMessages() {
  trimDshState();
  const approvalHost = $('#dsh-patch-approval');
  if (approvalHost.__patch !== ui.pendingPatch) {
    approvalHost.replaceChildren();
    approvalHost.__patch = ui.pendingPatch;
  }
  if (ui.pendingPatch && !approvalHost.firstChild) {
    const transaction = ui.pendingPatch.transaction;
    const files = transaction?.files || ui.pendingPatch.files || [];
    const additions = transaction?.additions ?? files.reduce((sum, file) => sum + (file.additions || 0), 0) ?? ui.pendingPatch.additions;
    const removals = transaction?.removals ?? files.reduce((sum, file) => sum + (file.removals || 0), 0) ?? ui.pendingPatch.removals;
    const card = document.createElement('div');
    card.className = 'dsh-message system';
    const title = document.createElement('strong');
    title.textContent = `补丁等待确认 · ${files.length || 1} 个文件 · +${additions || 0} −${removals || 0}`;
    const detail = document.createElement('div');
    detail.textContent = files.length ? files.map((file) => file.path).join(' · ') : ui.pendingPatch.path;
    const actions = document.createElement('div');
    actions.className = 'approval-actions';
    const reject = document.createElement('button');
    reject.className = 'text-button';
    reject.textContent = '拒绝';
    reject.addEventListener('click', () => dsh.reject());
    const accept = document.createElement('button');
    accept.className = 'primary-button';
    accept.textContent = '应用补丁';
    accept.addEventListener('click', async () => {
      try { await dsh.acceptAsync(); }
      catch (error) { showToast('补丁应用失败：' + error.message); }
    });
    actions.append(reject, accept);
    card.append(title, detail, actions);
    approvalHost.append(card);
  }
  dshStreamView.render(ui.messages.slice(-DSH_MAX_MESSAGES));
  renderDshContext();
}

function renderDshContext() {
  const turn = ui.dshTurn;
  const phases = { waiting: '等待模型响应…', thinking: '正在思考…', answering: '正在输出…', tool: '正在处理工具…', approval: '等待你的确认', closing:'正在结束并保存会话…', interrupted:'请求已中断，可继续会话', completed: '已完成', cancelled: '已停止', error: '请求失败' };
  const state = $('#dsh-turn-status');
  state.textContent = turn ? (phases[turn.phase] || '就绪') + (turn.model ? ' · ' + turn.model.split('/').at(-1) : '') : ui.historyLoading ? '正在恢复会话…' : '就绪';
  state.classList.toggle('is-running', Boolean(turn && !turn.finishedAt));
  state.title = turn?.model ? `本次模型：${turn.model} · 推理：${turn.reasoning}` : '';
  const usage = ui.dshContextMode === 'history' ? contextUsage(ui.dshHistoryUsage || {}) : ui.dshContextMode === 'preview' ? null : turn?.usage;
  $('#dsh-context-usage').textContent = usage
    ? `${usage.used.toLocaleString()}${usage.size ? ' / ' + usage.size.toLocaleString() : ''} tokens${usage.percent == null ? '' : ' · ' + usage.percent.toFixed(1) + '%'}`
    : '用量待返回';
  $('#dsh-context-usage').title = '官方 dsh 报告的本次上下文占用，不是账单 token；未返回时不估算百分比';
  $('#dsh-context-meter').hidden = usage?.percent == null;
  if (usage?.percent != null) $('#dsh-context-meter-value').value = usage.percent;
  $('#dsh-context-refresh').disabled = Boolean(ui.dshBusy);
  const context = ui.dshContext;
  const caption = ui.dshContextMode === 'history' ? '该轮上下文' : ui.dshContextMode === 'sent' ? (turn?.finishedAt ? '上次已发送' : '本次已发送') : '待发送预览';
  $('#dsh-context-label').textContent = context ? `${caption} · ${context.files.length} 文件` : '本次请求上下文';
  $('#dsh-context-description').textContent = context
    ? `${(context.estimatedBytes / 1024).toFixed(1)} KiB · 脱敏 ${context.redactions} 处 · 排除 ${context.excluded.length} 项。${context.model ? '模型：'+context.model+'。' : ''}${conversations.available ? '同一会话由官方 dsh 恢复历史；此处是该轮附加文件。' : '浏览器预览不提供持久模型会话。'}`
    : '当前文件自动加入；可添加文件或选区。展开可预览本次请求内容。';
  if (context === dshContextRendered) return;
  dshContextRendered = context;
  const host = $('#dsh-context-files');
  host.replaceChildren();
  if (!context) return;
  for (const file of context.files) {
    const detail = document.createElement('details');
    detail.className = 'dsh-context-file';
    const summary = document.createElement('summary');
    summary.textContent = `${file.path} · ${file.bytes} B${file.redactions ? ' · 已脱敏' : ''}`;
    const preview = document.createElement('pre');
    preview.textContent = file.preview + (file.truncated ? '\n[仅显示前段，实际发送量以上方字节为准]' : '');
    const open = document.createElement('button');
    open.type = 'button'; open.className = 'text-button'; open.textContent = '打开源码';
    open.addEventListener('click', () => openFile(file.path));
    detail.append(summary, open, preview); host.append(detail);
  }
  const reasons = { ignored: '忽略规则', 'too-large': '文件过大', 'context-limit': '上下文上限', 'binary-or-missing': '二进制或不存在' };
  for (const file of context.excluded) {
    const item = document.createElement('p'); item.className = 'hint';
    item.textContent = `未加入：${file.path} · ${reasons[file.reason] || file.reason}`; host.append(item);
  }
}

async function previewDshContext() {
  if (ui.dshBusy || !documentSession.path) return;
  const sequence = ++dshContextSequence;
  const path = documentSession.path;
  const selected = officialDshCatalog.selected || {};
  try {
    const context = await contextIndexer.build({ path, content: documentSession.buffer,
      selection: ui.dshSelection?.path === path ? ui.dshSelection : undefined,
      attachedFiles: ui.dshAttachments, provider: selected.providerId, model: selected.model,
      uploadEnabled: ui.settings.codeUpload !== false });
    if (sequence !== dshContextSequence || ui.dshBusy || documentSession.path !== path) return;
    ui.dshContext = summarizeDshContext(context); ui.dshContextMode = 'preview'; renderDshContext();
  } catch (error) { showToast('上下文预览失败：' + error.message); }
}

function renderDshAttachments() {
  const host = $('#dsh-attachment-chips'); host.replaceChildren();
  const add = (label, remove) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'dsh-context-chip';
    button.textContent = label + (remove ? ' ×' : ''); button.title = label; button.disabled = Boolean(ui.dshBusy);
    if (remove) button.addEventListener('click', () => { remove(); renderDshAttachments(); previewDshContext(); });
    else button.disabled = true;
    host.append(button);
  };
  if (documentSession.path) add(`当前 · ${fileName(documentSession.path)}`);
  if (ui.dshSelection) add(`选区 · ${ui.dshSelection.startLine}–${ui.dshSelection.endLine} 行`, () => { ui.dshSelection = null; });
  const shown = ui.attachmentsExpanded ? ui.dshAttachments : ui.dshAttachments.slice(0,2);
  shown.forEach(path => add(path, () => { ui.dshAttachments = ui.dshAttachments.filter(item => item !== path); }));
  host.classList.toggle('is-expanded', Boolean(ui.attachmentsExpanded));
  if (ui.dshAttachments.length > 2) add(ui.attachmentsExpanded ? '收起附件' : `＋${ui.dshAttachments.length - 2} 更多`, () => { ui.attachmentsExpanded = !ui.attachmentsExpanded; });
  $('#dsh-attach-file').disabled = Boolean(ui.dshBusy);
  $('#dsh-attach-selection').disabled = Boolean(ui.dshBusy);
}

function renderDshAttachPicker() {
  const query = $('#dsh-attach-search').value.trim().toLocaleLowerCase();
  const host = $('#dsh-attach-files'); host.replaceChildren();
  for (const file of store.listFiles().filter(file => file.editable !== false && !file.binary && file.path.toLocaleLowerCase().includes(query)).slice(0, 80)) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button';
    button.textContent = (ui.dshAttachments.includes(file.path) ? '✓ ' : '＋ ') + file.path;
    button.addEventListener('click', () => {
      if (ui.dshBusy) return;
      if (!ui.dshAttachments.includes(file.path) && ui.dshAttachments.length < 20) ui.dshAttachments.push(file.path);
      renderDshAttachments(); renderDshAttachPicker(); previewDshContext();
    }); host.append(button);
  }
}

function renderDshActivity() {
  const container = $('#activity-list');
  container.replaceChildren();
  ui.activities.slice().reverse().forEach((activity) => {
    const row = document.createElement('div');
    row.className = 'activity-row';
    row.innerHTML = '<b>·</b><div><strong></strong><span></span></div>';
    row.querySelector('strong').textContent = activity.title;
    row.querySelector('span').textContent = activity.detail || '';
    container.append(row);
  });
  if (!ui.activities.length) container.textContent = '暂无活动';
}

function renderDshChanges() {
  const container = $('#change-list');
  container.replaceChildren();
  const pending = ui.pendingPatch;
  const expand = (transaction, status, isPending = false) => {
    const files = transaction?.transaction?.files || transaction?.files;
    if (Array.isArray(files) && files.length) {
      return files.map((file) => ({ transaction, patch: file.patch || createPatch(file.path, file.beforeText, file.afterText), status, pending: isPending }));
    }
    return [{ transaction, patch: transaction.patch || createPatch(transaction.path, transaction.before, transaction.after), status, pending: isPending }];
  };
  const items = [
    ...(pending ? expand(pending, '等待确认', true) : []),
    ...ui.changedTransactions.flatMap((transaction) => expand(transaction, transaction.status || '已应用 · 可撤销'))
  ];
  items.forEach((item) => {
    const patch = item.patch;
    const row = document.createElement('div');
    row.className = 'change-row';
    row.innerHTML = '<b>Δ</b><div><strong></strong><span></span><div class="change-stats"></div><div class="change-actions" hidden></div></div>';
    row.querySelector('strong').textContent = patch.path;
    row.querySelector('span').textContent = item.status;
    row.querySelector('.change-stats').textContent = '+' + patch.additions + ' −' + patch.removals;
    row.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      const files = item.transaction?.transaction?.files || item.transaction?.files;
      if (files?.length > 1) renderMultiFileDiff(files, 'DSH Diff');
      else renderDiff(patch);
    });
    if (item.pending) {
      const actions = row.querySelector('.change-actions');
      actions.hidden = false;
      const reject = document.createElement('button');
      reject.className = 'text-button';
      reject.type = 'button';
      reject.textContent = '拒绝';
      reject.addEventListener('click', () => dsh.reject());
      const accept = document.createElement('button');
      accept.className = 'primary-button';
      accept.type = 'button';
      accept.textContent = '应用补丁';
      accept.addEventListener('click', async () => {
        try { await dsh.acceptAsync(); }
        catch (error) { showToast('补丁应用失败：' + error.message); }
      });
      actions.append(reject, accept);
    }
    container.append(row);
  });
  if (dsh.lastTransaction) {
    const undo = document.createElement('button');
    undo.className = 'primary-button';
    undo.textContent = '撤销上一轮 DSH 修改';
    undo.addEventListener('click', async () => {
      try {
        const undone = await dsh.undoLastAsync();
        if (!undone) showToast('无法撤销：文件在应用补丁后已发生变化');
      } catch (error) {
        showToast('DSH 撤销失败：' + error.message);
      }
    });
    container.append(undo);
  }
  $('#change-count').textContent = String(items.length);
  $('#pending-dot').hidden = !pending;
}

function setDshTab(tab) {
  ui.dshTab = tab;
  $$('.dsh-tab').forEach((button) => button.classList.toggle('is-active', button.dataset.dshTab === tab));
  ['chat', 'activity', 'changes'].forEach((name) => $('#' + 'dsh-' + name + '-view').hidden = name !== tab);
  persistUi();
}

function setTerminalTab(tab) {
  ui.terminalTab = normalizeTerminalTab(tab);
  $$('.terminal-tab').forEach((button) => button.classList.toggle('is-active', button.dataset.terminal === ui.terminalTab));
  const showingProblems = ui.terminalTab === 'problems';
  const showingTests = ui.terminalTab === 'tests';
  $('#terminal-output').hidden = showingProblems || showingTests;
  $('#terminal-problems').hidden = !showingProblems;
  $('#terminal-tests').hidden = !showingTests;
  $('#terminal-form').hidden = showingProblems || showingTests || !ui.inputWaiting;
  $('#clear-terminal').hidden = showingProblems || showingTests;
  if (showingProblems) renderProblems();
  if (showingTests) renderTestResult(ui.lastTestResult);
  persistUi();
}

function renderStdin() {
  const waiting = Boolean(ui.inputWaiting && runtime.running);
  $('#terminal-input').disabled = !waiting; $('#terminal-send').disabled = !waiting;
  $('#terminal-form').hidden = !waiting || !['run','terminal'].includes(ui.terminalTab);
  $('#app').classList.toggle('input-pending', waiting);
}

function renderTestResult(result = ui.lastTestResult, page = 0) {
  renderTestResults($('#test-results'), result, {
    filter: $('#tests-outcome-filter').value, failedFirst: $('#tests-failed-first').checked, page,
    busy: Boolean(tests.running || runtime.running), onPage: next => renderTestResult(result,next),
    onOpen: async item => { if (!item.path || !store.has(item.path)) return; await openFile(item.path); editorCoordinator.goTo(positionToOffset(documentSession.buffer,{line:Math.max(0,(item.line||1)-1),character:Math.max(0,(item.column||1)-1)})); },
    onRerun: item => runTests({path:item.path,nodeId:item.nodeId || item.id})
  });
}

async function discoverTests() {
  diagnostics.start('testDiscoverMs');
  const status = $('#tests-status');
  status.textContent = '正在发现测试…';
  try {
    const result = await tests.discover({ path: $('#tests-path').value.trim() || undefined });
    const container = $('#test-results'); container.replaceChildren();
    status.textContent = result.available === false ? '浏览器预览不支持测试执行' : `发现 ${result.count || 0} 个测试文件`;
    for (const file of result.files || []) {
      const row = document.createElement('button'); row.className = 'result-row'; row.textContent = file.path;
      row.addEventListener('click', () => { $('#tests-path').value = file.path; openFile(file.path); });
      container.append(row);
    }
  } catch (error) { status.textContent = '发现失败：' + error.message; }
  finally { diagnostics.finish('testDiscoverMs'); }
}

function clearTerminal() {
  const output=$('#terminal-output');output.replaceChildren();delete output.dataset.truncated;terminalCharacters=0;
}

function conversationRows(messages) {
  const rows = [];
  const turns=new Map((messages || []).filter(message=>message.role==='assistant').map(message=>[message.turnId,message]));
  const prompts=new Map((messages || []).filter(message=>message.role==='user').map(message=>[message.turnId,message.content]));
  for (const message of messages || []) {
    const id = message.id || `${message.turnId}-${message.role}`;
    if (message.thought) rows.push({ id:id+'-thought', role:'assistant', kind:'thought', text:message.thought, outcome:message.status });
    for (const [index, tool] of (message.tools || []).entries()) rows.push({ id:`${id}-tool-${index}`, role:'system', kind:'tool', text:tool.preview || '', tool:{callId:tool.callId,title:tool.title || tool.name || tool.text || '工具记录',status:tool.status || 'completed',locations:tool.locations || []}, historyPatch:tool.patch });
    rows.push({ id, role:message.role, text:message.content || ({error:'该轮请求失败',interrupted:'该轮请求已中断',cancelled:'该轮请求已停止'})[message.status] || '', historyReadOnly:true,
      context:message.context ? {...message.context,model:message.model?.model,provider:message.model?.provider,usage:turns.get(message.turnId)?.usage} : null, model:message.model,
      retryPrompt:message.role==='assistant' && ['error','interrupted'].includes(message.status) ? prompts.get(message.turnId) : null });
  }
  return rows;
}

async function saveConversationDraft() {
  clearTimeout(conversationDraftTimer);
  if (conversations.available && ui.conversationId && conversations.selected?.id === ui.conversationId && !ui.historyLoading) await conversations.saveDraft(ui.conversationId, $('#dsh-input').value);
}

async function loadConversation(id, { older = false } = {}) {
  if (ui.dshBusy || ui.historyLoading) { showToast('请等待当前请求或会话加载完成'); return; }
  if(!older)await saveConversationDraft();
  ui.historyLoading=true;$('#dsh-input').disabled=true;$('#dsh-send').disabled=true;
  const stream=$('#dsh-stream');
  const anchor=older ? [...stream.querySelectorAll('[data-message-id]')].find(row=>row.getBoundingClientRect().bottom>stream.getBoundingClientRect().top+20) : null;
  const anchorId=anchor?.dataset.messageId,anchorTop=anchor?.getBoundingClientRect().top;
  try {
  const sequence = ++conversationSwitch;
  const page = older ? await conversations.read(id, { before:conversationPage?.nextBefore }) : await conversations.select(id);
  if (sequence !== conversationSwitch) return;
  conversationPage = page;
  ui.conversationId = id;
  ui.messages = older ? [...conversationRows(page.messages), ...ui.messages].slice(0,200) : conversationRows(page.messages).slice(-200);
  ui.historyBrowsing = older;
  dshStreamView.maxRows = 200;
  ui.pendingPatch = null; ui.diffPatch = null; dsh.pending = null; renderDiff(null);
  ui.dshTurn = null; ui.activities = []; ui.changedTransactions = [];
  const context = [...(page.messages || [])].reverse().find(message=>message.context)?.context;
  ui.dshContext = context ? summarizeDshContext(context) : null; ui.dshContextMode = 'history';
  ui.dshHistoryUsage = [...(page.messages || [])].reverse().find(message=>message.usage)?.usage;
  $('#dsh-conversation-title').textContent = page.conversation.title || '新对话';
  if(!older)$('#dsh-input').value = page.conversation.draft || '';
  $('#dsh-load-older').hidden = page.nextBefore == null;
  $('#dsh-history-latest').hidden = !older;
  $('#dsh-history-dialog').close();
  renderDshMessages(); renderDshChanges(); persistUi();
  if (older) { dshStreamView.setFollowing(false); const kept=[...stream.querySelectorAll('[data-message-id]')].find(row=>row.dataset.messageId===anchorId);if(kept)stream.scrollTop+=kept.getBoundingClientRect().top-anchorTop;else stream.scrollTop=0; } else dshStreamView.scrollToLatest();
  } finally {ui.historyLoading=false;$('#dsh-input').disabled=false;releaseDshUi();if(older)saveConversationDraft().catch(()=>{});}
}

async function newConversation() {
  if (ui.dshBusy || ui.historyLoading || conversations.activeTurn) { showToast('请等待当前请求或会话加载完成'); return; }
  await saveConversationDraft();
  ui.historyLoading=true;$('#dsh-input').disabled=true;$('#dsh-send').disabled=true;
  try {
  const conversation = conversations.available ? await conversations.create() : null;
  settleApproval(false); dsh.cancel();
  ui.conversationId = conversation?.id || null; conversationPage = null; ++conversationSwitch;
  ui.messages = [{role:'assistant',text:conversations.available?'新会话已就绪。可以添加文件、提问或提出修改要求。':'浏览器预览：本地补全与界面可用，AI 和官方历史需要 Android。'}];
  ui.dshTurn=null; ui.dshContext=null; ui.dshContextMode='preview'; ui.dshHistoryUsage=null;
  ui.lastDshPrompt=''; ui.dshRequestFailed=false; ui.historyBrowsing=false; ui.attachmentsExpanded=false;
  $('#dsh-retry').hidden=true;
  ui.activities=[]; ui.pendingPatch=null; ui.diffPatch=null; ui.changedTransactions=[]; ui.dshAttachments=[]; ui.dshSelection=null;
  $('#dsh-input').value=''; $('#dsh-conversation-title').textContent='新对话'; $('#dsh-load-older').hidden=true; $('#dsh-history-latest').hidden=true;
  renderDiff(null); renderDshAttachments(); scheduleDshRender(); persistUi();
  } finally {ui.historyLoading=false;$('#dsh-input').disabled=false;releaseDshUi();}
}

async function showConversationHistory({ more = false } = {}) {
  const dialog=$('#dsh-history-dialog'), list=$('#dsh-history-list');
  if (!dialog.open) dialog.showModal();
  if (!more) { list.replaceChildren(); conversationListOffset=0; }
  if (!conversations.available) { list.textContent='浏览器预览不提供官方历史会话。'; return; }
  try {
    const page=await conversations.list({archived:$('#history-archived').checked,offset:conversationListOffset});
    for (const item of page.conversations) {
      const row=document.createElement('div'); row.className='history-item';
      const open=document.createElement('button'); open.className='text-button';
      const title=document.createElement('strong');title.textContent=item.title || '新对话';
      const detail=document.createElement('small');detail.textContent=`${new Date(item.updatedAt).toLocaleString()} · ${item.status || '就绪'}`;
      open.append(title,detail);open.addEventListener('click',()=>loadConversation(item.id).catch(error=>showToast(error.message)));
      const archive=document.createElement('button');archive.className='text-button';archive.textContent=item.archived?'恢复':'归档';
      archive.addEventListener('click',async()=>{try{await conversations.archive(item.id,!item.archived);if(ui.conversationId===item.id && !item.archived)await newConversation();await showConversationHistory();}catch(error){showToast(error.message);}});
      row.append(open,archive);list.append(row);
    }
    if (!list.childElementCount) list.textContent='这里还没有会话。';
    conversationListOffset=page.nextOffset;
    $('#history-load-more').hidden=page.nextOffset == null;
  } catch(error) { list.textContent='历史读取失败：'+error.message; }
}

function releaseDshUi() {
  ui.dshBusy=Boolean(conversations.activeTurn);
  $('#dsh-send').disabled=ui.dshBusy || Boolean(ui.historyLoading); $('#dsh-cancel').disabled=!ui.dshBusy;
  if (ui.dshBusy && ui.dshTurn) ui.dshTurn.phase='closing';
  renderDshAttachments(); scheduleDshRender();
}

conversations.subscribe(event => {
  if (event.type === 'turn-finished' || event.type === 'interrupted') {
    if (event.conversationId !== ui.conversationId) return;
    if (ui.dshTurn) { ui.dshTurn.phase=event.type==='interrupted'?'interrupted':event.kind==='error'?'error':event.stopReason==='cancelled'?'cancelled':'completed'; ui.dshTurn.finishedAt=Date.now(); }
    releaseDshUi();
    conversations.read(ui.conversationId).then(page=>{if(page.conversation.id!==ui.conversationId)return;conversations.selected=page.conversation;$('#dsh-conversation-title').textContent=page.conversation.title || '新对话';conversationPage=page;$('#dsh-load-older').hidden=page.nextBefore==null;}).catch(()=>{});
  }
});

async function runTests(options = {}) {
  if (runAdmissionPending || tests.running || runtime.running) { showToast('请先停止正在运行的任务'); return; }
  if (!nativeBroker.available) { showToast('测试需要 Android Runtime'); return; }
  const dirty = documentSession.dirtyPaths();
  const approved = await requestUserApproval('确认运行测试', (options.nodeId || options.path || '工作区所有测试') + (dirty.length ? `\n将先保存 ${dirty.length} 个已修改文件。` : ''));
  if (!approved || runAdmissionPending || tests.running || runtime.running) return;
  runAdmissionPending = true;
  try {
    await documentSession.saveAllAsync();
    if (documentSession.dirtyPaths().length) throw new Error('文件仍在变化，请保存后重试');
    await store.flush(); ui.terminalOpen = true; setTerminalTab('tests'); renderLayout();
    await tests.run({ ...options, workspaceId:'default' });
  } catch (error) { $('#tests-status').textContent = '测试启动失败：' + error.message; showToast('测试启动失败：' + error.message); }
  finally { runAdmissionPending = false; }
}

function appendTerminal(text, tone = '', options = {}) {
  const output = $('#terminal-output');
  const verbatim = options.verbatim === true;
  let value = String(text ?? '');
  if (!value) return;
  if (!verbatim && !value.endsWith('\n')) value += '\n';
  if (value.length > TERMINAL_MAX_CHARACTERS) {
    value = '[较早输出已截断]\n' + value.slice(-(TERMINAL_MAX_CHARACTERS - 16));
    clearTerminal();
    output.dataset.truncated = 'true';
  }

  const wasAtBottom = !output.childElementCount
    || output.scrollHeight - output.scrollTop - output.clientHeight < 48;
  const className = ('terminal-line ' + tone).trim();
  const previous = output.lastElementChild;
  if (verbatim
      && previous?.dataset.streamChunk === 'true'
      && previous.className === className
      && previous.textContent.length + value.length <= TERMINAL_MERGE_CHARACTERS) {
    previous.append(document.createTextNode(value));
  } else {
    const chunk = document.createElement('span');
    chunk.className = className;
    chunk.dataset.streamChunk = String(verbatim);
    chunk.textContent = value;
    output.append(chunk);
  }
  terminalCharacters += value.length;
  while (output.childElementCount > TERMINAL_MAX_CHUNKS
      || terminalCharacters > TERMINAL_MAX_CHARACTERS) {
    const oldest = output.firstElementChild;
    if (!oldest) break;
    terminalCharacters -= oldest.textContent.length;
    oldest.remove();
    output.dataset.truncated = 'true';
  }
  if (wasAtBottom) output.scrollTop = output.scrollHeight;
}

function renderLayout() {
  const app = $('#app');
  const grid = $('#body-grid');
  const width = app.clientWidth;
  const { narrow, fullDsh, overlayDsh } = computeDshLayout({
    width,
    dshOpen: ui.dshOpen,
    mode: ui.mode
  });
  const projectVisible = ui.projectOpen;
  const columns = ['44px'];
  if (projectVisible) columns.push(ui.projectWidth + 'px');
  columns.push('minmax(420px, 1fr)');
  columns.push(fullDsh && !overlayDsh ? ui.dshWidth + 'px' : '44px');
  grid.style.gridTemplateColumns = columns.join(' ');
  app.dataset.theme = ui.theme;
  // Keep the theme token scope on the document root as well as the app shell.
  // Settings/command dialogs are siblings of #app and otherwise stay dark
  // when the workspace is switched to the light theme.
  document.documentElement.dataset.theme = ui.theme;
  app.classList.add('compact-density');
  app.classList.toggle('dsh-overlay', overlayDsh);
  app.classList.toggle('project-collapsed', !projectVisible);
  app.classList.toggle('terminal-collapsed', !ui.terminalOpen);
  app.classList.toggle('terminal-maximized', Boolean(ui.terminalMaximized));
  app.classList.toggle('code-tools-visible', ui.codeTools !== false);
  app.classList.toggle('input-pending', Boolean(ui.inputWaiting));
  app.style.setProperty('--terminal-size', `${Math.max(100,Math.min(600,Number(ui.terminalHeight)||200))}px`);
  $('#code-tools').hidden = ui.codeTools === false;
  $('#workspace-panel').hidden = !projectVisible;
  $('#project-resize').hidden = !projectVisible;
  $('#project-resize').style.left = (44 + (projectVisible ? ui.projectWidth : 0) - 6) + 'px';
  $('#dsh-panel').hidden = !fullDsh;
  $('#dsh-rail').hidden = fullDsh;
  $('#dsh-resize').hidden = !fullDsh || overlayDsh;
  $('#dsh-resize').style.right = (fullDsh && !overlayDsh ? ui.dshWidth - 6 : -6) + 'px';
  $('#dsh-toggle').classList.toggle('is-active', fullDsh);
  $('#dsh-toggle').setAttribute('aria-label', fullDsh ? '折叠 DSH' : '展开 DSH');
  $('#theme-button').innerHTML = icon('theme');
  $('#theme-button').setAttribute('aria-label', ui.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
  const capabilities = runtime.capabilities();
  $('#runtime-label').textContent = Object.values(startupStatus).some(s=>s.state === 'error') ? '服务需检查' : capabilities.available ? '服务正常' : '服务准备中';
  $('#status-interpreter').textContent = capabilities.abi && capabilities.abi !== 'n/a'
    ? capabilities.python + ' · ' + capabilities.abi
    : capabilities.python;
  $('.runtime-chip').classList.toggle('is-pending', !capabilities.available);
  const runOption = $('#run-config option[value="current-file"]');
  if (runOption) runOption.textContent = fileName(documentSession.path || 'train.py') + (capabilities.available ? ' · Python Runtime' : ' · Runtime 待安装');
  if (!runtime.running && !tests.running) renderRuntimeStatus('idle');
  document.querySelector('meta[name="theme-color"]').content = ui.theme === 'dark' ? '#101318' : '#e9edf3';
}

function renderRuntimeStatus(state = 'idle') {
  const status = $('#status-runtime');
  const available = runtime.capabilities().available;
  status.classList.toggle('status-good', state === 'idle' && available);
  status.classList.toggle('status-warning', state === 'idle' && !available);
  status.classList.toggle('status-error', state === 'failed');
  if (state === 'running') status.textContent = '● Running';
  else if (state === 'stopping') status.textContent = '● Stopping…';
  else if (state === 'failed') status.textContent = '● Runtime error';
  else status.textContent = available ? '● Runtime ready' : '● Runtime provider pending';
}

function renderAll() {
  $('#workspace-name').textContent = store.workspaceName;
  renderLayout();
  renderTree();
  renderTool();
  renderEditor();
  renderFileOperations();
  renderProblems();
  renderPackages();
  renderRunConfigurations();
  renderDshMessages();
  renderDshActivity();
  renderDshChanges();
  renderOfficialSelectors();
  setDshTab(ui.dshTab);
  setTerminalTab(ui.terminalTab);
  $('#status-events').textContent = ui.eventCount + ' file events';
}

function scheduleAutosave() {
  clearTimeout(ui.autosaveTimer);
  const delay = Number(ui.settings.autosave || 0);
  if (!delay) return;
  ui.autosaveTimer = setTimeout(() => {
    if (!documentSession.preview) documentSession.saveAllAsync().then(() => renderTabs()).catch(error => showToast('自动保存失败：' + error.message));
  }, delay * 1000);
}

function saveCurrent() {
  const path=documentSession.path;
  if(!path)return Promise.resolve(false);
  if(savePromises.has(path))return savePromises.get(path);
  const pending=(async()=>{
    try {
      await documentSession.savePathAsync(path,'editor'); await store.flush();
      const saved=documentSession.snapshotFor(path);
      if(saved?.dirty){showToast('已保存先前内容，新输入仍待保存');scheduleAutosave();return false;}
      showToast('已保存 '+path);return true;
    } catch(error){showToast('保存 '+path+' 失败：'+error.message);return false;}
    finally{savePromises.delete(path);}
  })();
  savePromises.set(path,pending);return pending;
}

function presentApproval(title, detail, approval) {
  if (ui.pendingApproval || dialogs.open) return false;
  ui.pendingApproval = approval;
  $('#approval-title').textContent = title;
  $('#approval-command').textContent = detail;
  $('#approval-card').hidden = false;
  ui.dshOpen = true;
  renderLayout();
  persistUi();
  return true;
}

function requestUserApproval(title, detail) {
  if (dialogs.open) { showToast('请先处理当前确认请求'); return Promise.resolve(false); }
  return dialogs.confirm(title, detail, '确认继续');
}

function presentDshRunApproval(event) {
  const official = Boolean(event.official || event.source === 'official-dsh' || event.action === 'permission');
  const title = official ? '官方 DSH 请求权限' : 'DSH 请求运行配置';
  const detail = official
    ? (event.permission?.description || event.permission?.title || event.permission?.tool || event.permission?.name || event.configurationId || '请求执行工作区工具')
    : event.configurationId;
  if (presentApproval(title, detail, {
    type: official ? 'official-tool' : 'dsh-run',
    requestId: event.requestId,
    approvalId: event.approvalId || event.requestId,
    action: event.action,
    configurationId: event.configurationId,
    official
  })) return;
  if (official) dshGateway?.respondToolApproval(event.approvalId || event.requestId, false).catch(() => {});
  else dsh.denyRun(event.requestId);
  ui.messages.push({ role: 'assistant', text: '已有确认请求等待处理，本次运行请求已拒绝。' });
}

function settleApproval(allowed) {
  const approval = ui.pendingApproval;
  if (!approval) return;
  ui.pendingApproval = null;
  $('#approval-card').hidden = true;
  if (approval.type === 'official-tool') {
    if (allowed && approval.action === 'run') {
      completeOfficialRunApproval(approval).catch(error => showToast('DSH 运行反馈失败：' + error.message));
    } else dshGateway?.respondToolApproval(approval.approvalId, Boolean(allowed)).catch((error) => showToast('DSH 确认失败：' + error.message));
    if (!allowed) ui.messages.push({ role: 'assistant', text: 'DSH 工具请求已拒绝。' });
    scheduleDshRender();
    return;
  }
  if (approval.type === 'dsh-run') {
    if (allowed) {
      dsh.approveRun(approval.requestId)
        .catch((error) => showToast('运行失败：' + error.message));
    } else {
      dsh.denyRun(approval.requestId);
      ui.messages.push({ role: 'assistant', text: '运行请求已拒绝。' });
      renderDshMessages();
    }
    return;
  }
  approval.resolve(Boolean(allowed));
}

function renderFileOperations() {
  const busy = Boolean(ui.fileOperationBusy || fileOperations.busy);
  $('#new-file-button').disabled = busy;
  const path = ui.selectedTreePath || documentSession.path;
  const isFile = Boolean(path && store.has(path));
  $('#rename-file-button').disabled = busy || !isFile;
  $('#delete-file-button').disabled = busy || !isFile;
  $('#undo-file-operation').disabled = busy || !fileOperations.latest;
  $('#undo-file-operation').title = fileOperations.latest ? '撤销：' + fileOperations.latest.label : '本次会话没有可撤销的文件操作';
}

async function performFileOperation(operation, { undo = false, paths = [] } = {}) {
  if (ui.fileOperationBusy || fileOperations.busy) return;
  if (runtime.running || tests.running || runAdmissionPending) { showToast('请先停止运行或测试，再修改文件路径'); return; }
  if (documentSession.preview || documentSession.conflict) { showToast('请先处理预览或文件冲突'); return; }
  if (undo && documentSession.dirtyPaths().length) { showToast('请先保存已修改文件，再撤销文件操作'); return; }
  ui.fileOperationBusy = true;
  renderFileOperations();
  try {
    for (const path of paths) if (documentSession.snapshotFor(path)?.dirty) await documentSession.savePathAsync(path);
    documentSession.assertClean(paths);
    $('#project-action-menu').hidden = true;
    const result = await operation();
    if (result?.focusPath && store.has(result.focusPath)) await openFile(result.focusPath);
    else await reconcileWorkspaceSession();
    showToast(undo ? '文件操作已撤销' : '文件操作已完成，可在 Project 中撤销');
  } catch (error) { showToast('文件操作未完成：' + error.message); }
  finally { ui.fileOperationBusy = false; renderFileOperations(); }
}

async function completeOfficialRunApproval(approval) {
  let result;
  try {
    const admission = await dshGateway.respondToolApproval(approval.approvalId, true);
    if (admission?.accepted !== true || admission.source !== 'pythona-mcp') {
      showToast('运行请求已过期，未执行配置');
      return;
    }
    const configuration = runConfigurations.resolve(approval.configurationId, documentSession.path);
    const adapter = configuration.type === 'test' ? tests : runtime;
    result = await collectRunResult(adapter, () => runCurrent(approval.configurationId, { approvedByUser: true }), {
      cancel: runId => adapter === tests ? tests.cancel(runId) : runtime.stop()
    });
  } catch (error) { result = { status: 'error', message: error.message }; }
  await dshGateway.respondToolApproval(approval.approvalId, true, { result });
}

async function runCurrent(configurationId = null, options = {}) {
  if (runAdmissionPending || tests.running || runtime.running) { showToast('请先停止正在运行的任务'); return; }
  const requestedId = configurationId || $('#run-config').value || 'current-file';
  if (!documentSession.path && requestedId === 'current-file') return;
  if (documentSession.conflict) { showToast('请先解决文件冲突'); return; }
  const selectedId = requestedId;
  let configuration;
  try { configuration = runConfigurations.resolve(selectedId, documentSession.path); }
  catch (error) { showToast(error.message); return; }
  if (!options.approvedByUser) {
    const approved = await requestUserApproval(
      '确认运行配置',
      `${configuration.name} · ${configuration.target}\n参数：${configuration.args?.join(' ') || '无'}\n目录：${configuration.workingDirectory || '/'}${documentSession.dirtyPaths().length ? '\n将先保存所有已修改文件。' : ''}`
    );
    if (!approved) return null;
  }
  if (runAdmissionPending || tests.running || runtime.running) return null;
  runAdmissionPending = true;
  try {
    await documentSession.saveAllAsync();
    if (documentSession.dirtyPaths().length) throw new Error('文件仍在变化，请保存后重试');
    await store.flush();
    ui.terminalOpen = true;
    setTerminalTab(configuration.type === 'test' ? 'tests' : 'run');
    renderLayout();
    appendTerminal('运行 ' + configuration.name + ' · ' + configuration.target, 'info');
    renderRuntimeStatus('running');
    diagnostics.start('runStartMs');
    if (configuration.type === 'test') {
      const accepted = await tests.run({
        workspaceId: 'default', framework: configuration.framework,
        paths: configuration.paths?.length ? configuration.paths : [configuration.target],
        nodeId: configuration.nodeId, args: configuration.testArgs,
        workingDirectory: configuration.workingDirectory,
        environment: configuration.environment, envFiles: configuration.envFiles,
        timeoutMillis: configuration.timeoutMillis
      });
      if (!configuration.temporary) await runConfigurations.markRun(configuration.id);
      return accepted;
    }
    const result = await runtime.runConfiguration(configuration, { workspaceId: 'default' });
    if (!configuration.temporary) await runConfigurations.markRun(configuration.id);
    return result;
  } catch (error) {
    appendTerminal(error.message, 'error');
    if (options.approvedByUser) throw error;
    return null;
  } finally { diagnostics.finish('runStartMs'); runAdmissionPending = false; }
}

function commandNeedsApproval(command) {
  const text = String(command || '').trim();
  // Never treat shell composition or `-c` snippets as a harmless workspace
  // command. They can escape the intended runtime sandbox.
  if (!text || /[;&|<>`$]/.test(text)) return true;
  const safe = /^(?:clear|pip\s+list|python3?\s+--version|python3?\s+-m\s+pytest(?:\s+[A-Za-z0-9_./=:-]+)*|python3?\s+-m\s+pip\s+list|pytest(?:\s+[A-Za-z0-9_./=:-]+)*|python3?\s+[A-Za-z0-9_./][A-Za-z0-9_./-]*(?:\s+[A-Za-z0-9_./=:-]+)*)$/;
  return !safe.test(text);
}

function requestCommand(command) {
  showToast('Python Console 不提供 Bash；请运行当前文件或安装签名运行包');
}

async function runTerminalCommand(command) {
  if (!runtime.running || !ui.inputWaiting) return;
  appendTerminal('stdin › ' + command, 'info');
  try { await runtime.sendInput(command + '\n'); ui.inputWaiting = false; renderStdin(); }
  catch (error) { appendTerminal(error.message, 'error'); }
}

const PROVIDER_DEFAULTS = {
  'openai-compatible': { baseUrl: '', model: '' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' }
};

function loadDshProfile(profile = null) {
  const kind = profile?.providerKind || 'openai-compatible';
  const defaults = PROVIDER_DEFAULTS[kind] || PROVIDER_DEFAULTS['openai-compatible'];
  $('#settings-provider-kind').value = kind;
  $('#settings-provider-name').value = profile?.displayName || '';
  $('#settings-provider-url').value = profile?.baseUrl || defaults.baseUrl;
  $('#settings-provider-model').value = profile?.model || defaults.model;
  $('#settings-provider-headers').value = '';
  const headerNames = Object.keys(profile?.headers || {});
  $('#settings-provider-headers').placeholder = headerNames.length
    ? `已配置 ${headerNames.join(', ')}；留空表示保留`
    : 'X-Header: value（每行一个）';
  $('#settings-provider-key').value = '';
  $('#settings-provider-key').placeholder = profile?.hasKey ? '已安全保存；留空表示不更换' : '输入 API Key';
  $('#settings-provider-local').checked = Boolean(profile?.allowLocalEndpoint);
  $('#delete-provider').disabled = !profile;
  $('#test-provider').disabled = !profile?.hasKey;
}

async function refreshDshSettings() {
  const select = $('#settings-dsh-profile');
  if (!dshGateway?.available) {
    dshProfiles = [];
    select.replaceChildren(new Option('浏览器演示模式', '__new__'));
    loadDshProfile(null);
    ['#save-provider', '#test-provider', '#delete-provider'].forEach((selector) => { $(selector).disabled = true; });
    $('#settings-network-status').textContent = '浏览器预览没有原生 :dsh 网络进程。';
    return;
  }
  const [providersResult, profilesResult, network] = await Promise.all([
    dshGateway.listProviders(), dshGateway.listProfiles(), dshGateway.networkStatus()
  ]);
  dshProviderKinds = providersResult?.providers || [];
  dshProfiles = profilesResult?.profiles || [];
  renderSavedProvider();
  const compatibilityProfiles = dshProfiles.filter(profile => profile.profileId !== 'direct-dsh');
  const selected = ui.settings.gateway && compatibilityProfiles.some((profile) => profile.profileId === ui.settings.gateway)
    ? ui.settings.gateway : compatibilityProfiles[0]?.profileId || '__new__';
  select.replaceChildren(new Option('＋ 新建 Provider', '__new__'));
  compatibilityProfiles.forEach((profile) => select.append(new Option(
    `${profile.displayName} · ${profile.model}${profile.hasKey ? '' : ' · 缺少 Key'}`,
    profile.profileId
  )));
  select.value = selected;
  if (selected !== '__new__' && ui.settings.gateway !== selected) {
    ui.settings.gateway = selected;
    persistUi();
  }
  loadDshProfile(dshProfiles.find((profile) => profile.profileId === selected) || null);
  $('#settings-network-status').textContent = JSON.stringify({
    process: ':dsh',
    connected: network.connected,
    validated: network.validated,
    metered: network.metered,
    otherProcesses: 'INTERNET denied'
  }, null, 2);
  // Keep the official selector and the compatibility profile list in sync;
  // this also makes old bridges populate the fallback catalog after settings
  // are opened for the first time.
  scheduleOfficialDshRefresh();
}

async function saveDshProvider() {
  if (!dshGateway?.available) return;
  const selected = $('#settings-dsh-profile').value;
  const existing = dshProfiles.find((profile) => profile.profileId === selected);
  const kind = $('#settings-provider-kind').value;
  const profile = {
    profileId: existing?.profileId || `profile-${globalThis.crypto?.randomUUID?.() || Date.now().toString(36)}`,
    displayName: $('#settings-provider-name').value.trim() || kind,
    providerKind: kind,
    baseUrl: $('#settings-provider-url').value.trim(),
    apiVersion: existing?.apiVersion || '',
    model: $('#settings-provider-model').value.trim(),
    contextWindow: existing?.contextWindow || 128000,
    maxOutputTokens: existing?.maxOutputTokens || 4096,
    temperature: existing?.temperature ?? 0.2,
    supportsTools: true,
    supportsStreaming: true,
    enabled: true,
    allowLocalEndpoint: $('#settings-provider-local').checked
  };
  const headerText = $('#settings-provider-headers').value.trim();
  if (headerText) {
    profile.headers = {};
    for (const line of headerText.split(/\r?\n/)) {
      const match = /^([A-Za-z0-9-]{1,64}):\s*(.*)$/.exec(line.trim());
      if (!match) { showToast('Header 格式应为 Name: value'); return; }
      profile.headers[match[1]] = match[2];
    }
  }
  const secretInput = $('#settings-provider-key');
  try {
    const result = await dshGateway.saveProfile(profile, secretInput.value);
    secretInput.value = '';
    ui.settings.gateway = result.profile.profileId;
    persistUi();
    await refreshDshSettings();
    showToast('DSH Provider 已安全保存');
  } catch (error) {
    showToast('保存 Provider 失败：' + error.message);
  } finally {
    secretInput.value = '';
  }
}

async function testDshProvider() {
  const profileId = $('#settings-dsh-profile').value;
  if (!profileId || profileId === '__new__') return;
  $('#test-provider').disabled = true;
  try {
    const result = await dshGateway.testProfile(profileId, { timeoutMs: 135_000 });
    showToast(result.ok ? `连接成功 · ${result.latencyMillis} ms` : 'Provider 未返回有效响应');
  } catch (error) { showToast('Provider 测试失败：' + error.message); }
  finally { $('#test-provider').disabled = false; }
}

async function deleteDshProvider() {
  const profileId = $('#settings-dsh-profile').value;
  if (!profileId || profileId === '__new__') return;
  if (!confirm('删除此 Provider 配置及其加密 Key？此操作不可撤销。')) return;
  try {
    await dshGateway.deleteProfile(profileId);
    if (ui.settings.gateway === profileId) ui.settings.gateway = '';
    persistUi();
    await refreshDshSettings();
    showToast('Provider 与加密凭据已删除');
  } catch (error) { showToast('删除 Provider 失败：' + error.message); }
}

function showSettings() {
  $('#performance-summary').textContent = JSON.stringify(diagnostics.snapshot().metrics, null, 2);
  ui.settingsDraft = { ...ui.settings, theme: ui.theme, mode: ui.mode };
  $('#settings-theme').value = ui.settingsDraft.theme;
  $('#settings-editor-size').value = ui.settingsDraft.editorSize;
  $('#editor-size-value').value = ui.settingsDraft.editorSize + ' px';
  $('#settings-tab-size').value = String(ui.settingsDraft.tabSize || 4);
  $('#settings-autosave').value = String(ui.settingsDraft.autosave || 'off');
  $('#settings-line-numbers').checked = ui.settingsDraft.lineNumbers;
  $('#settings-fold-gutter').checked = ui.settingsDraft.foldGutter;
  $('#settings-autocomplete').checked = ui.settingsDraft.autocomplete;
  $('#settings-inline-enabled').checked = ui.settingsDraft.inlineEnabled !== false;
  $('#settings-word-wrap').checked = ui.settingsDraft.wordWrap;
  $('#settings-ui-font').value = ui.settingsDraft.uiFont;
  $('#settings-code-font').value = ui.settingsDraft.codeFont;
  $('#settings-dsh-font').value = ui.settingsDraft.dshFont;
  $('#settings-restore').checked = ui.settingsDraft.restore;
  $('#settings-live-preview').checked = ui.settingsDraft.livePreview;
  $('#settings-approval').checked = ui.settingsDraft.approval;
  $('#settings-interpreter').value = ui.settingsDraft.interpreter;
  $('#settings-background').checked = ui.settingsDraft.background;
  $('#settings-code-upload').checked = ui.settingsDraft.codeUpload !== false;
  $('#settings-external-files').checked = ui.settingsDraft.externalFiles;
  $('#settings-network').checked = ui.settingsDraft.network;
  renderOfficialSelectors();
  $('#settings-official-provider').value = officialDshCatalog.selected?.providerId || ui.settingsDraft.dshProvider || '';
  $('#settings-official-model').value = officialDshCatalog.selected?.providerId && officialDshCatalog.selected?.model
    ? `${officialDshCatalog.selected.providerId}\u0000${officialDshCatalog.selected.model}` : '';
  $('#settings-official-reasoning').value = officialDshCatalog.selected?.reasoningLevel || ui.settingsDraft.dshReasoning || 'off';
  $('#settings-runtime-capability').textContent = JSON.stringify(runtime.capabilities(), null, 2);
  $('#settings-dialog').showModal();
  refreshDshSettings().catch((error) => {
    $('#settings-network-status').textContent = 'DSH 原生服务不可用：' + error.message;
  });
  refreshOfficialDsh({ quiet: true }).catch((error) => markStartup('dsh', 'error', error));
}

async function saveOfficialDshKey() {
  if (!dshGateway?.available) return;
  const button = $('#save-official-key');
  button.disabled = true;
  try {
    const result = await dshGateway.configureCredential({ timeoutMs: 300_000, profile: dshProfiles.find(p => p.profileId === 'direct-dsh') });
    if (result?.cancelled) return;
    if (!result?.saved) throw new Error('Provider 保存失败');
    if (result.profile) {
      dshProfiles = [...dshProfiles.filter(p => p.profileId !== result.profile.profileId), result.profile];
      renderSavedProvider();
    }
    if (result.activated && result.catalog) {
      const generation = officialDsh.beginConnection();
      officialDsh.applyCatalog(result.catalog, {profiles: dshProfiles}, generation);
      const selected = result.catalog.selected;
      if (selected) setOfficialSelection(selected, {notify:false});
      markStartup('dsh', 'ready', 'Provider 配置已载入官方 dsh');
      showToast(result.hasKey ? 'Provider 已保存并生效' : 'Provider 已保存并载入；填写 Key 后可发起请求');
    } else {
      showToast(result.message || '配置已保存，但载入失败；请刷新目录');
      markStartup('dsh', 'error', '已保存配置，目录载入失败；请重试');
    }
  } catch (error) {
    showToast('保存自定义 Provider 失败：' + error.message);
  } finally {
    button.disabled = false;
  }
}

function renderSavedProvider() {
  const row = $('#settings-saved-provider');
  if (!row) return;
  const profile = dshProfiles.find(p => p.profileId === 'direct-dsh');
  row.textContent = profile
    ? `已保存：${profile.displayName} · ${profile.model}\n${profile.baseUrl}\n${profile.hasKey ? 'Key 已配置' : '尚未配置 Key'}`
    : '尚未保存自定义 Provider';
}

function closeSettings(apply) {
  if (apply) {
    ui.theme = $('#settings-theme').value;
    ui.mode = 'adaptive';
    ui.settings = {
      ...ui.settings,
      editorSize: Number($('#settings-editor-size').value),
      tabSize: Number($('#settings-tab-size').value),
      autosave: $('#settings-autosave').value === 'off' ? 0 : Number($('#settings-autosave').value),
      lineNumbers: $('#settings-line-numbers').checked,
      foldGutter: $('#settings-fold-gutter').checked,
      autocomplete: $('#settings-autocomplete').checked,
      inlineEnabled: $('#settings-inline-enabled').checked,
      inlineModel: $('#settings-inline-model').value,
      wordWrap: $('#settings-word-wrap').checked,
      uiFont: $('#settings-ui-font').value,
      codeFont: $('#settings-code-font').value,
      dshFont: $('#settings-dsh-font').value,
      restore: $('#settings-restore').checked,
      livePreview: $('#settings-live-preview').checked,
      approval: $('#settings-approval').checked,
      interpreter: $('#settings-interpreter').value,
      background: $('#settings-background').checked,
      gateway: ui.settings.gateway,
      dshMode: ui.settings.dshMode,
      dshProvider: ui.settings.dshProvider,
      dshModel: ui.settings.dshModel,
      dshReasoning: ui.settings.dshReasoning,
      codeUpload: $('#settings-code-upload').checked,
      externalFiles: $('#settings-external-files').checked,
      network: $('#settings-network').checked
    };
    applyFontSettings();
    inlineModelVersion++;
    inlineController.setEnabled(ui.settings.inlineEnabled !== false && ui.settings.codeUpload !== false);
    persistUi();
    renderAll();
    showToast('设置已应用');
  } else {
    $('#app').dataset.theme = ui.theme;
    document.documentElement.dataset.theme = ui.theme;
    editorCoordinator.adapter.configure({ ...ui.settings, theme: ui.theme });
    mergeDiffView.configure({ theme: ui.theme });
  }
  ui.settingsDraft = null;
  $('#settings-dialog').close();
}

function applyFontSettings() {
  const app = $('#app');
  const root = document.documentElement;
  const uiFont = ui.settings.uiFont === 'serif' ? 'Georgia, "Noto Serif SC", serif' : '"PythonA UI", Inter, "Noto Sans SC", system-ui, sans-serif';
  const codeFont = ui.settings.codeFont === 'system' ? 'ui-monospace, monospace' : '"PythonA Code", "JetBrains Mono", "Cascadia Mono", ui-monospace, monospace';
  const dshFont = ui.settings.dshFont === 'code' ? 'var(--code-font)' : 'var(--ui-font)';
  [app, root].forEach((target) => {
    target.style.setProperty('--ui-font', uiFont);
    target.style.setProperty('--code-font', codeFont);
    target.style.setProperty('--dsh-font', dshFont);
    target.style.setProperty('--editor-font-size', ui.settings.editorSize + 'px');
  });
}

function setLeftTool(tool) {
  if (tool === 'terminal' || tool === 'python-console') {
    ui.terminalOpen = true;
    renderTool();
    renderLayout();
    persistUi();
    return;
  }
  if (tool === 'dsh') {
    ui.dshOpen = !ui.dshOpen;
    renderTool();
    renderLayout();
    persistUi();
    return;
  }
  if (tool === 'settings') { showSettings(); return; }
  ui.leftTool = tool;
  ui.projectOpen = true;
  renderTool();
  renderLayout();
  persistUi();
  if (tool === 'search') $('#search-input').focus();
}

async function executeAction(actionId) {
  if (!serviceRegistry.get('ActionProvider', actionId)) return false;
  if (actionId === 'file.save') await saveCurrent();
  else if (actionId === 'run.execute') await runCurrent();
  else if (actionId === 'run.stop') {
    try {
      if (tests.running) { diagnostics.start('testCancelMs'); await tests.cancel(tests.running.runId); }
      else if (runtime.running) { diagnostics.start('runtimeCancelMs'); await runtime.stop(); }
    }
    catch (error) { showToast('停止失败：' + error.message); }
  } else if (actionId === 'language.references') {
    await findReferences(editorCoordinator.adapter.view?.state.selection.main.head || 0);
  } else if (actionId === 'language.rename') {
    await renameSymbol(editorCoordinator.adapter.view?.state.selection.main.head || 0);
  } else if (actionId === 'tool.project.toggle') {
    ui.projectOpen = !ui.projectOpen;
    renderTool();
    renderLayout();
    persistUi();
  } else if (actionId === 'tool.dsh.toggle') {
    ui.dshOpen = !ui.dshOpen;
    renderTool();
    renderLayout();
    persistUi();
  } else if (actionId === 'tool.console.open') {
    ui.terminalOpen = true;
    renderTool();
    renderLayout();
    persistUi();
  } else if (actionId === 'settings.open') showSettings();
  else return false;
  return true;
}

function renderRegisteredChrome() {
  const rail = $('#tool-window-rail');
  rail.replaceChildren();
  for (const tool of serviceRegistry.list('ToolWindowProvider')) {
    const button = document.createElement('button');
    button.className = 'rail-button' + (tool.id === 'python-console' ? ' rail-spacer' : '');
    button.dataset.tool = tool.id;
    button.dataset.serviceId = tool.id;
    button.setAttribute('aria-label', tool.title);
    button.innerHTML = icon(tool.id === 'python-console' ? 'terminal' : tool.id);
    rail.append(button);
  }

  const commands = $('#command-list');
  commands.replaceChildren();
  for (const action of serviceRegistry.list('ActionProvider')) {
    const button = document.createElement('button');
    button.dataset.command = action.id;
    button.append(document.createTextNode(action.title + ' '));
    if (action.shortcut) {
      const shortcut = document.createElement('span');
      shortcut.textContent = action.shortcut;
      button.append(shortcut);
    }
    commands.append(button);
  }
}

function setupResize(handle, kind) {
  let startX = 0;
  let startWidth = 0;
  handle.addEventListener('pointerdown', (event) => {
    startX = event.clientX;
    startWidth = kind === 'project' ? ui.projectWidth : ui.dshWidth;
    handle.classList.add('is-dragging');
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    const delta = event.clientX - startX;
    if (kind === 'project') ui.projectWidth = Math.max(220, Math.min(430, startWidth + delta));
    else ui.dshWidth = Math.max(310, Math.min(520, startWidth - delta));
    renderLayout();
  });
  handle.addEventListener('pointerup', (event) => {
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    handle.classList.remove('is-dragging');
    persistUi();
  });
}

store.subscribe((event) => {
  const affectsPendingPatch = dsh.pending
    && !String(event.source || '').startsWith('dsh')
    && (
      (event.path && ['file-changed', 'file-deleted'].includes(event.type)
        && dsh.pending.files?.some((file) => file.path === event.path))
      || event.type === 'workspace-replaced'
    );
  if (affectsPendingPatch && !dsh.isCurrentBase(dsh.pending)) {
    dsh.discardStale('patch-stale', dsh.pending, 'workspace-changed');
  }
  completionFilesDirty = true;
  ui.eventCount += 1;
  scheduleWorkspaceRender();
  if (ui.initialized && ['file-changed', 'file-deleted', 'workspace-replaced'].includes(event.type)) scheduleProjectIndex();
  $('#status-events').textContent = ui.eventCount + ' file events';
  if (event.type === 'file-changed' && ['external', 'native-external'].includes(event.source)) showToast('检测到外部修改：' + event.path);
  if (event.type === 'workspace-replaced' || (event.type === 'workspace-hydrated' && ui.initialized)) scheduleWorkspaceReconcile();
});

documentSession.subscribe((event) => {
  if(event.type==='draft-error'){ui.draftWarning=event.message;showToast('草稿保存/恢复失败：'+event.message);}
  if (event.inactive) { renderTabs(); renderTree(); return; }
  if (['edited','opened','external-refresh','preview','conflict'].includes(event.type)) { inlineController?.invalidate(event.type); inlineController?.schedule(); }
  if (['opened', 'edited', 'external-refresh', 'external-delete', 'undo', 'redo'].includes(event.type)) {
    if (ui.dshSelection && (ui.dshSelection.path !== documentSession.path || ui.dshSelection.bufferVersion !== documentSession.bufferVersion)) ui.dshSelection = null;
    renderDshAttachments();
  }
  const invalidatesAssistantPatch = [
    'edited', 'opened', 'external-refresh', 'external-delete', 'conflict', 'conflict-resolved', 'undo', 'redo'
  ].includes(event.type);
  if (invalidatesAssistantPatch && !dsh.applyingTransaction && dsh.pending && !dsh.isCurrentBase(dsh.pending)) {
    dsh.discardStale('patch-stale', dsh.pending, 'document-changed');
  }
  renderEditor();
  if (['opened', 'edited', 'dsh-edit', 'external-refresh', 'conflict-resolved', 'saved'].includes(event.type)) {
    queueLanguageDocument(event.type, event.document, event.changes, { defer: Boolean(event.composing) });
  }
  if (event.type === 'external-delete') queueLanguageDocument('closed', event.document);
  if (event.type === 'edited') scheduleAutosave();
  if (event.type === 'conflict') showToast('检测到文件冲突，请选择解决方式');
  if (event.type === 'external-delete' || (event.type === 'conflict-resolved' && event.deleted)) scheduleWorkspaceReconcile();
});

runtime.subscribe((event) => {
  if (event.type === 'capabilities') { const status = runtimeStartupState(event.capabilities); markStartup('runtime', status.state, status.detail); }
  if (event.type === 'capabilities-failed') markStartup('runtime', 'error', event.error);
  if (event.type === 'service-connected' || event.type === 'service-reconnected') markStartup('runtime', 'pending', '正在验证 Runtime 能力');
  if (['finished', 'stopped', 'failed'].includes(event.type)) diagnostics.finish('runtimeCancelMs');
  if (event.type === 'capabilities') {
    renderLayout();
    renderPackages();
    confirmRuntimePackActivation();
    if ($('#settings-dialog').open) $('#settings-runtime-capability').textContent = JSON.stringify(event.capabilities, null, 2);
  }
  if (event.type === 'service-connected' || event.type === 'service-reconnected') {
    refreshRuntimePackCapabilities({ quiet: true });
    refreshPythonPackageCapabilities({ quiet: true, validateInstall: true });
    runtime.listPackages({ environment: 'default' }).then(renderPackages, () => {});
  }
  if (event.type === 'capabilities-failed') {
    appendTerminal('Runtime capability check failed: ' + event.error.message, 'error');
  }
  if (event.type === 'output') {
    appendTerminal(event.text, event.stream === 'stderr' ? 'error' : '', { verbatim: true });
  }
  if (event.type === 'input-request') {
    ui.inputWaiting = true;
    ui.terminalOpen = true;
    if (!['run','terminal'].includes(ui.terminalTab)) setTerminalTab('run');
    renderLayout(); renderStdin();
    // CPython already writes input(prompt) to stdout. The control event only
    // focuses stdin; appending the prompt here would display it twice.
    $('#terminal-input').placeholder = event.prompt
      ? '输入 ' + String(event.prompt).replace(/\s+/g, ' ').trim()
      : 'input() 等待输入';
    $('#terminal-input').focus();
  }
  if (event.type === 'clear') clearTerminal();
  if (event.type === 'started') renderRuntimeStatus('running');
  if (event.type === 'stopping') renderRuntimeStatus('stopping');
  if (event.type === 'finished') {
    ui.inputWaiting = false; renderStdin();
    appendTerminal('Process finished with exit code ' + event.exitCode, 'info');
    $('#terminal-input').placeholder = '脚本调用 input() 时在此输入';
    renderRuntimeStatus('idle');
    // `pip install`/bridge responses can mutate the capability set while the
    // command is running; refresh the package view when the transaction ends.
    renderPackages();
  }
  if (event.type === 'stopped') {
    ui.inputWaiting = false; renderStdin();
    appendTerminal(event.forced ? 'Process force-stopped; Runtime is restarting' : 'Process stopped', 'info');
    renderRuntimeStatus('idle');
  }
  if (event.type === 'stop-failed') {
    appendTerminal('Stop failed: ' + event.error.message, 'error');
    renderRuntimeStatus('running');
  }
  if (event.type === 'failed') { ui.inputWaiting = false; renderStdin(); renderRuntimeStatus('failed'); }
});

tests.subscribe((event) => {
  $('#tests-cancel').disabled = !tests.running;
  if (event.type === 'started' || event.type === 'accepted') { renderRuntimeStatus('running'); $('#tests-status').textContent = '测试运行中…'; }
  if (event.type === 'stopping') $('#tests-status').textContent = '正在取消测试…';
  if (event.type === 'capabilities-failed') {
    appendTerminal('Test capability check failed: ' + (event.error?.message || event.error), 'error');
  }
  if (event.type === 'output') appendTerminal(event.text, event.stream === 'stderr' ? 'error' : '', { verbatim: true });
  if (event.type === 'accepted') appendTerminal('测试任务已开始 · ' + event.runId, 'info');
  if (event.type === 'finished') {
    diagnostics.finish('testCancelMs');
    $('#tests-status').textContent = event.result.status;
    const result = normalizeTestResult(event.result);
    const counts = result.counts;
    appendTerminal(`测试完成 · ${result.status} · ${counts.passed} 通过 / ${counts.failed} 失败 / ${counts.skipped} 跳过 / ${counts.errors} 异常 · ${result.durationMillis} ms`, result.status === 'passed' ? 'info' : 'error');
    result.cases.filter((item) => item.outcome === 'failed' || item.outcome === 'error').forEach((item) => {
      appendTerminal(`${item.path}:${item.line || 1} · ${item.name}\n${item.traceback || item.message}`, 'error');
    });
    // Keep a structured tree available to the Run panel and future tool
    // window without retaining unbounded raw output in the UI state.
    ui.lastTestResult = { ...result, tree: createTestResultTree(result) };
    renderTestResult(ui.lastTestResult);
    renderRuntimeStatus('idle');
  }
});

dsh.subscribe((event) => {
  if ((event.kind === 'approval_expired' || event.type === 'approval_expired') && ui.pendingApproval?.approvalId === event.approvalId) {
    ui.pendingApproval = null;
    $('#approval-card').hidden = true;
    showToast('DSH 权限请求已过期');
  }
  if (event.type === 'task-started') {
    ui.dshTurn ||= createDshTurn(officialDshCatalog.selected);
    diagnostics.start('dshFirstTokenMs');
    if (['dsh-run', 'official-tool'].includes(ui.pendingApproval?.type)) settleApproval(false);
    // DshAgentController cancels any previous transaction before starting a new
    // stream. Drop its old UI approval card as well, otherwise a stale hunk
    // could be accepted after the controller has already discarded it.
    ui.pendingPatch = null;
    ui.diffPatch = null;
    renderDiff(null);
    ui.activities.push({ title: '开始处理 ' + event.path, detail: event.prompt });
  } else if (event.type === 'stream-starting') {
    ui.dshRemoteStarted = true;
  } else if (event.type === 'context-manifest') {
    const userMessage=ui.messages.slice().reverse().find(message=>message.role==='user');
    if(userMessage)userMessage.context=event.context;
    ++dshContextSequence;
    ui.dshContext = summarizeDshContext(event.context);
    ui.dshContextMode = 'sent';
    const manifest = {
      provider: event.context.provider,
      model: event.context.model,
      estimatedBytes: event.context.estimatedBytes,
      files: event.context.files.map((file) => ({ path: file.path, bytes: file.bytes, redactions: file.redactions.length })),
      excluded: event.context.excluded,
      redactions: event.context.redactions
    };
    $('#settings-context-manifest').textContent = JSON.stringify(manifest, null, 2);
    ui.activities.push({ title: `上下文 ${manifest.files.length} 个文件 · ${manifest.estimatedBytes} bytes`, detail: manifest.redactions.length ? `已脱敏 ${manifest.redactions.length} 处` : '未发现凭据' });
  } else if (applyDshStreamEvent(ui.dshTurn, event, ui.messages)) {
    if(event.kind==='usage'){const user=ui.messages.slice().reverse().find(message=>message.role==='user');if(user?.context)user.context.usage=event.usage;}
    if (event.type === 'delta') diagnostics.finish('dshFirstTokenMs');
    if (event.callId && event.type === 'scope') {
      const title = event.title || event.text || '工作区工具';
      const previous = ui.activities.find(item => item.callId === event.callId);
      if (previous) previous.detail = event.status || previous.detail;
      else ui.activities.push({ callId: event.callId, title, detail: event.status || '进行中' });
    }
  } else if (event.type === 'scope' || event.type === 'tool') {
    ui.activities.push({ title: event.text, detail: event.type });
    ui.messages.push({ role: 'system', text: event.text });
  } else if (event.type === 'tool-call') {
    ui.activities.push({ title: '模型请求工具 · ' + event.name, detail: event.callId || '' });
  } else if (event.type === 'tool-result') {
    ui.activities.push({ title: '工具完成 · ' + event.name, detail: event.result?.approvalRequired ? '等待用户确认' : '已返回模型' });
  } else if (event.type === 'approval-required' && (event.action === 'run' || event.official || event.source === 'official-dsh' || event.action === 'permission')) {
    if (ui.dshTurn && !ui.dshTurn.finishedAt) ui.dshTurn.phase = 'approval';
    presentDshRunApproval(event);
  } else if (event.type === 'hunk-preview') {
    ui.activities.push({ title: '实时预览 hunk ' + event.index + '/' + event.total, detail: event.patch.path });
    if (ui.settings.livePreview) renderDiff(event.patch);
  } else if (event.type === 'task-ready') {
    ui.pendingPatch = event.transaction
      ? { ...event.patch, transaction: event.transaction, files: event.transaction.files }
      : event.patch;
    if (event.transaction?.files?.length > 1) renderMultiFileDiff(event.transaction.files, 'DSH Diff');
    ui.messages.push({ role: 'assistant', text: event.summary });
    // Keep live output visible; the Changes tab and inline approval remain available.
  } else if (event.type === 'patch-accepted') {
    const first = event.transaction.files?.[0];
    const patch = first?.patch || createPatch(event.transaction.path, event.transaction.before, event.transaction.after);
    ui.changedTransactions.unshift({ ...event.transaction, patch, status: '已应用 · 可撤销' });
    ui.pendingPatch = null;
    ui.messages.push({ role: 'assistant', text: '补丁已写入工作区并保存。' });
    ui.diffPatch = patch;
  } else if (event.type === 'patch-rejected') {
    ui.pendingPatch = null;
    ui.messages.push({ role: 'assistant', text: '已拒绝补丁，工作区没有发生变化。' });
    renderDiff(null);
  } else if (event.type === 'patch-undone') {
    ui.changedTransactions = ui.changedTransactions.filter((item) => (
      item.transactionId !== event.transaction.transactionId || item.acceptedAt !== event.transaction.acceptedAt
    ));
    ui.messages.push({ role: 'assistant', text: '已撤销上一轮 DSH 文件修改。' });
    ui.diffPatch = null;
    renderDiff(null);
  } else if (event.type === 'task-error') {
    conversations.failStart(event.error);
    ui.dshRequestFailed = true;
    $('#dsh-retry').hidden = false;
    finishDshTurn(ui.dshTurn, 'error');
    if (ui.pendingApproval?.type === 'official-tool') settleApproval(false);
    ui.pendingPatch = null;
    ui.messages.push({ role: 'assistant', text: dshErrorMessage(event.error) });
  } else if (event.type === 'done') {
    if (ui.pendingApproval?.type === 'official-tool') settleApproval(false);
    diagnostics.finish('dshCancelMs');
    if (event.stopReason === 'cancelled') finishDshTurn(ui.dshTurn, 'cancelled');
  } else if (event.type === 'task-finished') {
    finishDshTurn(ui.dshTurn);
  } else if (event.type === 'task-stale' || event.type === 'patch-stale') {
    ui.pendingPatch = null;
    ui.diffPatch = null;
    renderDiff(null);
    ui.messages.push({ role: 'assistant', text: '当前文件已发生变化，旧补丁已安全丢弃，请重新发起修改。' });
    showToast('DSH 补丁已过期，未修改任何文件');
  } else if (event.type === 'undo-blocked') {
    ui.messages.push({ role: 'assistant', text: '撤销已停止：文件已切换或在补丁应用后又发生了变化。' });
    showToast('为避免覆盖新内容，本次撤销已停止');
  }
  trimDshState();
  scheduleDshRender({ messagesOnly: ['delta', 'thought', 'usage', 'stream_reset'].includes(event.type) });
});

renderRegisteredChrome();

$('#save-button').addEventListener('click', () => executeAction('file.save'));
$('#save-all-button').addEventListener('click',async()=>{try{await documentSession.saveAllAsync();renderTabs();showToast('所有文件已保存');}catch(error){showToast('保存失败：'+error.message);}});
$('#toggle-code-tools').addEventListener('click',()=>{ui.codeTools=!ui.codeTools;renderLayout();persistUi();});
$('#code-tools').addEventListener('pointerdown',event=>{if(event.target.closest('button'))event.preventDefault();});
$$('[data-code-action]').forEach(button=>button.addEventListener('click',()=>editorCoordinator.adapter.touchEdit(button.dataset.codeAction)));
$$('[data-code-insert]').forEach(button=>button.addEventListener('click',()=>editorCoordinator.adapter.touchEdit(button.dataset.codeInsert)));
$('#inline-accept').addEventListener('click',()=>editorCoordinator.adapter.acceptInlineSuggestion());
$('#inline-reject').addEventListener('click',()=>editorCoordinator.adapter.clearInlineSuggestion('dismiss'));
$('#inline-trigger').addEventListener('click',()=>{showSettings();$('[data-settings-page="inline"]').click();});
$('#service-status-button').addEventListener('click',()=>{ui.servicesExpanded=!ui.servicesExpanded;renderStartupStatus();});
$('#project-more-button').addEventListener('click',()=>{if(!$('#project-action-menu').hidden)$('#project-action-menu').hidden=true;else openFileMenu();});
document.addEventListener('pointerdown',event=>{if(!event.target.closest('#project-action-menu,#project-more-button,.tree-row'))$('#project-action-menu').hidden=true;});
document.addEventListener('keydown',event=>{if(event.key==='Escape')$('#project-action-menu').hidden=true;});
$('#undo-button').addEventListener('click', () => editorCoordinator.undo());
$('#redo-button').addEventListener('click', () => editorCoordinator.redo());
$('#editor-search-button').addEventListener('click', () => editorCoordinator.openSearch());
$('#completion-button').addEventListener('click', () => editorCoordinator.startCompletion());
$('#keep-local').addEventListener('click', async () => { documentSession.keepLocal(); await saveCurrent(); });
$('#accept-remote').addEventListener('click', () => {
  const snapshot = documentSession.acceptRemote();
  if (!snapshot.path) scheduleWorkspaceReconcile();
});
$('#view-conflict-diff').addEventListener('click',()=>{const s=documentSession.snapshot();if(s.conflict)renderDiff(createPatch(s.path,s.conflict.remote || '',s.buffer,{title:s.conflict.recoveredDraft?'草稿恢复差异':'外部变更差异'}));});
$('#editor-notice-retry').addEventListener('click',async()=>{if(documentSession.snapshot().saveError){await saveCurrent();return;}ui.draftWarning='';try{await documentSession.recoverDrafts();await documentSession.flushDrafts();}catch(error){ui.draftWarning=error.message;}renderEditor();});
$('#open-live-diff').addEventListener('click', () => {
  if (documentSession.preview) renderDiff(createPatch(documentSession.path, documentSession.buffer, documentSession.preview.content));
});
$('#close-diff').addEventListener('click', () => renderDiff(null));

$$('.rail-button[data-tool]').forEach((button) => button.addEventListener('click', () => setLeftTool(button.dataset.tool)));
$('#collapse-project').addEventListener('click', () => { ui.projectOpen = false; renderLayout(); persistUi(); });
$('#new-file-button').addEventListener('click', async () => {
  const selected = ui.selectedTreePath;
  const initial = selected && !store.has(selected) ? selected + '/new_file.py' : 'src/new_file.py';
  const path = await dialogs.text('新建文件', initial, { validate: value => validateWorkspacePath(value) || (store.has(value) ? '该文件已经存在' : '') });
  if (!path) return;
  await performFileOperation(() => fileOperations.create(path, '# New PythonA file\n'));
});
$('#rename-file-button').addEventListener('click', async () => {
  const path = ui.selectedTreePath || documentSession.path;
  if (!path) return;
  const target = await dialogs.text('重命名文件', path, { detail: documentSession.snapshotFor(path)?.dirty ? '将先保存该文件的修改，再移动文件。' : '', validate: value => validateWorkspacePath(value) || (value !== path && store.has(value) ? '目标文件已存在' : '') });
  if (!target || target === path) return;
  await performFileOperation(() => fileOperations.rename(path, target), { paths:[path] });
});
$('#delete-file-button').addEventListener('click', async () => {
  const path = ui.selectedTreePath || documentSession.path;
  if (!path || !(await dialogs.confirm('删除文件', `${path}\n本次会话内可撤销。${documentSession.snapshotFor(path)?.dirty ? '将先保存未保存的修改，便于撤销恢复。' : ''}`, '删除'))) return;
  await performFileOperation(() => fileOperations.remove(path), { paths:[path] });
});
$('#undo-file-operation').addEventListener('click', () => performFileOperation(() => fileOperations.undo(), { undo: true }));
$('#refresh-workspace').addEventListener('click', async () => { await store.flush(); renderAll(); showToast('工作区已刷新'); });
$('#import-workspace').addEventListener('click', async () => {
  try { await store.importDirectory(); scheduleWorkspaceReconcile(); showToast('目录已导入'); }
  catch (error) { showToast(error.message); }
});
$('#export-workspace').addEventListener('click', () => {
  const url = URL.createObjectURL(store.exportBlob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = store.workspaceName + '.pythona.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('#search-input').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderSearch, 90); });
$('#install-python-wheel').addEventListener('click', () => installPurePythonWheel());
$('#install-package').addEventListener('click', () => installSignedRuntimePack());
$('#rollback-package').addEventListener('click', () => rollbackSignedRuntimePack());
$('#save-run-configuration').addEventListener('click', saveRunConfigurationForm);

$('#theme-button').addEventListener('click', () => {
  ui.theme = ui.theme === 'dark' ? 'light' : 'dark';
  editorCoordinator.adapter.configure({ ...ui.settings, theme: ui.theme });
  mergeDiffView.configure({ theme: ui.theme });
  renderLayout(); persistUi();
});
$('#dsh-toggle').addEventListener('click', () => executeAction('tool.dsh.toggle'));
$('#collapse-dsh').addEventListener('click', () => { ui.dshOpen = false; renderLayout(); persistUi(); });
$('#expand-dsh').addEventListener('click', () => { ui.dshOpen = true; renderLayout(); persistUi(); });
$('#toggle-terminal').addEventListener('click', () => { ui.terminalOpen = false; renderLayout(); persistUi(); });
$('#clear-terminal').addEventListener('click', clearTerminal);
$('#run-button').addEventListener('click', () => executeAction('run.execute'));
$('#stop-button').addEventListener('click', () => executeAction('run.stop'));
$('#references-button').addEventListener('click', () => executeAction('language.references'));
$('#rename-button').addEventListener('click', () => executeAction('language.rename'));
$('#tests-discover').addEventListener('click', discoverTests);
$('#tests-run-workspace').addEventListener('click', () => runTests());
$('#tests-run-current').addEventListener('click', () => documentSession.path && runTests({ path: documentSession.path }));
$('#tests-run-path').addEventListener('click', () => runTests({ path: $('#tests-path').value.trim() || undefined }));
$('#tests-cancel').addEventListener('click', () => executeAction('run.stop'));
$('#tests-outcome-filter').addEventListener('change',()=>renderTestResult());
$('#tests-failed-first').addEventListener('change',()=>renderTestResult());

$$('.terminal-tab').forEach((button) => button.addEventListener('click', () => setTerminalTab(button.dataset.terminal)));
$('#terminal-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('#terminal-input');
  const command = input.value;
  if (!ui.inputWaiting) return;
  input.value = '';
  runTerminalCommand(command);
});
$('#allow-command').addEventListener('click', () => settleApproval(true));
$('#deny-command').addEventListener('click', () => settleApproval(false));

$$('.dsh-tab').forEach((button) => button.addEventListener('click', () => setDshTab(button.dataset.dshTab)));
$('#dsh-context').addEventListener('toggle', () => {
  if ($('#dsh-context').open && !ui.dshBusy && !ui.dshContext) previewDshContext();
});
$('#dsh-context-refresh').addEventListener('click', () => previewDshContext());
$('#dsh-attach-file').addEventListener('click', () => {
  $('#dsh-attach-picker').hidden = !$('#dsh-attach-picker').hidden;
  if (!$('#dsh-attach-picker').hidden) { renderDshAttachPicker(); $('#dsh-attach-search').focus(); }
});
$('#dsh-attach-search').addEventListener('input', () => renderDshAttachPicker());
$('#dsh-attach-selection').addEventListener('click', () => {
  const state = editorCoordinator.adapter.view?.state;
  const range = state?.selection.main;
  if (!range || range.empty) { showToast('先在编辑器中选中代码，再加入上下文'); return; }
  ui.dshSelection = { path: documentSession.path, bufferVersion: documentSession.bufferVersion,
    text: state.doc.sliceString(range.from, range.to), startLine: state.doc.lineAt(range.from).number, endLine: state.doc.lineAt(range.to).number };
  renderDshAttachments(); previewDshContext(); $('#dsh-context').open = true;
});
$('#dsh-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (dshComposing) return;
  if (ui.dshBusy || ui.historyLoading || conversations.loading) { showToast('DSH 正在处理请求或恢复会话，请稍候'); return; }
  if (nativeBroker.available) {
    const selected = officialDshCatalog.selected || {};
    const pair = findOfficialModel(officialDshCatalog, selected.providerId, selected.model);
    if (!pair.provider || !pair.model || (pair.provider.official && (!officialDshCatalog.connected || officialDsh.value.status !== 'ready'))) {
      showToast('模型目录尚未就绪，请稍候重试；输入内容已保留');
      return;
    }
  }
  const input = $('#dsh-input');
  const promptText = input.value.trim();
  if (!promptText) return;
  if (ui.historyBrowsing && ui.conversationId) await loadConversation(ui.conversationId);
  ui.dshBusy = true;
  ui.dshRemoteStarted = false;
  ui.dshCancelled = false;
  ui.dshRequestFailed = false;
  ui.lastDshPrompt = promptText;
  $('#dsh-retry').hidden = true;
  inlineController?.invalidate('chat');
  ui.dshTurn = createDshTurn(officialDshCatalog.selected);
  ++dshContextSequence;
  $('#dsh-attach-picker').hidden = true;
  renderDshAttachments();
  $('#dsh-send').disabled = true;
  $('#dsh-cancel').disabled = false;
  ui.messages.push({ role: 'user', text: promptText });
  input.value = '';
  renderDshMessages();
  dshStreamView.scrollToLatest();
  try {
    const selected = officialDshCatalog.selected || {};
    const selectedPair = findOfficialModel(officialDshCatalog, selected.providerId, selected.model);
    const profile = dshProfiles.find((item) => item.profileId === selected.providerId)
      || dshProfiles.find((item) => item.profileId === ui.settings.gateway)
      || dshProfiles.find((item) => item.enabled)
      || dshProfiles[0];
    const officialMode = Boolean(officialDshCatalog.official && selectedPair.provider?.official);
    const turn = conversations.available && officialMode ? await conversations.beginTurn({conversationId:ui.conversationId || undefined}) : {};
    if (turn.conversationId) { ui.conversationId = turn.conversationId; persistUi(); }
    if (ui.dshCancelled) { conversations.failStart(new Error('cancelled')); return; }
    await dsh.start(promptText, {
      ...turn,
      profileId: profile?.profileId || selected.providerId || null,
      provider: selected.providerId || profile?.displayName || profile?.providerKind || null,
      model: selected.model || profile?.model || null,
      reasoningLevel: selected.reasoningLevel || ui.settings.dshReasoning || 'off',
      officialMode,
      attachedFiles: ui.dshAttachments.slice(),
      selection: ui.dshSelection?.path === documentSession.path ? ui.dshSelection : undefined,
      uploadEnabled: ui.settings.codeUpload !== false
    });
  } catch (error) {
    conversations.failStart(error);
    ui.dshRequestFailed=true; $('#dsh-retry').hidden=false;
    finishDshTurn(ui.dshTurn, 'error');
    showToast(dshErrorMessage(error));
  } finally {
    if (!ui.dshRemoteStarted && conversations.activeTurn) conversations.failStart(new Error('未发出请求'));
    finishDshTurn(ui.dshTurn);
    releaseDshUi();
    if (ui.dshRequestFailed && !input.value) input.value=promptText;
  }
});
$('#dsh-cancel').addEventListener('click', () => {
  ui.dshCancelled=true;
  diagnostics.start('dshCancelMs');
  if (ui.pendingApproval?.type === 'official-tool') settleApproval(false);
  dsh.cancel();
  finishDshTurn(ui.dshTurn, 'cancelled');
  ui.pendingPatch = null;
  ui.diffPatch = null;
  renderDiff(null);
  ui.messages.push({role:'system',text:'已请求停止 DSH，未批准的修改不会写入工作区。'});
  scheduleDshRender();
});
$('#dsh-input').addEventListener('keydown', (event) => {
  if (shouldSubmitPrompt(event, dshComposing)) { event.preventDefault(); $('#dsh-form').requestSubmit(); }
});
$('#dsh-input').addEventListener('compositionstart', () => { dshComposing = true; });
$('#dsh-input').addEventListener('compositionend', () => { dshComposing = false; });
$('#clear-dsh').addEventListener('click', () => newConversation().catch(error=>showToast(error.message)));
$('#dsh-history-button').addEventListener('click', () => showConversationHistory());
$('#close-dsh-history').addEventListener('click', () => $('#dsh-history-dialog').close());
$('#history-archived').addEventListener('change', () => showConversationHistory());
$('#history-load-more').addEventListener('click', () => showConversationHistory({more:true}));
$('#dsh-load-older').addEventListener('click', () => loadConversation(ui.conversationId,{older:true}).catch(error=>showToast(error.message)));
$('#dsh-history-latest').addEventListener('click', () => loadConversation(ui.conversationId).catch(error=>showToast(error.message)));
$('#rename-conversation').addEventListener('click', async()=>{
  if(!ui.conversationId){showToast('先创建会话');return;}
  $('#dsh-history-dialog').close();
  const name=await dialogs.text('重命名会话',conversations.selected?.title || '',{validate:value=>value?'':'请输入名称'});
  if(name)try{await conversations.rename(ui.conversationId,name);$('#dsh-conversation-title').textContent=name;}catch(error){showToast(error.message);}
});
$('#dsh-input').addEventListener('input',()=>{clearTimeout(conversationDraftTimer);conversationDraftTimer=setTimeout(()=>saveConversationDraft().catch(()=>{}),700);});
$('#dsh-retry').addEventListener('click',()=>{if(ui.dshBusy)return;$('#dsh-input').value=ui.lastDshPrompt || '';$('#dsh-form').requestSubmit();});

$$('[data-settings-page]').forEach((button) => button.addEventListener('click', () => {
  $$('[data-settings-page]').forEach((item) => item.classList.toggle('is-active', item === button));
  $$('[data-settings-section]').forEach((section) => section.hidden = section.dataset.settingsSection !== button.dataset.settingsPage);
}));
$('#settings-theme').addEventListener('change', (event) => {
  $('#app').dataset.theme = event.target.value;
  document.documentElement.dataset.theme = event.target.value;
  editorCoordinator.adapter.configure({ ...ui.settings, theme: event.target.value });
  mergeDiffView.configure({ theme: event.target.value });
});
$('#settings-editor-size').addEventListener('input', (event) => { $('#editor-size-value').value = event.target.value + ' px'; });
$('#settings-dsh-profile').addEventListener('change', (event) => {
  const profile = dshProfiles.find((item) => item.profileId === event.target.value) || null;
  if (profile) {
    ui.settings.gateway = profile.profileId;
    persistUi();
  }
  loadDshProfile(profile);
});
function selectorModelParts(value) {
  const [providerId, model] = String(value || '').split('\u0000');
  return { providerId: providerId || '', model: model || '' };
}
$('#dsh-provider-select').addEventListener('change', (event) => {
  const provider = officialDshCatalog.providers.find((item) => item.providerId === event.target.value);
  setOfficialSelection({ providerId: event.target.value, model: provider?.models[0]?.id || '', reasoningLevel: 'off' });
});
$('#dsh-model-select').addEventListener('change', (event) => {
  const next = selectorModelParts(event.target.value);
  setOfficialSelection(next);
});
$('#dsh-model-search').addEventListener('input', () => renderOfficialSelectors());
$('#dsh-reasoning-select').addEventListener('change', (event) => setOfficialSelection({ reasoningLevel: event.target.value }));
$('#settings-official-provider').addEventListener('change', (event) => {
  const provider = officialDshCatalog.providers.find((item) => item.providerId === event.target.value);
  setOfficialSelection({ providerId: event.target.value, model: provider?.models[0]?.id || '', reasoningLevel: 'off' });
});
$('#settings-official-model').addEventListener('change', (event) => setOfficialSelection(selectorModelParts(event.target.value)));
$('#settings-official-reasoning').addEventListener('change', (event) => setOfficialSelection({ reasoningLevel: event.target.value }));
$('#refresh-official-settings').addEventListener('click', () => refreshOfficialDsh().catch((error) => showToast('官方目录刷新失败：' + error.message)));
$('#open-official-settings').addEventListener('click', async () => {
  if (!dshGateway?.available) { showToast('浏览器预览没有内置 dsh 设置入口'); return; }
  try {
    const result = await dshGateway.openOfficialSettings({ timeoutMs: 8_000 });
    showToast(result?.opened ? '已打开 PythonA 模型设置' : (result?.message || '请在 PythonA 设置中配置模型'));
  } catch (error) {
    showToast('请在 PythonA 设置中配置 Provider 与模型');
  }
});
$('#settings-provider-kind').addEventListener('change', (event) => {
  const defaults = PROVIDER_DEFAULTS[event.target.value] || PROVIDER_DEFAULTS['openai-compatible'];
  $('#settings-provider-url').value = defaults.baseUrl;
  $('#settings-provider-model').value = defaults.model;
});
$('#save-provider').addEventListener('click', saveDshProvider);
$('#save-official-key').addEventListener('click', saveOfficialDshKey);
$('#test-provider').addEventListener('click', testDshProvider);
$('#delete-provider').addEventListener('click', deleteDshProvider);
$('#close-settings').addEventListener('click', () => closeSettings(false));
$('#cancel-settings').addEventListener('click', () => closeSettings(false));
$('#apply-settings').addEventListener('click', () => closeSettings(true));
$('#check-updates').addEventListener('click', () => showToast('尚未配置发布更新源'));
$('#export-diagnostics').addEventListener('click', () => {
  $('#diagnostics-json').value = JSON.stringify(diagnostics.snapshot(), null, 2);
  $('#download-diagnostics').hidden = nativeBroker.available;
  $('#diagnostics-dialog').showModal();
});
$('#copy-diagnostics').addEventListener('click', async () => {
  const input = $('#diagnostics-json');
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(input.value);
    else { input.select(); if (!document.execCommand('copy')) throw new Error('copy unavailable'); }
    showToast('性能诊断已复制');
  } catch (error) { input.focus(); input.select(); showToast('请长按所选 JSON 复制'); }
});
$('#download-diagnostics').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([$('#diagnostics-json').value], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'pythona-performance.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('#code-editor').addEventListener('beforeinput', () => {
  diagnostics.start('localCompletionMs');
  if (inputFramePending) return;
  inputFramePending = true;
  diagnostics.start('inputFrameMs');
  requestAnimationFrame(() => { inputFramePending = false; diagnostics.finish('inputFrameMs'); });
}, { capture: true });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    diagnostics.start('resumeFrameMs');
    requestAnimationFrame(() => diagnostics.finish('resumeFrameMs'));
  } else persistUi();
});

$('#command-button').addEventListener('click', () => $('#command-dialog').showModal());
$('#close-command').addEventListener('click', () => $('#command-dialog').close());
$('#command-search').addEventListener('input', (event) => {
  const query = event.target.value.toLowerCase();
  $$('#command-list button').forEach((button) => button.hidden = Boolean(query) && !button.textContent.toLowerCase().includes(query));
});
$$('#command-list button').forEach((button) => button.addEventListener('click', async () => {
  $('#command-dialog').close();
  await executeAction(button.dataset.command);
}));

setupResize($('#project-resize'), 'project');
setupResize($('#dsh-resize'), 'dsh');
const terminalResize=$('#terminal-resize');
let terminalDrag=null;
terminalResize.addEventListener('pointerdown',event=>{terminalDrag={y:event.clientY,height:$('#terminal-panel').getBoundingClientRect().height};terminalResize.setPointerCapture(event.pointerId);});
terminalResize.addEventListener('pointermove',event=>{if(!terminalDrag||!terminalResize.hasPointerCapture(event.pointerId))return;ui.terminalMaximized=false;ui.terminalHeight=Math.max(100,Math.min($('#body-grid').clientHeight-100,terminalDrag.height+terminalDrag.y-event.clientY));renderLayout();});
terminalResize.addEventListener('pointerup',event=>{terminalDrag=null;if(terminalResize.hasPointerCapture(event.pointerId))terminalResize.releasePointerCapture(event.pointerId);persistUi();});
terminalResize.addEventListener('keydown',event=>{if(!['ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();ui.terminalHeight=Math.max(100,Math.min(600,ui.terminalHeight+(event.key==='ArrowUp'?24:-24)));renderLayout();persistUi();});
$('#maximize-terminal').addEventListener('click',()=>{ui.terminalMaximized=!ui.terminalMaximized;renderLayout();persistUi();});
let fullViewportHeight=globalThis.visualViewport?.height || innerHeight;
globalThis.visualViewport?.addEventListener('resize',()=>{
  const height=visualViewport.height;fullViewportHeight=Math.max(fullViewportHeight,height);
  const keyboard=fullViewportHeight-height>130;
  $('#app').classList.toggle('keyboard-open',keyboard);
  if(keyboard && document.activeElement===editorCoordinator.adapter.view.contentDOM)editorCoordinator.adapter.view.requestMeasure();
});
if ('ResizeObserver' in globalThis) new ResizeObserver(renderLayout).observe($('#app'));

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase()==='s') {event.preventDefault();$('#save-all-button').click();}
  else if (event.ctrlKey && event.key.toLowerCase() === 's') { event.preventDefault(); executeAction('file.save'); }
  else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'a') { event.preventDefault(); $('#command-dialog').showModal(); }
  else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') { event.preventDefault(); executeAction('tool.dsh.toggle'); }
  else if (event.altKey && event.key === '1') { event.preventDefault(); executeAction('tool.project.toggle'); }
  else if (event.altKey && event.key === 'F12') { event.preventDefault(); executeAction('tool.console.open'); }
  else if (event.shiftKey && event.key === 'F10') { event.preventDefault(); executeAction('run.execute'); }
});

applyFontSettings();
renderStartupStatus();
$('#startup-retry')?.addEventListener('click', async () => {
  const button = $('#startup-retry');
  button.disabled = true;
  for (const service of ['runtime', 'dsh', 'language']) markStartup(service, 'retrying');
  try { await Promise.allSettled([runtime.refreshCapabilities({ timeoutMs: 120_000 }), refreshOfficialDsh({ quiet: true }), verifyLanguageReady()]); }
  finally { button.disabled = false; }
});
async function initializeApplication() {
  if (nativeBroker.available) {
    markStartup('runtime', 'pending', '正在启动 Runtime');
    markStartup('language', 'pending', '正在启动 Language');
    markStartup('dsh', 'pending', '正在准备官方 dsh');
    runtime.ready.then(capabilities => { const status = runtimeStartupState(capabilities); markStartup('runtime', status.state, status.detail); });
  }
  appendTerminal('PythonA 0.5.0 正在连接工作区…', 'info');
  refreshRuntimePackCapabilities().catch(() => {});
  refreshPythonPackageCapabilities().catch(() => {});
  tests.refreshCapabilities().catch(() => {});
  refreshOfficialDsh({ quiet: true }).catch(() => {});
  try {
    await store.ready;
    appendTerminal(store.mode === 'native'
      ? 'Android 私有工作区已连接（原生文件为权威数据）'
      : '浏览器预览工作区已就绪', 'info');
  } catch (error) {
    appendTerminal('原生工作区连接失败：' + error.message, 'error');
    showToast('原生工作区不可用，已停止写入');
    ui.initialized = true;
    renderAll();
    $('#save-button').disabled = true;
    $('#run-button').disabled = true;
    $('#new-file-button').disabled = true;
    return;
  }
  const editableFiles = store.listFiles().filter((file) => file.editable !== false);
  let recovered=[];
  try { recovered=await documentSession.recoverDrafts(); } catch(error) {showToast('草稿恢复失败：'+error.message);}
  const editablePaths = new Set(editableFiles.map((file) => file.path));
  if (!editablePaths.has(ui.activePath)) ui.activePath = editableFiles[0]?.path || null;
  ui.openTabs = ui.openTabs.filter((path) => editablePaths.has(path));
  for(const draft of recovered)if(!ui.openTabs.includes(draft.path))ui.openTabs.push(draft.path);
  if (ui.activePath && !ui.openTabs.includes(ui.activePath)) ui.openTabs.unshift(ui.activePath);
  const recoveredView = documentSession.snapshotFor(ui.activePath)?.viewState;
  const restoredOffset = recoveredView?.cursor ?? ui.cursorPositions[ui.activePath];
  if (ui.activePath) await documentSession.openAsync(ui.activePath);
  if (Number.isSafeInteger(restoredOffset)) editorCoordinator.goTo(Math.min(restoredOffset, documentSession.buffer.length));
  await Promise.all([projectModel.open(), runConfigurations.open()]);
  renderRunConfigurations();
  renderIndexStatus();
  ui.initialized = true;
  appendTerminal('Runtime mode: ' + runtime.mode, 'info');
  renderAll();
  if(recoveredView?.scroll){editorCoordinator.adapter.view.scrollDOM.scrollTop=recoveredView.scroll.top || 0;editorCoordinator.adapter.view.scrollDOM.scrollLeft=recoveredView.scroll.left || 0;}
  if(recovered.length)showToast(`已恢复 ${recovered.length} 份草稿${recovered.some(d=>d.conflict)?'，请检查外部冲突':''}`);
  if(conversations.available && ui.conversationId)await loadConversation(ui.conversationId).catch(error=>showToast('会话恢复失败：'+error.message));
  requestAnimationFrame(() => diagnostics.finish('webviewStartMs'));
  verifyLanguageReady().catch(error => markStartup('language', 'error', error));
  scheduleProjectIndex(300);
}

initializeApplication().catch((error) => appendTerminal('初始化失败：' + error.message, 'error'));
globalThis.addEventListener?.('beforeunload', () => {
  documentSession.flushDrafts().catch(()=>{});
  saveConversationDraft().catch(()=>{});
  inlineController.dispose();
  conversations.dispose();
  clearTimeout(diagnosticTimer);
  clearTimeout(indexTimer);
  clearTimeout(searchTimer);
  unsubscribeNativeStatus?.();
  unsubscribeStartupEvents?.();
  clearTimeout(cursorPersistTimer);
  persistUi();
  language.dispose();
  tests.dispose();
  runtime.dispose();
  dshGateway?.dispose?.();
  documentSession.dispose();
  store.dispose();
  nativeBroker.dispose();
});
document.addEventListener('visibilitychange',()=>{if(document.hidden){inlineController.invalidate('background');documentSession.flushDrafts().catch(()=>{});saveConversationDraft().catch(()=>{});}});
