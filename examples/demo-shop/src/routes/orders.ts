import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireToken } from '../middleware/auth.js';

export const orders = Router();

const NewOrder = z.object({
  email: z.string().email(),
  items: z.array(z.object({ productId: z.number().int(), quantity: z.number().int().positive() })).min(1),
});

orders.post('/orders', requireToken, async (req, res) => {
  const parsed = NewOrder.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const order = await prisma.order.create({
    data: { email: parsed.data.email, items: { create: parsed.data.items } },
    include: { items: true },
  });
  res.status(201).json(order);
});

orders.get('/orders/:id', requireToken, async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: Number(req.params.id) }, include: { items: true } });
  if (!order) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(order);
});
