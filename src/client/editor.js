/**
 * SqlEditor — a lightweight syntax-highlighted editor.
 *
 * A transparent <textarea> sits on top of a Prism-highlighted <pre> with
 * identical metrics; the textarea handles input/selection, the <pre> handles
 * colour. No dependencies beyond prism-core + prism-sql (vendored).
 *
 *   const ed = new SqlEditor({ value, readOnly, onRun, onChange });
 *   container.append(ed.el);
 */
export class SqlEditor {
  constructor({ value = '', readOnly = false, onRun, onChange, placeholder = '-- Write SQL, then press ⌘/Ctrl + Enter' } = {}) {
    this.onRun = onRun;
    this.onChange = onChange;

    this.el = document.createElement('div');
    this.el.className = 'sql-editor';
    this.pre = document.createElement('pre');
    this.pre.setAttribute('aria-hidden', 'true');
    this.code = document.createElement('code');
    this.code.className = 'language-sql';
    this.pre.append(this.code);
    this.textarea = document.createElement('textarea');
    this.textarea.spellcheck = false;
    this.textarea.autocapitalize = 'off';
    this.textarea.autocomplete = 'off';
    this.textarea.setAttribute('aria-label', 'SQL editor');
    this.textarea.placeholder = placeholder;
    this.el.append(this.pre, this.textarea);

    this.textarea.addEventListener('input', () => {
      this.#render();
      this.onChange?.(this.value);
    });
    this.textarea.addEventListener('keydown', (e) => this.#onKey(e));
    this.textarea.addEventListener('scroll', () => (this.pre.scrollTop = this.textarea.scrollTop));

    this.readOnly = readOnly;
    this.value = value;
  }

  get value() {
    return this.textarea.value;
  }
  set value(v) {
    this.textarea.value = v ?? '';
    this.#render();
  }

  get readOnly() {
    return this.textarea.readOnly;
  }
  set readOnly(ro) {
    this.textarea.readOnly = ro;
    this.el.dataset.readonly = String(ro);
  }

  focus({ end = true } = {}) {
    this.textarea.focus();
    if (end) this.textarea.setSelectionRange(this.value.length, this.value.length);
  }

  #render() {
    const src = this.value;
    const Prism = globalThis.Prism;
    // Trailing newline keeps the last (empty) line's height in sync with the textarea.
    const text = src + '\n';
    if (Prism?.languages?.sql) {
      this.code.innerHTML = Prism.highlight(text, Prism.languages.sql, 'sql');
    } else {
      this.code.textContent = text;
    }
    // Auto-grow: the <pre> defines the height, the textarea just fills it.
    this.textarea.style.height = '';
    this.textarea.style.height = `${this.pre.offsetHeight}px`;
  }

  #onKey(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      this.onRun?.(this.value);
      return;
    }
    if (this.readOnly) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      this.#insert('  ');
    }
  }

  #insert(text) {
    const ta = this.textarea;
    const { selectionStart: s, selectionEnd: e } = ta;
    ta.setRangeText(text, s, e, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/** Static highlighted SQL (for read-only displays). */
export function highlightSql(sql) {
  const Prism = globalThis.Prism;
  if (Prism?.languages?.sql) return Prism.highlight(sql, Prism.languages.sql, 'sql');
  return sql.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}
