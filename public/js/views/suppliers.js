import { api } from '../api.js';
import {
  errorMessage,
  esc,
  formValues,
  loading,
  openModal,
  pageHead,
  setBusy,
  toast,
} from '../ui.js';
import { moneyCompact, number, setCurrency } from '../format.js';

export async function render(container, ctx) {
  container.innerHTML = pageHead({
    title: 'Suppliers',
    subtitle: 'Lead times drive the reorder point — keeping them accurate is half the battle.',
  }) + loading();

  let suppliers;
  try {
    suppliers = await api.suppliers();
    if (ctx.settings) setCurrency(ctx.settings.currency);
  } catch (error) {
    container.innerHTML = pageHead({ title: 'Suppliers' }) + `<div class="card">${esc(errorMessage(error))}</div>`;
    return;
  }

  container.innerHTML = `
    ${pageHead({
      title: 'Suppliers',
      subtitle: `${number(suppliers.length)} suppliers. Lead time is used in every reorder calculation.`,
      actions: `<button class="primary-button" id="new-supplier" type="button">+ New supplier</button>`,
    })}
    <div class="supplier-grid">
      ${
        suppliers
          .map(
            (supplier) => `
        <section class="card supplier-card">
          <div class="name">${esc(supplier.name)}</div>
          <div class="meta">
            ${supplier.contactName ? `${esc(supplier.contactName)} · ` : ''}${supplier.email ? esc(supplier.email) : 'no email'}
            ${supplier.phone ? `<br />${esc(supplier.phone)}` : ''}
          </div>
          ${supplier.notes ? `<p class="small muted">${esc(supplier.notes)}</p>` : ''}
          <div class="stats">
            <div><span class="muted tiny">Lead time</span><strong>${number(supplier.leadTimeDays)} days</strong></div>
            <div><span class="muted tiny">Products</span><strong>${number(supplier.productCount)}</strong></div>
            <div><span class="muted tiny">Stock value</span><strong>${moneyCompact(supplier.stockValueCents)}</strong></div>
          </div>
          <div class="supplier-actions">
            <button class="ghost-button" data-edit="${supplier.id}" type="button">Edit</button>
          </div>
        </section>`,
          )
          .join('') || '<div class="card">No suppliers yet.</div>'
      }
    </div>`;

  container.querySelector('#new-supplier').addEventListener('click', () => {
    openSupplierModal({ onSaved: () => ctx.refresh() });
  });
  container.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const supplier = suppliers.find((item) => item.id === Number(button.dataset.edit));
      if (supplier) openSupplierModal({ supplier, onSaved: () => ctx.refresh() });
    });
  });
}

function openSupplierModal({ supplier, onSaved }) {
  const editing = Boolean(supplier);
  openModal({
    title: editing ? `Edit ${supplier.name}` : 'New supplier',
    subtitle: editing
      ? 'Lead time changes recalculate reorder points for every product from this supplier.'
      : 'Add a supplier so products can be reordered with the right lead time.',
    body: `
      <form id="supplier-form">
        <div class="form-grid">
          <div class="field">
            <label for="name">Supplier name</label>
            <input id="name" name="name" required minlength="2" value="${esc(supplier?.name ?? '')}" />
          </div>
          <div class="field">
            <label for="contactName">Contact person</label>
            <input id="contactName" name="contactName" value="${esc(supplier?.contactName ?? '')}" />
          </div>
          <div class="field">
            <label for="email">Email</label>
            <input id="email" name="email" type="email" value="${esc(supplier?.email ?? '')}" />
          </div>
          <div class="field">
            <label for="phone">Phone</label>
            <input id="phone" name="phone" value="${esc(supplier?.phone ?? '')}" />
          </div>
          <div class="field">
            <label for="leadTimeDays">Lead time (days)</label>
            <input id="leadTimeDays" name="leadTimeDays" type="number" min="0" max="180" required value="${supplier?.leadTimeDays ?? 7}" />
            <span class="hint">Typical days from order to delivery.</span>
          </div>
        </div>
        <div class="field">
          <label for="notes">Notes</label>
          <textarea id="notes" name="notes" rows="3">${esc(supplier?.notes ?? '')}</textarea>
        </div>
        <div class="form-actions">
          ${editing && supplier.productCount === 0 ? '<button type="button" class="danger-button" id="delete-supplier">Delete</button>' : ''}
          <button type="button" class="ghost-button" data-close>Cancel</button>
          <button type="submit" class="primary-button">${editing ? 'Save changes' : 'Create supplier'}</button>
        </div>
      </form>`,
    onMount(panel, close) {
      panel.querySelector('[data-close]')?.addEventListener('click', close);
      const form = panel.querySelector('#supplier-form');

      panel.querySelector('#delete-supplier')?.addEventListener('click', async (event) => {
        if (!confirm(`Delete ${supplier.name}? This cannot be undone.`)) return;
        setBusy(event.target, true, 'Deleting…');
        try {
          await api.deleteSupplier(supplier.id);
          toast('Supplier deleted', 'success');
          close();
          if (onSaved) onSaved();
        } catch (error) {
          toast(errorMessage(error), 'error');
          setBusy(event.target, false);
        }
      });

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const values = formValues(form);
        const payload = {
          name: values.name,
          contactName: values.contactName || null,
          email: values.email || null,
          phone: values.phone || null,
          leadTimeDays: Number(values.leadTimeDays),
          notes: values.notes || null,
        };
        const submit = form.querySelector('button[type="submit"]');
        setBusy(submit, true, 'Saving…');
        try {
          if (editing) await api.updateSupplier(supplier.id, payload);
          else await api.createSupplier(payload);
          toast(editing ? 'Supplier updated' : 'Supplier created', 'success');
          close();
          if (onSaved) onSaved();
        } catch (error) {
          toast(errorMessage(error), 'error');
          setBusy(submit, false);
        }
      });
    },
  });
}
