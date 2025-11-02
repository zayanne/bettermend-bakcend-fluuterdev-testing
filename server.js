/**
 * BetterMend - Minimal QuickCart backend
 * server.js
 *
 * Minimal POST /carts contract:
 *  Request body:
 *    {
 *      "cart_id": "optional-client-cart-id",   // optional; server will generate if missing
 *      "customer_id": "user-123",
 *      "items": [{ "product_id": 1, "quantity": 2 }, ...]
 *    }
 *
 * Behavior:
 *  - Validate presence of customer_id and items[]
 *  - Validate each item: product exists, quantity > 0
 *  - DOES NOT check prices or decrement stock
 *  - Saves cart to data/carts.json with server-side metadata (created_at, expires_at, status)
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const DATA_DIR = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const CARTS_FILE = path.join(DATA_DIR, 'carts.json');

async function readJsonOrEmpty(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function generateCartId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rnd = Math.floor(Math.random() * 9000) + 1000;
  return `CART-${date}-${rnd}`;
}

/**
 * GET /products
 */
app.get('/products', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 10;
    const products = await readJsonOrEmpty(PRODUCTS_FILE).slice(0, limit);
    res.json({ success: true, total: products.length, products });
  } catch (err) {
    console.error('GET /products error:', err);
    res.status(500).json({ success: false, error: 'internal_server_error' });
  }
});

/**
 * GET /products/:id
 */
app.get('/products/:id', async (req, res) => {
  try {
    const products = await readJsonOrEmpty(PRODUCTS_FILE);
    const id = Number(req.params.id);
    const product = products.find(p => Number(p.id) === id);
    if (!product) return res.status(404).json({ success: false, error: 'product_not_found' });
    res.json({ success: true, product });
  } catch (err) {
    console.error('GET /products/:id error:', err);
    res.status(500).json({ success: false, error: 'internal_server_error' });
  }
});

/**
 * POST /carts
 * Minimal payload: { cart_id?, customer_id, items: [{product_id, quantity}] }
 */
app.post('/carts', async (req, res) => {
  try {
    const body = req.body || {};

    // Basic required fields
    if (!body.customer_id || typeof body.customer_id !== 'string' || body.customer_id.trim() === '') {
      return res.status(400).json({ success: false, error: 'missing_customer_id' });
    }
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return res.status(400).json({ success: false, error: 'items_required' });
    }

    // Validate items: each must have product_id and quantity > 0
    const products = await readJsonOrEmpty(PRODUCTS_FILE);
    const invalidItems = [];
    for (let i = 0; i < body.items.length; i++) {
      const it = body.items[i];
      if (typeof it.product_id === 'undefined' || typeof it.quantity === 'undefined') {
        invalidItems.push({ index: i, reason: 'product_id and quantity are required' });
        continue;
      }
      const qty = Number(it.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        invalidItems.push({ index: i, reason: 'quantity must be a positive number' });
        continue;
      }
      const pid = Number(it.product_id);
      const found = products.find(p => Number(p.id) === pid);
      if (!found) {
        invalidItems.push({ index: i, reason: 'product_not_found', product_id: pid });
        continue;
      }
    }
    if (invalidItems.length) {
      return res.status(400).json({ success: false, error: 'invalid_items', details: invalidItems });
    }

    // Persist cart
    const carts = await readJsonOrEmpty(CARTS_FILE);

    // If client provided cart_id, try to avoid duplicates: replace existing cart with same id
    let cartId = body.cart_id && typeof body.cart_id === 'string' && body.cart_id.trim() !== '' ? body.cart_id.trim() : generateCartId();

    // if cart_id exists in storage, overwrite it (client likely updating)
    const existingIndex = carts.findIndex(c => c.cart_id === cartId);

    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(); // 7 days

    const newCart = {
      cart_id: cartId,
      customer_id: body.customer_id,
      items: body.items.map(it => ({ product_id: Number(it.product_id), quantity: Number(it.quantity) })),
      status: 'saved', // internal status
      created_at: existingIndex >= 0 ? carts[existingIndex].created_at : createdAt,
      updated_at: createdAt,
      expires_at: expiresAt
    };

    if (existingIndex >= 0) {
      carts[existingIndex] = newCart;
    } else {
      carts.push(newCart);
    }

    await writeJson(CARTS_FILE, carts);

    const statusCode = existingIndex >= 0 ? 200 : 201;
    return res.status(statusCode).json({
      success: true,
      cart_id: cartId,
      status: newCart.status,
      message: existingIndex >= 0 ? 'Cart updated' : 'Cart saved'
    });
  } catch (err) {
    console.error('POST /carts error:', err);
    res.status(500).json({ success: false, error: 'internal_server_error' });
  }
});

/**
 * GET /carts - list saved carts (debug)
 */
app.get('/carts', async (req, res) => {
  try {
    const userId = req.query.customer_id;
    if (!userId) {
      return res.status(400).json({ success: false, error: 'missing_user_id' });
    }

    const carts = await readJsonOrEmpty(CARTS_FILE);
    const userCarts = carts.filter(c => c.customer_id === userId);
    res.json({ success: true, total: userCarts.length, carts: userCarts });
  } catch (err) {
    console.error('GET /carts error:', err);
    res.status(500).json({ success: false, error: 'internal_server_error' });
  }
});



// start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ BetterMend minimal backend running on port ${PORT}`);
  console.log(`  GET  /products`);
  console.log(`  GET  /products/:id`);
  console.log(`  POST /carts`);
  console.log(`  GET  /carts`);
});
