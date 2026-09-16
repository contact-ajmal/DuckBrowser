/**
 * Hash router — three views in one page.
 *
 *   #/                  Overview (schema + auto-generated profile of the active dataset)
 *   #/query             SQL query tool
 *   #/docs/<slug>       Documentation page
 *
 * Optional `?ds=<id>` selects a dataset. Views are plain <section data-view>
 * elements; only one is visible. Keeping everything on one page means the
 * DuckDB worker and any dropped-in files survive navigation.
 */
export class Router {
  #views = new Map();
  #current = null;

  constructor() {
    for (const el of document.querySelectorAll('section.view[data-view]')) this.#views.set(el.dataset.view, { el, onShow: null, onHide: null });
    window.addEventListener('hashchange', () => this.#apply());
  }

  /** Register lifecycle hooks for a view. */
  on(view, { onShow, onHide } = {}) {
    const v = this.#views.get(view);
    if (v) Object.assign(v, { onShow, onHide });
    return this;
  }

  start() {
    if (!location.hash) history.replaceState(null, '', '#/');
    this.#apply();
  }

  /** Current route: { view, param, params } */
  get route() {
    return Router.parse(location.hash);
  }

  static parse(hash) {
    const raw = (hash || '#/').replace(/^#/, '') || '/';
    const url = new URL(raw, 'http://q');
    const [, first = '', param = ''] = url.pathname.split('/');
    const view = first === '' ? 'home' : first;
    return { view, param: decodeURIComponent(param), params: url.searchParams };
  }

  go(path, params = {}) {
    const url = new URL(path, 'http://q');
    for (const [k, v] of Object.entries(params)) {
      if (v == null || v === '') url.searchParams.delete(k);
      else url.searchParams.set(k, v);
    }
    location.hash = `#${url.pathname}${url.search}`;
  }

  /** Update a query param on the current route without triggering a re-render. */
  setParam(key, value) {
    const url = new URL((location.hash || '#/').slice(1), 'http://q');
    if (value == null || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, value);
    history.replaceState(null, '', `#${url.pathname}${url.search}`);
  }

  #apply() {
    const route = this.route;
    const view = this.#views.has(route.view) ? route.view : 'home';
    const changed = this.#current !== view;
    if (this.#current && changed) {
      const prev = this.#views.get(this.#current);
      prev.el.hidden = true;
      prev.onHide?.();
    }
    const next = this.#views.get(view);
    next.el.hidden = false;
    this.#current = view;
    for (const a of document.querySelectorAll('[data-route]')) {
      const active = a.dataset.route === view;
      a.classList.toggle('is-active', active);
      if (active) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    next.onShow?.(route, { changed });
    if (changed) window.scrollTo({ top: 0 });
  }
}
