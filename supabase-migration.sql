-- =============================================
-- eyeCATCHER Supabase Migration
-- Run this in your Supabase SQL Editor
-- (Dashboard → SQL Editor → New Query → Paste & Run)
-- =============================================

-- 1. Profiles table (extends auth.users)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  display_name TEXT,
  birthday DATE,
  age INTEGER,
  daily_screen_hours REAL DEFAULT 8,
  work_type TEXT DEFAULT 'general', -- 'student', 'office_worker', 'general'
  role TEXT DEFAULT 'user',          -- 'user' or 'admin'
  notification_mode TEXT DEFAULT 'moderate', -- 'light', 'moderate', 'strict'
  break_interval_minutes INTEGER DEFAULT 20,
  break_duration_seconds INTEGER DEFAULT 20,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE IF EXISTS profiles ADD COLUMN IF NOT EXISTS birthday DATE;

-- 2. Sessions table (break session records)
CREATE TABLE IF NOT EXISTS sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  successful BOOLEAN NOT NULL,
  idle_count INTEGER DEFAULT 0,
  duration_seconds INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Backward compatibility for existing databases:
-- if older schema used `pauses`, rename it to `idle_count`.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sessions'
      AND column_name = 'pauses'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sessions'
      AND column_name = 'idle_count'
  ) THEN
    ALTER TABLE public.sessions RENAME COLUMN pauses TO idle_count;
  END IF;
END $$;

-- 3. Screen time logs (daily aggregates)
CREATE TABLE IF NOT EXISTS screen_time_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  date DATE NOT NULL,
  total_seconds INTEGER DEFAULT 0,
  breaks_taken INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, date)
);

-- 3b. App usage logs (daily app-level aggregates)
CREATE TABLE IF NOT EXISTS app_usage_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  date DATE NOT NULL,
  app_name TEXT NOT NULL,
  window_title TEXT,
  total_seconds INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, date, app_name)
);

-- 4. Eye care tips (managed by admin)
CREATE TABLE IF NOT EXISTS eye_care_tips (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT DEFAULT 'exercise', -- 'exercise', 'tip', 'reminder'
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. System config (admin-configurable defaults)
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Admin allowlist (emails authorized for admin role)
CREATE TABLE IF NOT EXISTS admin_allowlist (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- Helper function to check admin role (SECURITY DEFINER bypasses RLS)
-- This prevents infinite recursion when admin policies query profiles
-- =============================================

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
DECLARE
  user_role TEXT;
BEGIN
  SELECT role INTO user_role FROM public.profiles WHERE id = auth.uid();
  RETURN user_role = 'admin';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- =============================================
-- Row Level Security (RLS)
-- =============================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE screen_time_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_usage_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE eye_care_tips ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_allowlist ENABLE ROW LEVEL SECURITY;

-- Profiles: users can read/update their own profile; admins can read all
CREATE POLICY "Users can view own profile" ON profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON profiles
  FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile" ON profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

CREATE POLICY "Admins can view all profiles" ON profiles
  FOR SELECT USING (public.is_admin());

CREATE POLICY "Admins can update all profiles" ON profiles
  FOR UPDATE USING (public.is_admin());

CREATE POLICY "Admins can delete non-self profiles" ON profiles
  FOR DELETE USING (public.is_admin() AND auth.uid() <> id);

-- Sessions: users can CRUD their own; admins can read all
CREATE POLICY "Users can manage own sessions" ON sessions
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all sessions" ON sessions
  FOR SELECT USING (public.is_admin());

CREATE POLICY "Admins can delete all sessions" ON sessions
  FOR DELETE USING (public.is_admin());

-- Screen time logs: users can CRUD their own; admins can read all
CREATE POLICY "Users can manage own screen time" ON screen_time_logs
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all screen time" ON screen_time_logs
  FOR SELECT USING (public.is_admin());

CREATE POLICY "Admins can delete all screen time" ON screen_time_logs
  FOR DELETE USING (public.is_admin());

-- App usage logs: users can CRUD their own; admins can read all
CREATE POLICY "Users can manage own app usage" ON app_usage_logs
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all app usage" ON app_usage_logs
  FOR SELECT USING (public.is_admin());

CREATE POLICY "Admins can delete all app usage" ON app_usage_logs
  FOR DELETE USING (public.is_admin());

-- Eye care tips: everyone can read active tips; admins can CRUD
CREATE POLICY "Anyone can read active tips" ON eye_care_tips
  FOR SELECT USING (is_active = true);

CREATE POLICY "Admins can manage tips" ON eye_care_tips
  FOR ALL USING (public.is_admin());

-- System config: everyone can read; admins can write
CREATE POLICY "Anyone can read config" ON system_config
  FOR SELECT USING (true);

CREATE POLICY "Admins can manage config" ON system_config
  FOR ALL USING (public.is_admin());

-- Admin allowlist: only admins can manage/view
CREATE POLICY "Admins can view admin allowlist" ON admin_allowlist
  FOR SELECT USING (public.is_admin());

CREATE POLICY "Admins can manage admin allowlist" ON admin_allowlist
  FOR ALL USING (public.is_admin());

-- =============================================
-- Auto-create profile on user signup
-- =============================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Sync current authenticated user's role from email allowlist.
-- If their email exists in allowlist and is active => role = 'admin'
-- else role = 'user'
CREATE OR REPLACE FUNCTION public.sync_my_admin_role()
RETURNS TEXT AS $$
DECLARE
  current_email TEXT;
  allowlisted BOOLEAN;
  target_role TEXT;
BEGIN
  SELECT email INTO current_email FROM auth.users WHERE id = auth.uid();
  IF current_email IS NULL THEN
    RETURN 'no-auth-user';
  END IF;

  SELECT EXISTS(
    SELECT 1
    FROM public.admin_allowlist
    WHERE LOWER(email) = LOWER(current_email)
      AND is_active = true
  ) INTO allowlisted;

  target_role := CASE WHEN allowlisted THEN 'admin' ELSE 'user' END;

  UPDATE public.profiles
  SET role = target_role
  WHERE id = auth.uid();

  RETURN target_role;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =============================================
-- Prevent non-admin role escalation
-- Users cannot change their own role via client-side updates
-- =============================================

CREATE OR REPLACE FUNCTION public.protect_role_column()
RETURNS TRIGGER AS $$
DECLARE
  caller_role TEXT;
  caller_email TEXT;
  caller_allowlisted BOOLEAN;
BEGIN
  -- Prevent self-demotion for current admin account.
  IF OLD.id = auth.uid() AND OLD.role = 'admin' AND NEW.role != 'admin' THEN
    NEW.role := OLD.role;
    RETURN NEW;
  END IF;

  SELECT role INTO caller_role FROM public.profiles WHERE id = auth.uid();

  SELECT email INTO caller_email FROM auth.users WHERE id = auth.uid();
  SELECT EXISTS(
    SELECT 1
    FROM public.admin_allowlist
    WHERE LOWER(email) = LOWER(COALESCE(caller_email, ''))
      AND is_active = true
  ) INTO caller_allowlisted;

  IF OLD.role IS DISTINCT FROM NEW.role
     AND (caller_role IS NULL OR caller_role != 'admin')
     AND NOT caller_allowlisted THEN
    NEW.role := OLD.role;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS protect_role_on_update ON profiles;
CREATE TRIGGER protect_role_on_update
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_role_column();

-- =============================================
-- Seed default eye care tips
-- =============================================

INSERT INTO eye_care_tips (title, description, category) VALUES
  ('20-20-20 Rule', 'Look at something 20 feet away for 20 seconds every 20 minutes.', 'tip'),
  ('Palming', 'Rub your hands together to warm them, then gently place them over your closed eyes for 30 seconds.', 'exercise'),
  ('Eye Rolling', 'Slowly roll your eyes in a clockwise circle 5 times, then counter-clockwise 5 times.', 'exercise'),
  ('Focus Shifting', 'Hold your thumb 10 inches from your face. Focus on it for 15 seconds, then focus on something 20 feet away for 15 seconds. Repeat 5 times.', 'exercise'),
  ('Blinking Exercise', 'Blink rapidly 15-20 times, then close your eyes and relax for 20 seconds. This helps re-moisturize your eyes.', 'exercise'),
  ('Figure Eight', 'Imagine a giant figure 8 on the floor about 10 feet away. Trace it slowly with your eyes for 30 seconds, then reverse direction.', 'exercise'),
  ('Screen Brightness', 'Adjust your screen brightness to match the surrounding lighting. Too bright or too dim increases eye strain.', 'tip'),
  ('Screen Distance', 'Keep your screen at arms length (about 25 inches) and position the top of the screen at or slightly below eye level.', 'tip'),
  ('Stay Hydrated', 'Drink water regularly. Dehydration can worsen dry eyes and eye fatigue.', 'reminder'),
  ('Neck Stretches', 'Gently tilt your head to each side, holding for 10 seconds. Neck tension can contribute to eye strain.', 'exercise')
ON CONFLICT DO NOTHING;

-- =============================================
-- Seed default system config
-- =============================================

INSERT INTO system_config (key, value) VALUES
  ('default_break_interval_minutes', '20'),
  ('default_break_duration_seconds', '20'),
  ('default_notification_mode', '"moderate"')
ON CONFLICT (key) DO NOTHING;
