-- =============================================
-- eyeCATCHER Username Login Helper (Supabase)
-- Run this in your Supabase SQL Editor
-- =============================================
--
-- Enables "login with username" by resolving profiles.display_name -> auth.users.email
-- via a SECURITY DEFINER function so it can bypass RLS on profiles.
--
-- Notes:
-- - display_name should be unique (recommended). If not unique, function returns the newest match.
-- - This returns email only; password auth still happens through Supabase Auth.

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

-- Recommended: enforce unique usernames (case-insensitive).
-- If you already have duplicates, this will fail until you resolve them.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_display_name_unique_ci
ON public.profiles (LOWER(display_name))
WHERE display_name IS NOT NULL AND LENGTH(TRIM(display_name)) > 0;
