-- =============================================
-- eyeCATCHER MVP Schema Fix (idempotent)
-- Run this in Supabase SQL Editor.
--
-- Purpose:
-- 1) Ensure profiles table has all MVP columns used by the app
-- 2) Add "habit" column used in profile setup/edit
-- 3) Add username-login helper RPC
-- 4) Recommend unique usernames via a unique index (case-insensitive)
-- =============================================

-- 1) Ensure required profile columns exist
ALTER TABLE IF EXISTS public.profiles
  ADD COLUMN IF NOT EXISTS display_name TEXT;

ALTER TABLE IF EXISTS public.profiles
  ADD COLUMN IF NOT EXISTS birthday DATE;

ALTER TABLE IF EXISTS public.profiles
  ADD COLUMN IF NOT EXISTS age INTEGER;

ALTER TABLE IF EXISTS public.profiles
  ADD COLUMN IF NOT EXISTS daily_screen_hours REAL DEFAULT 8;

ALTER TABLE IF EXISTS public.profiles
  ADD COLUMN IF NOT EXISTS work_type TEXT DEFAULT 'student';

ALTER TABLE IF EXISTS public.profiles
  ADD COLUMN IF NOT EXISTS habit TEXT;

ALTER TABLE IF EXISTS public.profiles
  ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user';

ALTER TABLE IF EXISTS public.profiles
  ADD COLUMN IF NOT EXISTS notification_mode TEXT DEFAULT 'moderate';

ALTER TABLE IF EXISTS public.profiles
  ADD COLUMN IF NOT EXISTS break_interval_minutes INTEGER DEFAULT 20;

ALTER TABLE IF EXISTS public.profiles
  ADD COLUMN IF NOT EXISTS break_duration_seconds INTEGER DEFAULT 20;

ALTER TABLE IF EXISTS public.profiles
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- 2) Username login helper RPC (display_name -> auth.users.email)
CREATE OR REPLACE FUNCTION public.get_email_by_display_name(p_display_name TEXT)
RETURNS TEXT AS $$
DECLARE
  result_email TEXT;
BEGIN
  SELECT au.email
  INTO result_email
  FROM public.profiles p
  JOIN auth.users au ON au.id = p.id
  WHERE LOWER(COALESCE(p.display_name, '')) = LOWER(COALESCE(p_display_name, ''))
  ORDER BY p.created_at DESC
  LIMIT 1;

  RETURN result_email;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- 3) Optional but strongly recommended: enforce unique usernames (case-insensitive).
-- If you already have duplicate display_name values, this will fail.
-- Fix duplicates first (or skip this index).
CREATE UNIQUE INDEX IF NOT EXISTS profiles_display_name_unique_ci
ON public.profiles (LOWER(display_name))
WHERE display_name IS NOT NULL AND LENGTH(TRIM(display_name)) > 0;

