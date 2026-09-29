export class AppDialogs {
  constructor(document = globalThis.document) { this.document = document; this.active = null; }
  get open() { return Boolean(this.active?.open); }
  confirm(title, detail, confirmLabel = '继续') { return this.show({ title, detail, confirmLabel }).then(value => value === true); }
  text(title, value = '', options = {}) { return this.show({ title, value, ...options, input: true }); }
  show({ title, detail = '', value = '', input = false, confirmLabel = '确定', validate = () => '', danger = false }) {
    if (this.open) return Promise.resolve(null);
    const doc = this.document, dialog = doc.createElement('dialog');
    dialog.className = 'app-dialog';
    const form = doc.createElement('form'); form.method = 'dialog';
    const heading = doc.createElement('h2'); heading.textContent = title; heading.id = 'app-dialog-title';
    dialog.setAttribute('aria-labelledby', heading.id);
    const description = doc.createElement('p'); description.textContent = detail; description.className = 'dialog-detail';
    const field = doc.createElement('input'); field.className = 'text-input'; field.value = value; field.setAttribute('aria-label', title); field.autocomplete = 'off';
    const error = doc.createElement('p'); error.className = 'field-error'; error.setAttribute('role', 'alert');
    const actions = doc.createElement('div'); actions.className = 'dialog-actions';
    const cancel = doc.createElement('button'); cancel.type = 'button'; cancel.className = 'text-button'; cancel.textContent = '取消';
    const submit = doc.createElement('button'); submit.type = 'submit'; submit.className = danger ? 'primary-button danger-button' : 'primary-button'; submit.textContent = confirmLabel;
    actions.append(cancel, submit); form.append(heading, description); if (input) form.append(field); form.append(error, actions); dialog.append(form); doc.body.append(dialog);
    this.active = dialog; let result = null;
    return new Promise(resolve => {
      cancel.addEventListener('click', () => dialog.close());
      form.addEventListener('submit', event => {
        event.preventDefault(); const candidate = input ? field.value.trim() : true;
        const issue = validate(candidate);
        if (issue) { error.textContent = issue; field.setAttribute('aria-invalid', 'true'); field.focus(); return; }
        result = candidate; dialog.close();
      });
      dialog.addEventListener('close', () => { this.active = null; dialog.remove(); resolve(result); }, { once: true });
      dialog.showModal();
      if (input) { field.focus(); field.select(); } else cancel.focus();
    });
  }
}

export function validateWorkspacePath(path) {
  if (!path || path.length > 1024 || /[\\\u0000-\u001f:]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) return '请输入工作区内的相对路径，例如 src/example.py';
  return '';
}
