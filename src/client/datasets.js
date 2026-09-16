/**
 * Sidebar: your datasets (drag-and-drop / file picker), plus the bundled
 * sample datasets, which are listed but only mounted on request.
 */
import { FORMAT_LABEL, formatFromFilename } from './engine.js';
import { fmtBytes, escapeHtml } from './format.js';
import { toast } from './toast.js';

const isSqlFile = (file) => /\.(sql|txt)$/i.test(file.name);

export class DatasetPanel {
  constructor({ engine, listEl, countEl, dropzoneEl, inputEl, samplesEl, sampleListEl, loadAllEl, samples = [], onSelect, onDrop, onSqlFiles }) {
    this.engine = engine;
    this.listEl = listEl;
    this.countEl = countEl;
    this.dropzoneEl = dropzoneEl;
    this.inputEl = inputEl;
    this.samplesEl = samplesEl;
    this.sampleListEl = sampleListEl;
    this.loadAllEl = loadAllEl;
    this.samples = samples;
    this.onSelect = onSelect;
    this.onDrop = onDrop || onSelect;
    this.onSqlFiles = onSqlFiles;
    this.activeId = null;
    this.#loading = new Set();

    engine.on('dataset:change', () => this.render());
    engine.on('dataset:removed', () => this.render());
    engine.on('dataset:active', (rec) => {
      this.activeId = rec?.id ?? null;
      this.render();
    });

    this.#wireDropzone();
    this.loadAllEl?.addEventListener('click', () => this.loadAllSamples());
    this.sampleListEl?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sample]');
      if (btn) this.loadSample(btn.dataset.sample);
    });
    this.render();
  }

  #loading;

  /** Mount a bundled sample by id and make it active. */
  async loadSample(id, { select = true } = {}) {
    const ds = this.samples.find((s) => s.id === id);
    if (!ds || this.engine.datasets.has(id) || this.#loading.has(id)) return this.engine.datasets.get(id) ?? null;
    this.#loading.add(id);
    this.render();
    try {
      const rec = await this.engine.mount(ds);
      if (select) this.onSelect(rec.id);
      return rec;
    } catch (err) {
      console.error('[DuckView] failed to load sample', id, err);
      toast(`Could not load sample ${ds.file}`, { tone: 'error', detail: err.message });
      return null;
    } finally {
      this.#loading.delete(id);
      this.render();
    }
  }

  async loadAllSamples() {
    let first = null;
    for (const s of this.samples) {
      const rec = await this.loadSample(s.id, { select: false });
      first ??= rec?.id ?? null;
    }
    if (first && !this.engine.activeId) this.onSelect(first);
  }

  render() {
    const datasets = [...this.engine.datasets.values()];
    this.countEl.textContent = datasets.length ? `${datasets.length}` : '';
    this.listEl.innerHTML = datasets.length
      ? datasets.map((d) => this.#datasetRow(d)).join('')
      : `<li class="px-4 py-3 text-xs text-zinc-500">Nothing loaded yet — drop a file above${this.samples.length ? ' or pick a sample below' : ''}.</li>`;
    this.listEl.onclick = (e) => {
      const remove = e.target.closest('[data-remove]');
      if (remove) {
        e.stopPropagation();
        this.engine.unmount(remove.dataset.remove);
        return;
      }
      const btn = e.target.closest('button[data-id]');
      if (btn && !btn.disabled) this.onSelect(btn.dataset.id);
    };
    this.#renderSamples();
  }

  #datasetRow(d) {
    const active = d.id === this.activeId;
    const dot =
      d.state === 'ready'
        ? '<span class="size-1.5 rounded-full bg-emerald-400"></span>'
        : d.state === 'error'
          ? '<span class="size-1.5 rounded-full bg-rose-400"></span>'
          : '<span class="spinner"></span>';
    const meta = d.state === 'error' ? `<span class="text-rose-400" title="${escapeHtml(d.error)}">failed — ${escapeHtml(d.error)}</span>` : `${FORMAT_LABEL[d.format] ?? d.format} · ${fmtBytes(d.size)}${d.schema ? ` · ${d.schema.length} cols` : ''}`;
    return `
      <li>
        <button type="button" data-id="${escapeHtml(d.id)}" ${d.state !== 'ready' ? 'disabled' : ''}
          class="group flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition-colors ${active ? 'bg-violet-500/10' : 'hover:bg-zinc-800/50'} disabled:cursor-wait"
          aria-current="${active ? 'true' : 'false'}">
          <span class="mt-1.5 flex w-2 shrink-0 justify-center">${dot}</span>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-1.5">
              <span class="truncate font-mono text-xs ${active ? 'text-violet-200' : 'text-zinc-200'}">${escapeHtml(d.id)}</span>
              <span class="badge ${d.source === 'local' ? 'badge-violet' : 'badge-zinc'}">${d.source === 'local' ? 'yours' : 'sample'}</span>
            </span>
            <span class="block truncate text-[11px] text-zinc-500">${meta}</span>
          </span>
          <span role="button" tabindex="0" data-remove="${escapeHtml(d.id)}" title="Unload" class="mt-0.5 hidden rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-rose-300 group-hover:block">
            <svg class="size-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path stroke-linecap="round" d="m6 6 8 8m0-8-8 8"/></svg>
          </span>
        </button>
      </li>`;
  }

  #renderSamples() {
    if (!this.samplesEl || !this.sampleListEl) return;
    const pending = this.samples.filter((s) => !this.engine.datasets.has(s.id));
    this.samplesEl.hidden = this.samples.length === 0;
    if (this.loadAllEl) this.loadAllEl.hidden = pending.length === 0;
    if (!pending.length) {
      this.sampleListEl.innerHTML = `<li class="px-4 py-2.5 text-[11px] text-zinc-500">All samples are loaded.</li>`;
      return;
    }
    this.sampleListEl.innerHTML = pending
      .map(
        (s) => `
        <li class="flex items-center gap-2 px-4 py-2">
          <span class="min-w-0 flex-1">
            <span class="block truncate font-mono text-xs text-zinc-300">${escapeHtml(s.file)}</span>
            <span class="block text-[11px] text-zinc-500">${escapeHtml(FORMAT_LABEL[s.format] ?? s.format)} · ${fmtBytes(s.size)}</span>
          </span>
          <button type="button" data-sample="${escapeHtml(s.id)}" class="btn btn-ghost h-6 px-2 text-[11px]" ${this.#loading.has(s.id) ? 'disabled' : ''}>${this.#loading.has(s.id) ? '<span class="spinner"></span>' : 'Load'}</button>
        </li>`,
      )
      .join('');
  }

  #wireDropzone() {
    const dz = this.dropzoneEl;
    let depth = 0;
    const isFileDrag = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');

    document.addEventListener('dragenter', (e) => {
      if (!isFileDrag(e)) return;
      depth++;
      document.body.classList.add('is-dragging-file');
    });
    document.addEventListener('dragleave', () => {
      if (--depth <= 0) {
        depth = 0;
        document.body.classList.remove('is-dragging-file');
      }
    });
    document.addEventListener('dragover', (e) => {
      if (isFileDrag(e)) e.preventDefault();
    });
    document.addEventListener('drop', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('is-dragging-file');
      dz.classList.remove('is-dragging');
      this.ingest([...e.dataTransfer.files]);
    });
    dz.addEventListener('dragover', () => dz.classList.add('is-dragging'));
    dz.addEventListener('dragleave', () => dz.classList.remove('is-dragging'));
    this.inputEl.addEventListener('change', () => {
      this.ingest([...this.inputEl.files]);
      this.inputEl.value = '';
    });
  }

  /** Data files become datasets; .sql files go to the query workbench. */
  async ingest(files) {
    const sqlFiles = files.filter(isSqlFile);
    const dataFiles = files.filter((f) => !isSqlFile(f));
    let first = null;
    for (const file of dataFiles) {
      if (!formatFromFilename(file.name)) {
        toast(`Unsupported file type: ${file.name}`, { tone: 'error', detail: 'Supported: .parquet .csv .tsv .json .ndjson .jsonl .arrow .feather .ipc — and .sql for queries.' });
        continue;
      }
      try {
        const rec = await this.engine.mountLocalFile(file);
        first ??= rec.id;
      } catch (err) {
        console.error('[DuckView] failed to mount', file.name, err);
        toast(`Could not load ${file.name}`, { tone: 'error', detail: err.message });
      }
    }
    if (first) this.onDrop(first);
    if (sqlFiles.length) this.onSqlFiles?.(sqlFiles);
  }
}
