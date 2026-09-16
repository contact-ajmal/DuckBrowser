/**
 * Docs view — page 3.
 *
 * All Markdown pages are embedded in the shell as hidden <article data-doc>
 * elements. This view shows one, builds a sidebar (page list + table of
 * contents for the visible page) and runs that page's live cards on first
 * show, so hidden docs don't burn engine time.
 */
import { escapeHtml } from './format.js';

export class Docs {
  #current = null;

  constructor({ root, sidebarRoot, pages, router }) {
    this.root = root;
    this.sidebarRoot = sidebarRoot;
    this.pages = pages;
    this.router = router;
    this.articles = new Map([...root.querySelectorAll('article[data-doc]')].map((a) => [a.dataset.doc, a]));
  }

  /** Router hook. `slug` empty → first page. */
  show(slug) {
    const target = this.articles.has(slug) ? slug : this.pages[0]?.slug;
    if (!target) {
      this.root.innerHTML = `<div class="card px-6 py-16 text-center text-sm text-zinc-500">No documentation pages found in <code>content/</code>.</div>`;
      return;
    }
    if (slug !== target) {
      this.router.go(`/docs/${target}`);
      return;
    }
    for (const [id, el] of this.articles) el.hidden = id !== target;
    const article = this.articles.get(target);
    const first = this.#current !== target;
    this.#current = target;
    this.#renderSidebar(target, article);
    for (const card of article.querySelectorAll('duck-query')) {
      card.runIfDeferred?.();
      card.onShown?.();
    }
    if (first) document.title = `${article.dataset.title} · ${window.__DUCKVIEW__?.title ?? 'Duckview'}`;
  }

  #renderSidebar(slug, article) {
    const headings = [...article.querySelectorAll('h2[id], h3[id]')].filter((h) => !h.closest('duck-query'));
    const toc = headings
      .map((h) => {
        const depth = h.tagName === 'H3' ? 'pl-6 text-zinc-500' : 'pl-3 text-zinc-400';
        return `<li><a href="#/docs/${escapeHtml(slug)}?h=${encodeURIComponent(h.id)}" data-heading="${escapeHtml(h.id)}" class="block truncate rounded py-1 pr-2 text-[12px] leading-5 transition-colors hover:text-zinc-100 ${depth}">${escapeHtml(h.textContent)}</a></li>`;
      })
      .join('');
    this.sidebarRoot.innerHTML = `
      <section class="card">
        <header class="border-b border-zinc-800 px-4 py-3">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-zinc-400">Documentation</h2>
        </header>
        <ul class="py-1">
          ${this.pages
            .map(
              (p) =>
                `<li><a href="#/docs/${escapeHtml(p.slug)}" class="block px-4 py-1.5 text-sm transition-colors ${p.slug === slug ? 'bg-violet-500/10 text-violet-200' : 'text-zinc-300 hover:bg-zinc-800/50 hover:text-zinc-100'}">${escapeHtml(p.title)}</a></li>`,
            )
            .join('')}
        </ul>
      </section>
      ${
        toc
          ? `<section class="card">
        <header class="border-b border-zinc-800 px-4 py-3">
          <h2 class="text-xs font-semibold uppercase tracking-wider text-zinc-400">On this page</h2>
        </header>
        <ul class="py-2 pr-1">${toc}</ul>
      </section>`
          : ''
      }`;
    // Smooth-scroll TOC links inside the SPA (the hash already encodes the page).
    this.sidebarRoot.querySelectorAll('[data-heading]').forEach((a) =>
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const h = article.querySelector(`#${CSS.escape(a.dataset.heading)}`);
        h?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        this.router.setParam('h', a.dataset.heading);
      }),
    );
  }

  /** Scroll to a heading requested via ?h= */
  scrollToHeading(id) {
    if (!id || !this.#current) return;
    const h = this.articles.get(this.#current)?.querySelector(`#${CSS.escape(id)}`);
    if (h) requestAnimationFrame(() => h.scrollIntoView({ block: 'start' }));
  }
}
