/** Thin fetch wrapper: every view talks to the API through this module. */

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new ApiError('Cannot reach the server. Is it still running?', 0, null);
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const message = payload?.error?.message ?? `Request failed with status ${response.status}`;
    throw new ApiError(message, response.status, payload?.error?.details ?? null);
  }
  return payload;
}

const query = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const api = {
  health: () => request('/api/health'),
  dashboard: (windowDays) => request(`/api/dashboard${query({ window: windowDays })}`),
  settings: () => request('/api/settings'),
  updateSettings: (patch) => request('/api/settings', { method: 'PUT', body: patch }),
  suppliers: () => request('/api/suppliers'),
  supplier: (id) => request(`/api/suppliers/${id}`),
  createSupplier: (payload) => request('/api/suppliers', { method: 'POST', body: payload }),
  updateSupplier: (id, payload) => request(`/api/suppliers/${id}`, { method: 'PUT', body: payload }),
  deleteSupplier: (id) => request(`/api/suppliers/${id}`, { method: 'DELETE' }),
  categories: () => request('/api/categories'),
  products: (params) => request(`/api/products${query(params)}`),
  product: (id) => request(`/api/products/${id}`),
  createProduct: (payload) => request('/api/products', { method: 'POST', body: payload }),
  updateProduct: (id, payload) => request(`/api/products/${id}`, { method: 'PUT', body: payload }),
  productInsight: (id, windowDays) =>
    request(`/api/products/${id}/insight${query({ window: windowDays })}`),
  movements: (id, limit = 40) => request(`/api/products/${id}/movements${query({ limit })}`),
  stockMovement: (id, payload) => request(`/api/products/${id}/stock`, { method: 'POST', body: payload }),
  sales: (params) => request(`/api/sales${query(params)}`),
  sale: (id) => request(`/api/sales/${id}`),
  recordSale: (payload) => request('/api/sales', { method: 'POST', body: payload }),
  movementAnalysis: (windowDays) => request(`/api/analytics/movement${query({ window: windowDays })}`),
  reorder: (windowDays) => request(`/api/reorder${query({ window: windowDays })}`),
  alerts: (windowDays) => request(`/api/alerts${query({ window: windowDays })}`),
};
