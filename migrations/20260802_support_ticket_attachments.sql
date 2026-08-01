-- Support ticket image attachments (Supabase Storage).
-- Run in Supabase SQL editor after 20260801_support_tickets.sql.

ALTER TABLE public.support_tickets
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.support_tickets.attachments IS
  'Array of { path, name, mime, size } objects in the support-attachments bucket.';

-- Private bucket; autom8-support uploads via service role and returns signed URLs to admins.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'support-attachments',
  'support-attachments',
  false,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;
