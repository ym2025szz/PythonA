/* Defensive compatibility helpers for the WebView 93 floor enforced by MainActivity.
 * Keep these deliberately small and standards-shaped; modern WebViews take
 * the native fast path. */
const root = typeof globalThis !== 'undefined'
  ? globalThis
  : (typeof self !== 'undefined' ? self : window);

if (!root.globalThis) root.globalThis = root;

if (!Promise.prototype.finally) {
  Object.defineProperty(Promise.prototype, 'finally', {
    configurable: true,
    writable: true,
    value(callback) {
      const constructor = this.constructor || Promise;
      return this.then(
        (value) => constructor.resolve(callback()).then(() => value),
        (reason) => constructor.resolve(callback()).then(() => { throw reason; })
      );
    }
  });
}

if (!Promise.allSettled) {
  Promise.allSettled = (values) => Promise.all(Array.from(values, (value) => Promise.resolve(value).then(
    (result) => ({ status: 'fulfilled', value: result }),
    (reason) => ({ status: 'rejected', reason })
  )));
}

if (!Object.fromEntries) {
  Object.fromEntries = (entries) => {
    const result = {};
    for (const [key, value] of entries) result[key] = value;
    return result;
  };
}

if (!Array.prototype.flatMap) {
  Object.defineProperty(Array.prototype, 'flatMap', {
    configurable: true,
    writable: true,
    value(callback, thisArg) {
      return this.reduce((result, value, index, array) => (
        result.concat(callback.call(thisArg, value, index, array))
      ), []);
    }
  });
}

if (!String.prototype.replaceAll) {
  Object.defineProperty(String.prototype, 'replaceAll', {
    configurable: true,
    writable: true,
    value(search, replacement) {
      if (search instanceof RegExp) {
        if (!search.global) throw new TypeError('replaceAll RegExp must be global');
        return this.replace(search, replacement);
      }
      return this.split(String(search)).join(String(replacement));
    }
  });
}

if (!String.prototype.matchAll) {
  Object.defineProperty(String.prototype, 'matchAll', {
    configurable: true,
    writable: true,
    value(pattern) {
      const input = String(this);
      let expression = pattern;
      if (!(expression instanceof RegExp)) expression = new RegExp(String(expression), 'g');
      if (!expression.global) throw new TypeError('matchAll RegExp must be global');
      const matcher = new RegExp(expression.source, expression.flags);
      matcher.lastIndex = expression.lastIndex;
      const iterator = {
        next() {
          const match = matcher.exec(input);
          if (!match) return { value: undefined, done: true };
          if (match[0] === '') {
            const index = matcher.lastIndex;
            const first = input.charCodeAt(index);
            const second = input.charCodeAt(index + 1);
            matcher.lastIndex += matcher.unicode
              && first >= 0xD800 && first <= 0xDBFF
              && second >= 0xDC00 && second <= 0xDFFF
              ? 2
              : 1;
          }
          return { value: match, done: false };
        }
      };
      if (typeof Symbol !== 'undefined' && Symbol.iterator) {
        iterator[Symbol.iterator] = () => iterator;
      }
      return iterator;
    }
  });
}

if (root.Element && !root.Element.prototype.replaceChildren) {
  Object.defineProperty(root.Element.prototype, 'replaceChildren', {
    configurable: true,
    writable: true,
    value(...children) {
      while (this.firstChild) this.removeChild(this.firstChild);
      for (const child of children) {
        this.appendChild(child instanceof root.Node
          ? child
          : this.ownerDocument.createTextNode(String(child)));
      }
    }
  });
}

if (root.HTMLFormElement && !root.HTMLFormElement.prototype.requestSubmit) {
  Object.defineProperty(root.HTMLFormElement.prototype, 'requestSubmit', {
    configurable: true,
    writable: true,
    value(submitter) {
      if (submitter != null) {
        if (submitter.form !== this) throw new root.DOMException('The submitter is not owned by this form', 'NotFoundError');
        submitter.click();
        return;
      }
      const button = this.ownerDocument.createElement('button');
      button.type = 'submit';
      button.hidden = true;
      this.appendChild(button);
      button.click();
      this.removeChild(button);
    }
  });
}

if (!root.queueMicrotask) {
  root.queueMicrotask = (callback) => Promise.resolve().then(callback).catch((error) => {
    setTimeout(() => { throw error; }, 0);
  });
}

if (!root.AbortController) {
  class CompatAbortSignal {
    constructor() {
      this.aborted = false;
      this.reason = undefined;
      this.listeners = new Set();
    }
    addEventListener(type, listener) {
      if (type === 'abort' && typeof listener === 'function') this.listeners.add(listener);
    }
    removeEventListener(type, listener) {
      if (type === 'abort') this.listeners.delete(listener);
    }
    dispatch() {
      for (const listener of [...this.listeners]) listener.call(this, { type: 'abort', target: this });
      this.listeners.clear();
    }
  }
  root.AbortController = class AbortController {
    constructor() { this.signal = new CompatAbortSignal(); }
    abort(reason) {
      if (this.signal.aborted) return;
      this.signal.aborted = true;
      this.signal.reason = reason;
      this.signal.dispatch();
    }
  };
}

if (!root.ResizeObserver) {
  root.ResizeObserver = class ResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Map();
      this.timer = null;
      this.check = () => {
        const entries = [];
        for (const [target, previous] of this.targets) {
          const rect = target.getBoundingClientRect();
          if (!previous || rect.width !== previous.width || rect.height !== previous.height) {
            this.targets.set(target, { width: rect.width, height: rect.height });
            entries.push({ target, contentRect: rect });
          }
        }
        if (entries.length) this.callback(entries, this);
      };
    }
    observe(target) {
      this.targets.set(target, null);
      this.check();
      if (!this.timer) this.timer = setInterval(this.check, 250);
    }
    unobserve(target) {
      this.targets.delete(target);
      if (!this.targets.size) this.disconnect();
    }
    disconnect() {
      this.targets.clear();
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    }
  };
}
