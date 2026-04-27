import type { RequestHandler } from 'express';

export const notFound: RequestHandler = (req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
};
