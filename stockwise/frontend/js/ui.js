/** Small UI toolkit: escaping, toasts, modals, badges, form helpers. */

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return character;
    }
  });
}

export function toast(message, type = '') {
  const container = document.getElementById('toasts');
  if (!container) return;
  const element = document.createElement('div');
  element.className = `toast ${type}`.trim();
  element.textContent = message;
  container.appendChild(element);
  setTimeout(() => {
    element.style.transition = 'opacity 200ms ease';
    element.style.opacity = '0';
    setTimeout(() => element.remove(), 220);
  }, 3800);
}

export function errorMessage(error) {
  if (!error) return 'Something went wrong';
  if (error.details?.shortages?.length) {
    const list = error.details.shortages
      .map((item) => `${item.sku} (asked ${item.requested}, available ${item.available})`)
      .join('; ');
    return `${error.message}: ${list}`;
  }
  return error.message ?? String(error);
}

let activeModal = null;

export function closeModal() {
  if (!activeModal) return;
  activeModal.remove();
  activeModal = null;
  document.removeEventListener('keydown', onModalKey);
}

function onModalKey(event) {
  if (event.key === 'Escape') closeModal();
}

/**
 * Open a modal dialog. `onMount` receives the panel element so the caller can attach
 * listeners; returning nothing is fine.
 */
export function openModal({ title, subtitle = '', body, wide = false, onMount }) {
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head">
        <div>
          <h2>${esc(title)}</h2>
          ${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
        </div>
        <button class="modal-close" type="button" aria-label="Close dialog">✕</button>
      </div>
      <div class="modal-body">${body}</div>
    </div>`;
  document.body.appendChild(backdrop);
  activeModal = backdrop;

  const close = () => closeModal();
  backdrop.querySelector('.modal-close')?.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onModalKey);

  if (typeof onMount === 'function') {
    onMount(backdrop.querySelector('.modal'), close);
  }
  const focusTarget = backdrop.querySelector('input, select, textarea, button');
  focusTarget?.focus();
  return close;
}

export function statusBadge(urgency) {
  const labels = {
    critical: 'Critical',
    reorder: 'Reorder now',
    watch: 'Watch',
    healthy: 'Healthy',
    overstocked: 'Overstocked',
  };
  return `<span class="badge ${esc(urgency)}">${esc(labels[urgency] ?? urgency)}</span>`;
}

export function abcBadge(abcClass) {
  return `<span class="badge abc-${esc(String(abcClass).toLowerCase())}">${esc(abcClass)}</span>`;
}

export function velocityBadge(velocityClass) {
  const labels = { fast: 'Fast', medium: 'Medium', slow: 'Slow', dead: 'Dead' };
  return `<span class="badge ${esc(velocityClass)}">${esc(labels[velocityClass] ?? velocityClass)}</span>`;
}

export function pageHead({ title, subtitle, actions = '' }) {
  return `
    <div class="page-head">
      <div>
        <h1>${esc(title)}</h1>
        ${subtitle ? `<p>${subtitle}</p>` : ''}
      </div>
      <div class="actions">${actions}</div>
    </div>`;
}

export function loading() {
  return `
    <div class="skeleton" aria-busy="true" aria-label="Loading">
      <div class="block" style="height:64px"></div>
      <div class="block tall"></div>
      <div class="block"></div>
    </div>`;
}

export function formValues(form) {
  const values = {};
  for (const element of form.elements) {
    if (!element.name || element.disabled) continue;
    if (element.type === 'checkbox') values[element.name] = element.checked;
    else if (element.type === 'number') values[element.name] = element.value === '' ? null : Number(element.value);
    else values[element.name] = element.value;
  }
  return values;
}

export function setBusy(button, busy, busyLabel = 'Working…') {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = busyLabel;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label ?? button.textContent;
    button.disabled = false;
  }
}

/** Trigger a client-side CSV download (no server round trip). */
export function downloadCsv(filename, rows) {
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const csv = rows.map((row) => row.map(escape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
