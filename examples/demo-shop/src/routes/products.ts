import { Router } from 'express';
import { prisma } from '../db.js';

export const products = Router();

products.get('/products', async (_req, res) => {
  const rows = await prisma.product.findMany({ orderBy: { name: 'asc' } });
  res.json(rows);
});

products.get('/products/:id', async (req, res) => {
  const product = await prisma.product.findUnique({ where: { id: Number(req.params.id) } });
  if (!product) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(product);
});
