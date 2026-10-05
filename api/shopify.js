// api/shopify.js — month-to-date order data from the Shopify Admin GraphQL API
// for the Paid Media tab's "Needs Shopify" cards.
// Env vars: SHOPIFY_STORE (e.g. hey-love.myshopify.com) plus either
//           SHOPIFY_ADMIN_TOKEN (shpat_...) or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET.
// Required scopes on the app: read_orders, read_products, read_customers.
const API_VERSION = '2025-07';
const MAX_PAGES = 12; // 250 orders/page → up to 3,000 orders per month

const ORDERS_QUERY = `
query Orders($q: String!, $after: String) {
  orders(first: 250, query: $q, after: $after, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      createdAt
      totalPriceSet { shopMoney { amount currencyCode } }
      discountCodes
      customer { numberOfOrders }
      lineItems(first: 50) {
        nodes {
          title
          quantity
          originalTotalSet { shopMoney { amount } }
          product { productType }
        }
      }
    }
  }
}`;

function store() {
  return (process.env.SHOPIFY_STORE || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

// Either a legacy admin-created app token (SHOPIFY_ADMIN_TOKEN), or a Dev
// Dashboard app's SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET, exchanged for a
// short-lived token via the client credentials grant.
function configured() {
  return !!store() && !!(process.env.SHOPIFY_ADMIN_TOKEN || (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET));
}
let cachedToken = null; // { token, expires }
async function accessToken() {
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;
  if (cachedToken && cachedToken.expires > Date.now() + 60000) return cachedToken.token;
  const r = await fetch(`https://${store()}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Shopify token exchange failed (${r.status}): ${j.error_description || j.error || 'error'}`);
  cachedToken = { token: j.access_token, expires: Date.now() + (j.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

async function gql(query, variables) {
  const r = await fetch(`https://${store()}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': await accessToken(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) {
    const msg = Array.isArray(j.errors) ? j.errors.map((e) => e.message).join('; ') : (j.errors || `HTTP ${r.status}`);
    throw new Error(`Shopify: ${msg}`);
  }
  return j.data;
}

const num = (v) => Number(v) || 0;
function topN(map, n, key = 'revenue') {
  return Object.entries(map)
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b[key] - a[key])
    .slice(0, n);
}

module.exports = async (req, res) => {
  if (!configured()) {
    return res.status(200).json({ configured: false });
  }
  try {
    const now = new Date();
    const since = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const q = `created_at:>=${since} AND -status:cancelled`;

    const orders = [];
    let after = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const d = await gql(ORDERS_QUERY, { q, after });
      orders.push(...d.orders.nodes);
      if (!d.orders.pageInfo.hasNextPage) break;
      after = d.orders.pageInfo.endCursor;
    }

    const customers = { new: { orders: 0, revenue: 0 }, returning: { orders: 0, revenue: 0 }, guest: { orders: 0, revenue: 0 } };
    const categories = {};
    const promos = {};
    const products = {};
    let currency = 'USD';
    let totalRevenue = 0;

    for (const o of orders) {
      const total = num(o.totalPriceSet?.shopMoney?.amount);
      currency = o.totalPriceSet?.shopMoney?.currencyCode || currency;
      totalRevenue += total;

      // "New" = this is the customer's only order on record.
      const bucket = !o.customer ? 'guest' : num(o.customer.numberOfOrders) <= 1 ? 'new' : 'returning';
      customers[bucket].orders++;
      customers[bucket].revenue += total;

      for (const code of o.discountCodes || []) {
        const k = code.toUpperCase();
        promos[k] = promos[k] || { orders: 0, revenue: 0 };
        promos[k].orders++;
        promos[k].revenue += total;
      }

      for (const li of o.lineItems?.nodes || []) {
        const amt = num(li.originalTotalSet?.shopMoney?.amount);
        const cat = li.product?.productType || 'Uncategorized';
        categories[cat] = categories[cat] || { units: 0, revenue: 0 };
        categories[cat].units += li.quantity;
        categories[cat].revenue += amt;
        products[li.title] = products[li.title] || { units: 0, revenue: 0 };
        products[li.title].units += li.quantity;
        products[li.title].revenue += amt;
      }
    }

    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
    return res.status(200).json({
      configured: true,
      refreshedAt: new Date().toISOString(),
      range: { since, until: now.toISOString().slice(0, 10) },
      truncated: !!after && orders.length >= MAX_PAGES * 250,
      currency,
      orderCount: orders.length,
      totalRevenue,
      customers,
      categories: topN(categories, 8),
      promoCodes: topN(promos, 8),
      topProducts: topN(products, 8, 'units'),
    });
  } catch (e) {
    return res.status(500).json({ configured: true, error: e.message });
  }
};
