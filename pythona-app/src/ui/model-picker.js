export class ModelPicker {
  constructor({ dialog, button, onSelect, onRefresh, onManage }) {
    Object.assign(this, { dialog, button, onSelect, onRefresh, onManage }); this.catalog = {}; this.recent = []; this.focusIndex = 0;
    this.search = dialog.querySelector('[data-model-search]'); this.list = dialog.querySelector('[data-model-list]'); this.reasoning = dialog.querySelector('[data-model-reasoning]');
    button.addEventListener('click', () => this.open());
    dialog.querySelector('[data-model-close]').addEventListener('click', () => dialog.close());
    this.search.addEventListener('input', () => { this.focusIndex = 0; this.render(); });
    this.reasoning.addEventListener('change', () => this.onSelect({ reasoningLevel: this.reasoning.value }));
    dialog.querySelector('[data-model-refresh]').addEventListener('click', async event => { event.target.disabled = true; try { await onRefresh(); } finally { event.target.disabled = false; } });
    dialog.querySelector('[data-model-manage]').addEventListener('click', () => { dialog.close(); onManage(); });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') return;
      if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key) || event.target === this.reasoning) return;
      const rows = [...this.list.querySelectorAll('[data-model-option]')]; if (!rows.length) return;
      if (event.key === 'Enter' && event.target === this.search) { event.preventDefault(); rows[this.focusIndex]?.click(); return; }
      if (event.key === 'Enter') return;
      event.preventDefault(); const focused = rows.indexOf(dialog.ownerDocument.activeElement);
      this.focusIndex = focused < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1) : (focused + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      rows[this.focusIndex].focus(); rows[this.focusIndex].scrollIntoView({ block:'nearest' });
    });
  }
  update(catalog, recent = this.recent) {
    this.catalog = catalog || {}; this.recent = recent;
    const selected = this.catalog.selected || {}, provider = this.catalog.providers?.find(p => p.providerId === selected.providerId), model = provider?.models.find(m => m.id === selected.model);
    const label = model?.name || selected.model || '选择模型';
    this.button.querySelector('span').textContent = label.split('/').at(-1);
    this.button.title = [provider?.displayName, label, selected.reasoningLevel].filter(Boolean).join(' · ');
    this.button.setAttribute('aria-label', `选择模型，当前 ${label}`);
    if (this.dialog.open) this.render();
  }
  open() {
    this.search.value = ''; this.render(); this.dialog.showModal();
    // Opening with touch must not summon the keyboard until search is tapped.
    this.dialog.querySelector('[data-model-close]').focus({ preventScroll:true });
  }
  render() {
    const doc = this.dialog.ownerDocument, selected = this.catalog.selected || {}, query = this.search.value.trim().toLocaleLowerCase();
    this.list.replaceChildren(); const flattened = [];
    for (const provider of this.catalog.providers || []) for (const model of provider.models || []) if (model.enabled !== false) flattened.push({ provider, model });
    const matches = flattened.filter(({provider,model}) => `${provider.displayName} ${model.name} ${model.id}`.toLocaleLowerCase().includes(query));
    const addGroup = (title, items) => {
      if (!items.length) return; const heading = doc.createElement('h3'); heading.textContent = title; this.list.append(heading);
      for (const {provider,model} of items) {
        const row = doc.createElement('button'); row.type = 'button'; row.className = 'model-option'; row.dataset.modelOption = model.id; row.setAttribute('role','option');
        row.setAttribute('aria-selected', String(selected.providerId === provider.providerId && selected.model === model.id));
        const name = doc.createElement('strong'); name.textContent = model.name || model.id;
        const detail = doc.createElement('span'); detail.textContent = `${model.id} · ${provider.hasKey ? 'Key 已配置' : 'Key 未配置'}${provider.official ? '' : ' · 兼容模式'}`;
        const features = doc.createElement('small'); features.textContent = [model.capabilities?.tools ? '工具' : '', model.capabilities?.vision ? '图像' : '', model.contextWindow ? `${model.contextWindow.toLocaleString()} 上下文` : ''].filter(Boolean).join(' · ');
        row.append(name,detail,features); row.addEventListener('click', () => { this.onSelect({providerId:provider.providerId,model:model.id,reasoningLevel:selected.providerId===provider.providerId && selected.model===model.id ? selected.reasoningLevel : 'off'}); this.dialog.close(); });
        this.list.append(row);
      }
    };
    if (!query) addGroup('最近使用', this.recent.map(key => flattened.find(item => `${item.provider.providerId}\u0000${item.model.id}` === key)).filter(Boolean).slice(0,5));
    for (const provider of this.catalog.providers || []) addGroup(provider.displayName, matches.filter(item => item.provider === provider));
    if (!matches.length) { const empty = doc.createElement('p'); empty.className = 'empty-state'; empty.textContent = query ? '没有匹配的模型' : '模型目录尚未就绪，可刷新或配置 Provider'; this.list.append(empty); }
    const active = flattened.find(item => item.provider.providerId === selected.providerId && item.model.id === selected.model);
    const levels = active?.model.capabilities?.reasoningLevels || [];
    this.reasoning.replaceChildren(...levels.map(level => new Option(({off:'关闭',low:'低',medium:'中',high:'高'})[level] || level, level)));
    this.reasoning.disabled = levels.length < 2; this.reasoning.value = selected.reasoningLevel || 'off';
    this.reasoning.parentElement.hidden = !levels.length;
  }
}
