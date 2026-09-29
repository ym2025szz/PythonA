/*
 * Small, transport agnostic adapter for the official DSH/ACP model surface.
 *
 * The Android bridge can evolve independently of the WebView.  This module
 * accepts the provider/model shapes used by the current bridge and by the
 * official DSH catalog, then exposes one bounded shape to the UI.  Secrets are
 * deliberately not part of this shape: only hasKey/keyConfigured is retained.
 */

export const MAX_OFFICIAL_PROVIDERS = 64;
export const MAX_OFFICIAL_MODELS = 256;

const DEFAULT_REASONING_LEVELS = [];

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asString(value, fallback = '') {
  const result = String(value ?? '').trim();
  return result || fallback;
}

function boundedList(value, maximum) {
  return Array.isArray(value) ? value.slice(0, maximum) : [];
}

function normalizeCapabilities(value) {
  const source = asObject(value);
  const reasoning = source.reasoningLevels ?? source.reasoningEfforts ?? source.reasoning ?? source.thinkingLevels;
  const levels = boundedList(reasoning, 12).map((item) => {
    if (typeof item === 'string') return item.trim();
    const object = asObject(item);
    return asString(object.id || object.value || object.name);
  }).filter(Boolean);
  return {
    tools: source.tools !== false,
    streaming: source.streaming !== false,
    vision: Boolean(source.vision || source.image || source.multimodal),
    reasoningLevels: levels.length ? [...new Set(levels)] : DEFAULT_REASONING_LEVELS.slice()
  };
}

function normalizeModel(model, provider) {
  const object = typeof model === 'string' ? { id: model, name: model } : asObject(model);
  const id = asString(object.id || object.model || object.modelId || object.value);
  if (!id) return null;
  const capabilities = normalizeCapabilities(object.capabilities || object.features || object);
  const levels = boundedList(object.reasoningLevels ?? object.reasoningEfforts ?? object.reasoning ?? capabilities.reasoningLevels, 12)
    .map((item) => typeof item === 'string' ? item : asString(asObject(item).id || asObject(item).value || asObject(item).name))
    .filter(Boolean);
  return {
    id,
    name: asString(object.name || object.displayName || object.label || id, id),
    providerId: provider.providerId,
    providerKind: provider.providerKind,
    description: asString(object.description),
    contextWindow: Number(object.contextWindow || object.contextLength || 0) || null,
    capabilities: { ...provider.capabilities, ...capabilities,
      reasoningLevels: levels.length ? [...new Set(levels)] : capabilities.reasoningLevels },
    enabled: object.enabled !== false,
    official: object.official !== false
  };
}

function modelSource(provider) {
  const object = asObject(provider);
  if (Array.isArray(object.models)) return object.models;
  if (Array.isArray(object.modelCatalog)) return object.modelCatalog;
  if (Array.isArray(object.modelGroups)) return object.modelGroups.flatMap((group) => {
    const item = asObject(group);
    return Array.isArray(item.models) ? item.models : [];
  });
  return [];
}

function providerSource(payload) {
  const object = asObject(payload);
  if (Array.isArray(object.providers)) return object.providers;
  if (Array.isArray(object.providerCatalog)) return object.providerCatalog;
  if (Array.isArray(object.catalog)) return object.catalog;
  if (Array.isArray(object.models)) {
    const grouped = new Map();
    object.models.forEach((model) => {
      const item = asObject(model);
      const id = asString(item.providerId || item.provider || 'official');
      if (!grouped.has(id)) grouped.set(id, { providerId: id, displayName: id, official: true, models: [] });
      grouped.get(id).models.push(model);
    });
    return [...grouped.values()];
  }
  return [];
}

function normalizeProvider(provider, index) {
  const object = asObject(provider);
  const providerId = asString(object.providerId || object.id || object.profileId || object.kind, `provider-${index + 1}`);
  const result = {
    providerId,
    providerKind: asString(object.providerKind || object.kind || object.type, providerId),
    displayName: asString(object.displayName || object.name || object.label, providerId),
    baseUrl: asString(object.baseUrl || object.endpoint || object.defaultBaseUrl),
    hasKey: Boolean(object.hasKey || object.keyConfigured || object.configured),
    enabled: object.enabled !== false,
    official: object.official !== false,
    source: asString(object.source || object.origin, 'official'),
    capabilities: normalizeCapabilities(object.capabilities || object.features || object),
    models: []
  };
  const models = modelSource(object).map((model) => normalizeModel(model, result)).filter(Boolean);
  if (!models.length && (object.model || object.defaultModel)) {
    const model = normalizeModel(object.model || object.defaultModel, result);
    if (model) result.models.push(model);
  } else result.models = models;
  return result;
}

function profileProviders(profiles) {
  return boundedList(profiles, MAX_OFFICIAL_PROVIDERS).filter(profile => profile?.profileId !== 'direct-dsh').map((profile, index) => normalizeProvider({
    ...asObject(profile),
    providerId: profile?.profileId || profile?.providerId || `profile-${index + 1}`,
    source: 'compatibility',
    official: false,
    modelCatalog: profile?.models || (profile?.model ? [profile.model] : [])
  }, index));
}

/** Convert bridge/catalog responses into a stable UI model. */
export function normalizeOfficialCatalog(payload = {}, options = {}) {
  const object = asObject(payload);
  const officialSource = providerSource(object);
  const officialProviders = boundedList(officialSource, MAX_OFFICIAL_PROVIDERS).map(normalizeProvider);
  const fallbackProviders = profileProviders(options.profiles || object.profiles || []);
  const providers = [...officialProviders, ...fallbackProviders]
    .filter((provider, index, list) => list.findIndex((item) => item.providerId === provider.providerId) === index)
    .slice(0, MAX_OFFICIAL_PROVIDERS);
  const models = providers.flatMap((provider) => provider.models).slice(0, MAX_OFFICIAL_MODELS);
  const selectedObject = asObject(object.selected || object.selection || object.current);
  const selected = {
    providerId: asString(selectedObject.providerId || selectedObject.profileId || selectedObject.provider || object.providerId || options.providerId),
    model: asString(selectedObject.model || selectedObject.modelId || object.model || options.model),
    reasoningLevel: asString(selectedObject.reasoningLevel || selectedObject.reasoningEffort || selectedObject.thinking || object.reasoningLevel || options.reasoningLevel, 'off')
  };
  const resolvedProvider = providers.find((provider) => provider.providerId === selected.providerId) || providers.find((provider) => provider.enabled);
  if (!selected.providerId && resolvedProvider) selected.providerId = resolvedProvider.providerId;
  const resolvedModel = resolvedProvider?.models.find((model) => model.id === selected.model)
    || resolvedProvider?.models.find((model) => model.enabled)
    || models.find((model) => model.id === selected.model);
  if (!selected.model && resolvedModel) selected.model = resolvedModel.id;
  const capabilities = asObject(object.capabilities);
  return {
    protocol: asString(object.protocol || object.protocolVersion, 'acp'),
    version: asString(object.version || object.bridgeVersion || object.dshVersion),
    official: object.official === true || object.mode === 'official' || object.source === 'official-dsh' || officialProviders.some((provider) => provider.official),
    connected: object.connected !== false,
    status: asString(object.status, object.connected === false ? 'disconnected' : 'ready'),
    keyConfigured: Boolean(object.keyConfigured),
    providers,
    models,
    selected,
    capabilities: {
      sessions: capabilities.sessions !== false,
      permissions: capabilities.permissions !== false,
      cancellation: capabilities.cancellation !== false,
      tools: capabilities.tools !== false,
      streaming: capabilities.streaming !== false
    }
  };
}

export function findOfficialModel(catalog, providerId, modelId) {
  const providers = catalog?.providers || [];
  const provider = providers.find((item) => item.providerId === providerId) || providers.find((item) => item.enabled);
  const model = provider?.models.find((item) => item.id === modelId)
    || provider?.models.find((item) => item.enabled)
    || catalog?.models?.find((item) => item.id === modelId);
  return { provider: provider || null, model: model || null };
}

export function modelReasoningLevels(model, provider = null) {
  const levels = model?.capabilities?.reasoningLevels || provider?.capabilities?.reasoningLevels;
  return levels?.length ? [...new Set(levels)] : DEFAULT_REASONING_LEVELS.slice();
}

/** Small observable state machine used to reject events from a restarted DSH. */
export function createOfficialDshState(initial = {}) {
  let generation = 0;
  const listeners = new Set();
  const state = {
    status: 'disconnected',
    catalog: normalizeOfficialCatalog({}, { profiles: [] }),
    generation,
    ...initial
  };
  const emit = () => listeners.forEach((listener) => listener({ ...state, catalog: state.catalog }));
  return {
    get value() { return { ...state, catalog: state.catalog }; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    beginConnection() { generation += 1; state.generation = generation; state.status = 'connecting'; emit(); return generation; },
    applyCatalog(payload, options = {}, eventGeneration = generation) {
      if (eventGeneration !== generation) return false;
      state.catalog = normalizeOfficialCatalog(payload, options);
      state.status = state.catalog.connected ? 'ready' : 'disconnected';
      emit();
      return true;
    },
    applySelection(selection, eventGeneration = generation) {
      if (eventGeneration !== generation) return false;
      const next = { ...state.catalog.selected, ...asObject(selection) };
      state.catalog = { ...state.catalog, selected: next };
      emit();
      return true;
    },
    disconnected(eventGeneration = generation) {
      if (eventGeneration !== generation) return false;
      state.status = 'disconnected';
      state.catalog = { ...state.catalog, connected: false, status: 'disconnected' };
      emit();
      return true;
    }
  };
}
