import { api } from './api.js';
import { esc, openModal, setBusy, toast, errorMessage } from './ui.js';
import { setCurrency } from './format.js';
import * as dashboardView from './views/dashboard.js';
import * as productsView from './views/products.js';
import * as salesView from './views/sales.js';
import * as analyticsView from './views/analytics.js';
import * as reorderView from './views/reorder.js';
import * as suppliersView from './views/suppliers.js';

const viewRoot = document.getElementById('view');
const windowSelect = document.getElementById('window-select');
const dataThrough = document.getElementById('data-through');

const state = {
  windowDays: Number(localStorage.getItem('stockwise.window') ?? 90) || 90,
  settings: null,
  renderToken: 0,
};

const ctx = {
  get windowDays() {
    return state.windowDays;
  },
  get settings() {
    return state.settings;
  },
  set settings(value) {
    state.settings = value;
  },
  refresh: () => renderRoute(),
  navigate: (hash) => {
    window.location.hash = hash;
  },
};

const TITLES = {
  dashboard: 'Dashboard',
  products: 'Products',
  sales: 'Sales',
  analytics: 'Analytics',
  reorder: 'Reorder',
  suppliers: 'Suppliers',
};

function parseRoute() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'dashboard' };
  if (parts[0] === 'products' && parts[1]) {
    return { name: 'product-detail', id: Number(parts[1]) };
  }
  if (parts[0] in TITLES) return { name: parts[0] };
  return { name: 'dashboard' };
}

function setActiveNav(name) {
  const target = name === 'product-detail' ? 'products' : name;
  for (const link of document.querySelectorAll('#nav a')) {
    link.classList.toggle('active', link.dataset.route === target);
    if (link.dataset.route === target) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function renderRoute() {
  const route = parseRoute();
  const token = ++state.renderToken;
  setActiveNav(route.name);
  document.title = `${TITLES[route.name] ?? 'StockWise'} · StockWise`;

  try {
    if (route.name === 'product-detail') {
      if (!Number.isInteger(route.id) || route.id <= 0) {
        window.location.hash = '#/products';
        return;
      }
      await productsView.renderDetail(viewRoot, ctx, route.id);
    } else {
      const views = {
        dashboard: dashboardView.render,
        products: productsView.renderList,
        sales: salesView.render,
        analytics: analyticsView.render,
        reorder: reorderView.render,
        suppliers: suppliersView.render,
      };
      const view = views[route.name] ?? dashboardView.render;
      await view(viewRoot, ctx);
    }
  } catch (error) {
    if (token !== state.renderToken) return;
    console.error(error);
    viewRoot.innerHTML = `
      <div class="card">
        <h2>Something went wrong</h2>
        <p class="muted" style="margin:8px 0 14px">${esc(errorMessage(error))}</p>
        <button class="primary-button" type="button" id="retry-button">Try again</button>
      </div>`;
    viewRoot.querySelector('#retry-button')?.addEventListener('click', () => renderRoute());
  }
  if (token === state.renderToken && viewRoot.firstElementChild) {
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }
}

function openSettingsModal() {
  const settings = state.settings ?? {
    serviceLevelZ: 1.65,
    reviewPeriodDays: 7,
    orderCostCents: 15000,
    holdingRatePct: 22,
    defaultLeadTimeDays: 7,
    currency: 'R',
  };
  openModal({
    title: 'Policy settings',
    subtitle: 'These values drive every safety stock, reorder point and order quantity.',
    body: `
      <form id="app-settings-form">
        <div class="form-grid">
          <div class="field">
            <label for="serviceLevelZ">Service level</label>
            <select id="serviceLevelZ" name="serviceLevelZ">
              ${[
                [1.28, '90%'],
                [1.65, '95% (default)'],
                [1.88, '97%'],
                [2.05, '98%'],
                [2.33, '99%'],
              ]
                .map(
                  ([z, label]) =>
                    `<option value="${z}" ${Math.abs(Number(z) - Number(settings.serviceLevelZ)) < 0.01 ? 'selected' : ''}>${label}</option>`,
                )
                .join('')}
            </select>
          </div>
          <div class="field">
            <label for="reviewPeriodDays">Review period (days)</label>
            <input id="reviewPeriodDays" name="reviewPeriodDays" type="number" min="1" max="60" value="${settings.reviewPeriodDays}" />
          </div>
          <div class="field">
            <label for="orderCost">Cost per order (R)</label>
            <input id="orderCost" name="orderCost" type="number" min="0" step="0.01" value="${(settings.orderCostCents / 100).toFixed(2)}" />
          </div>
          <div class="field">
            <label for="holdingRatePct">Holding cost (% / year)</label>
            <input id="holdingRatePct" name="holdingRatePct" type="number" min="0" max="100" step="0.5" value="${settings.holdingRatePct}" />
          </div>
          <div class="field">
            <label for="defaultLeadTimeDays">Default lead time (days)</label>
            <input id="defaultLeadTimeDays" name="defaultLeadTimeDays" type="number" min="0" max="180" value="${settings.defaultLeadTimeDays}" />
          </div>
          <div class="field">
            <label for="currency">Currency symbol</label>
            <input id="currency" name="currency" maxlength="4" value="${esc(settings.currency)}" />
          </div>
        </div>
        <div class="form-actions">
          <button type="button" class="ghost-button" data-close>Cancel</button>
          <button type="submit" class="primary-button">Save &amp; recalculate</button>
        </div>
      </form>`,
    onMount(panel, close) {
      panel.querySelector('[data-close]')?.addEventListener('click', close);
      const form = panel.querySelector('#app-settings-form');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submit = form.querySelector('button[type="submit"]');
        setBusy(submit, true, 'Saving…');
        try {
          const updated = await api.updateSettings({
            serviceLevelZ: Number(form.serviceLevelZ.value),
            reviewPeriodDays: Number(form.reviewPeriodDays.value),
            orderCostCents: Math.round(Number(form.orderCost.value) * 100),
            holdingRatePct: Number(form.holdingRatePct.value),
            defaultLeadTimeDays: Number(form.defaultLeadTimeDays.value),
            currency: form.currency.value || 'R',
          });
          state.settings = updated;
          setCurrency(updated.currency);
          toast('Policy updated', 'success');
          close();
          renderRoute();
        } catch (error) {
          toast(errorMessage(error), 'error');
          setBusy(submit, false);
        }
      });
    },
  });
}

async function bootstrap() {
  windowSelect.value = String(state.windowDays);
  windowSelect.addEventListener('change', () => {
    state.windowDays = Number(windowSelect.value);
    localStorage.setItem('stockwise.window', String(state.windowDays));
    renderRoute();
  });

  document.getElementById('refresh-button').addEventListener('click', () => {
    toast('Refreshed');
    renderRoute();
  });
  document.getElementById('settings-button').addEventListener('click', openSettingsModal);
  window.addEventListener('hashchange', renderRoute);

  try {
    const settings = await api.settings();
    state.settings = settings;
    setCurrency(settings.currency);
  } catch {
    // The individual views surface connectivity errors; the shell still renders.
  }

  try {
    const health = await api.health();
    if (dataThrough) dataThrough.textContent = `Demo shop · ${health.products} products`;
  } catch {
    if (dataThrough) dataThrough.textContent = 'Server unreachable';
  }

  if (!window.location.hash) {
    window.location.hash = '#/dashboard';
  } else {
    renderRoute();
  }
}

bootstrap();
