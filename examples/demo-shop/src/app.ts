import express from 'express';
import { orders } from './routes/orders.js';
import { products } from './routes/products.js';

export function createApp() {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(products);
  app.use(orders);
  return app;
}
