import express from 'express';
import { searchQuery } from '@chat/shared';
import { limited, parse, userOf } from '../../http.js';
import * as users from './service.js';

// Mounted behind requireAuth, so the key is the verified user id, not the IP.
const searchLimit = limited(30, 60_000, { keyGenerator: (req) => userOf(req).id });

export function usersRouter(): express.Router {
  const router = express.Router();

  router.get('/', searchLimit, async (req, res) => {
    const { q } = parse(searchQuery, req.query);
    res.json({ users: await users.searchUsers(userOf(req).id, q) });
  });

  return router;
}
