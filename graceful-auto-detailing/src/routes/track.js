import { Router, sendJson } from '../http.js';
import { clientIp, rateLimit } from '../security.js';
import { resolveTripToken, publicTripState, countTripView } from '../links.js';

export const router = new Router();

/* ---------------------------------------------------------------------------
   The whole public tracking surface is this one route.

   There is no way to ask this server where the owner is other than by holding a
   token for a trip that is running right now. Expired, ended and never-existed
   all answer identically, so a dead link cannot be used to probe whether a job
   is on. Nothing here takes an appointment id, a customer id or a phone number.
   --------------------------------------------------------------------------- */

router.get('/api/track/:token', async (req, res, params) => {
  const limit = rateLimit(`track:${clientIp(req)}`, { limit: 240, windowMs: 5 * 60 * 1000 });
  if (!limit.ok) {
    const err = new Error('Too many requests. Give it a minute.');
    err.status = 429; err.expose = true; err.retryAfterSec = limit.retryAfterSec;
    throw err;
  }

  const trip = resolveTripToken(params.token);
  countTripView(trip.id);
  sendJson(req, res, 200, publicTripState(trip));
});

export default router;
