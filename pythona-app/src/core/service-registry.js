export class ServiceRegistry {
  constructor() {
    this.entries = new Map();
  }

  register(kind, descriptor) {
    const type = String(kind || '').trim();
    const id = String(descriptor?.id || '').trim();
    if (!type || !id) throw new TypeError('Service kind and descriptor id are required');
    const bucket = this.entries.get(type) || new Map();
    if (bucket.has(id) && descriptor.replace !== true) {
      throw new Error(`Service already registered: ${type}/${id}`);
    }
    const value = Object.freeze({ ...descriptor, id, kind: type });
    bucket.set(id, value);
    this.entries.set(type, bucket);
    return () => bucket.delete(id);
  }

  get(kind, id) {
    return this.entries.get(String(kind))?.get(String(id)) || null;
  }

  list(kind) {
    return [...(this.entries.get(String(kind))?.values() || [])]
      .sort((left, right) => (left.order || 0) - (right.order || 0));
  }
}

export const SERVICE_KINDS = Object.freeze([
  'LanguageProvider',
  'CompletionProvider',
  'InspectionProvider',
  'QuickFixProvider',
  'RunConfigurationProvider',
  'ToolWindowProvider',
  'ActionProvider',
  'DshProvider'
]);

export function createDefaultServiceRegistry() {
  const registry = new ServiceRegistry();
  for (const [order, descriptor] of [
    { id: 'project', title: 'Project', icon: '▣' },
    { id: 'search', title: 'Search', icon: '⌕' },
    { id: 'problems', title: 'Problems', icon: '!' },
    { id: 'packages', title: 'Packages', icon: '◈' },
    { id: 'run', title: 'Run', icon: '▶' },
    { id: 'dsh', title: 'DSH', icon: '✦' },
    { id: 'python-console', title: 'Python Console', icon: '▤' },
    { id: 'settings', title: 'Settings', icon: '⚙' }
  ].entries()) registry.register('ToolWindowProvider', { ...descriptor, order });
  registry.register('LanguageProvider', { id: 'python-language', title: 'Python language service' });
  registry.register('CompletionProvider', { id: 'python-completion', title: 'Python completion' });
  registry.register('InspectionProvider', { id: 'python-syntax', title: 'Python syntax diagnostics' });
  registry.register('InspectionProvider', { id: 'workspace-style', title: 'Workspace TODO and indentation' });
  registry.register('QuickFixProvider', { id: 'workspace-safe-edits', title: 'Workspace safe edits' });
  registry.register('RunConfigurationProvider', { id: 'python', title: 'Python' });
  registry.register('DshProvider', { id: 'native-gateway', title: 'Native DSH gateway' });
  for (const [order, descriptor] of [
    { id: 'file.save', title: 'Save File', shortcut: 'Ctrl+S' },
    { id: 'run.execute', title: 'Run Configuration', shortcut: 'Shift+F10' },
    { id: 'run.stop', title: 'Stop' },
    { id: 'language.references', title: 'Find References', shortcut: 'Shift+F12' },
    { id: 'language.rename', title: 'Rename Symbol', shortcut: 'F2' },
    { id: 'tool.project.toggle', title: 'Toggle Project', shortcut: 'Alt+1' },
    { id: 'tool.dsh.toggle', title: 'Toggle DSH', shortcut: 'Ctrl+Shift+D' },
    { id: 'tool.console.open', title: 'Open Python Console', shortcut: 'Alt+F12' },
    { id: 'settings.open', title: 'Open Settings' }
  ].entries()) registry.register('ActionProvider', { ...descriptor, order });
  return registry;
}
