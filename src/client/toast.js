/**
 * Minimal toast notifications (bottom-right). Used for things that happen
 * off-screen — a dropped file that failed to mount, an import result.
 */
import { escapeHtml } from './format.js';

let host = null;
function ensureHost() {
  if (host) return host;
  host = document.createElement('div');
  host.id = 'toasts';
  host.className = 'pointer-events-none fixed right-4 bottom-4 z-[70] flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-2';
  host.setAttribute('aria-live', 'polite');
  document.body.append(host);
  return host;
}

const TONES = {
  error: 'border-rose-500/40 bg-rose-950/90 text-rose-100',
  success: 'border-emerald-500/40 bg-emerald-950/90 text-emerald-100',
  info: 'border-zinc-700 bg-zinc-900/95 text-zinc-100',
};

/**
 * @param {string} title
 * @param {object} [opts]
 * @param {'error'|'success'|'info'} [opts.tone]
 * @param {string} [opts.detail]   monospace secondary line (e.g. the raw error)
 * @param {number} [opts.timeout]  ms; 0 = sticky
 */
export function toast(title, { tone = 'info', detail = '', timeout = tone === 'error' ? 12000 : 5000 } = {}) {
  const el = document.createElement('div');
  el.className = `pointer-events-auto fade-in flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur ${TONES[tone] ?? TONES.info}`;
  el.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  el.innerHTML = `
    <div class="min-w-0 flex-1">
      <p class="font-medium">${escapeHtml(title)}</p>
      ${detail ? `<p class="mt-1 max-h-24 overflow-auto font-mono text-[11px] leading-4 opacity-80 whitespace-pre-wrap break-words">${escapeHtml(detail)}</p>` : ''}
    </div>
    <button type="button" class="-mr-1 rounded p-0.5 opacity-60 hover:opacity-100" aria-label="Dismiss">
      <svg class="size-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" d="m6 6 8 8m0-8-8 8"/></svg>
    </button>`;
  const remove = () => el.remove();
  el.querySelector('button').addEventListener('click', remove);
  ensureHost().append(el);
  if (timeout) setTimeout(remove, timeout);
  return remove;
}
