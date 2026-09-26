import type { NextFunction, Request, Response } from 'express';

/** Bearer-token check for write endpoints. The token comes from the environment. */
export function requireToken(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.API_TOKEN;
  const header = req.header('authorization') ?? '';
  if (!expected || header !== `Bearer ${expected}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}
