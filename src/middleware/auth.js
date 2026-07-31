'use strict';

const { createClient } = require('@supabase/supabase-js');

let _admin;

function getSupabaseAdmin() {
  if (_admin) return _admin;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  _admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _admin;
}

function adminEmails() {
  return String(process.env.SUPPORT_ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function isValidInternalSecret(candidate) {
  const expected = process.env.AUTOM8_KDS_SECRET;
  if (!expected || !candidate) return false;
  return candidate === expected;
}

function extractInternalSecret(req) {
  return (
    req.body?.secret
    ?? req.headers['authorization']?.split(' ')[1]
    ?? req.headers['x-internal-secret']
    ?? req.query?.secret
    ?? null
  );
}

async function authenticateToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const { data: { user }, error } = await getSupabaseAdmin().auth.getUser(token);
    if (error || !user) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = { sub: user.id, email: user.email };
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Authentication failed' });
  }
}

async function attachOutletContext(req, res, next) {
  try {
    const admin = getSupabaseAdmin();
    const { data: emp } = await admin
      .from('employees')
      .select('id, restaurant_id, brand_id, role')
      .eq('user_id', req.user.sub)
      .eq('is_active', true)
      .maybeSingle();

    req.user_role = emp?.role || null;
    req.brand_id = emp?.brand_id || null;
    req.restaurant_id = emp?.restaurant_id
      || req.headers['x-restaurant-id']
      || req.body?.restaurant_id
      || null;

    if (!req.restaurant_id && req.brand_id) {
      const headerId = req.headers['x-restaurant-id'] || req.body?.restaurant_id;
      if (headerId) {
        const { data: outlet } = await admin
          .from('tenants')
          .select('id')
          .eq('id', headerId)
          .eq('brand_id', req.brand_id)
          .maybeSingle();
        if (outlet?.id) req.restaurant_id = outlet.id;
      }
    }
    next();
  } catch (err) {
    console.error('[support auth] outlet context', err.message);
    next();
  }
}

/** Email allowlist for support queue — independent of backend requirePlatformAdmin (KDS/OwnerConsole). */
function requireSupportAdmin(req, res, next) {
  // TODO(scale): replace SUPPORT_ADMIN_EMAILS allowlist with platform_role column
  const allowed = adminEmails();
  if (!allowed.length) {
    return res.status(503).json({ error: 'SUPPORT_ADMIN_EMAILS is not configured' });
  }
  const email = String(req.user?.email || '').toLowerCase();
  if (!allowed.includes(email)) {
    return res.status(403).json({ error: 'Support admin only' });
  }
  next();
}

module.exports = {
  getSupabaseAdmin,
  authenticateToken,
  attachOutletContext,
  requireSupportAdmin,
  isValidInternalSecret,
  extractInternalSecret,
  adminEmails,
};
