-- =============================================
-- eyeCATCHER RLS Fix Migration
-- Run this in your Supabase SQL Editor AFTER the initial migration
-- (Dashboard -> SQL Editor -> New Query -> Paste & Run)
--
-- Fixes:
-- 1. Infinite recursion in admin RLS policies (queried profiles from profiles)
-- 2. Missing admin UPDATE policy on profiles (admin role changes were silently failing)
-- 3. Role escalation vulnerability (users could self-promote to admin)
-- =============================================

-- 1. Create helper function that bypasses RLS to check admin role
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
DECLARE
  user_role TEXT;
BEGIN
  SELECT role INTO user_role FROM public.profiles WHERE id = auth.uid();
  RETURN user_role = 'admin';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- 2. Drop old recursive policies
DROP POLICY IF EXISTS "Admins can view all profiles" ON profiles;
DROP POLICY IF EXISTS "Admins can update all profiles" ON profiles;
DROP POLICY IF EXISTS "Admins can view all sessions" ON sessions;
DROP POLICY IF EXISTS "Admins can view all screen time" ON screen_time_logs;
DROP POLICY IF EXISTS "Admins can manage tips" ON eye_care_tips;
DROP POLICY IF EXISTS "Admins can manage config" ON system_config;

-- 3. Recreate policies using the helper function (no recursion)
CREATE POLICY "Admins can view all profiles" ON profiles
  FOR SELECT USING (public.is_admin());

CREATE POLICY "Admins can update all profiles" ON profiles
  FOR UPDATE USING (public.is_admin());

CREATE POLICY "Admins can delete non-self profiles" ON profiles
  FOR DELETE USING (public.is_admin() AND auth.uid() <> id);

CREATE POLICY "Admins can view all sessions" ON sessions
  FOR SELECT USING (public.is_admin());

CREATE POLICY "Admins can view all screen time" ON screen_time_logs
  FOR SELECT USING (public.is_admin());

CREATE POLICY "Admins can manage tips" ON eye_care_tips
  FOR ALL USING (public.is_admin());

CREATE POLICY "Admins can manage config" ON system_config
  FOR ALL USING (public.is_admin());

-- 4. Prevent non-admin role escalation
CREATE OR REPLACE FUNCTION public.protect_role_column()
RETURNS TRIGGER AS $$
DECLARE
  caller_role TEXT;
BEGIN
  SELECT role INTO caller_role FROM public.profiles WHERE id = auth.uid();
  IF OLD.role IS DISTINCT FROM NEW.role AND (caller_role IS NULL OR caller_role != 'admin') THEN
    NEW.role := OLD.role;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS protect_role_on_update ON profiles;
CREATE TRIGGER protect_role_on_update
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_role_column();
