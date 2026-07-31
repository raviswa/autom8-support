-- Support tickets (autom8-support ownership).
-- Case A: table did not exist in production at greenfield create time.
-- Run once in Supabase SQL editor.

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid REFERENCES public.tenants(id) ON DELETE SET NULL,
  user_id uuid,
  customer_phone text,
  source text NOT NULL DEFAULT 'dashboard'
    CHECK (source IN ('dashboard', 'whatsapp', 'internal')),
  category text
    CHECK (category IS NULL OR category IN (
      'catalog_sync', 'payment_failure', 'kds_printer',
      'subscription_billing', 'menu_setup', 'other'
    )),
  message text NOT NULL,
  ai_category text,
  confidence_score numeric,
  ai_response text,
  resolution_type text NOT NULL DEFAULT 'escalated'
    CHECK (resolution_type IN ('auto_resolved', 'escalated', 'resolved')),
  summary text,
  notes text,
  assigned_to text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_tickets_created_at_idx
  ON public.support_tickets (created_at DESC);

CREATE INDEX IF NOT EXISTS support_tickets_status_resolution_idx
  ON public.support_tickets (status, resolution_type);

CREATE INDEX IF NOT EXISTS support_tickets_restaurant_id_idx
  ON public.support_tickets (restaurant_id);

COMMENT ON TABLE public.support_tickets IS
  'Owner/manager support tickets triaged by autom8-support (Groq).';
