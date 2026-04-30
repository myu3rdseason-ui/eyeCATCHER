import { createClient, SupabaseClient, User, Session } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing Supabase environment variables. Check .env file.");
}

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ===== Types =====

export interface Profile {
  id: string;
  display_name: string | null;
  birthday: string | null;
  age: number | null;
  daily_screen_hours: number | null;
  work_type: string;
  habit?: string | null;
  role: string;
  notification_mode: string;
  break_interval_minutes: number;
  break_duration_seconds: number;
  created_at: string;
}

export interface SessionRecord {
  id: string;
  user_id: string;
  successful: boolean;
  idle_count: number;
  pauses?: number;
  duration_seconds: number;
  created_at: string;
}

export interface ScreenTimeLog {
  id: string;
  user_id: string;
  date: string;
  total_seconds: number;
  breaks_taken: number;
}

export interface AppUsageLog {
  id: string;
  user_id: string;
  date: string;
  app_name: string;
  window_title: string | null;
  total_seconds: number;
}

export interface TopAppUsage {
  app_name: string;
  total_seconds: number;
}

export interface EyeCareTip {
  id: string;
  title: string;
  description: string;
  category: string;
  is_active: boolean;
  created_at: string;
}

export interface SystemConfig {
  key: string;
  value: string | number;
  updated_at: string;
}

// ===== Auth Helpers =====

export async function signUp(
  email: string,
  password: string,
  displayName: string,
): Promise<{ user: User | null; session: Session | null; error: string | null }> {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName } },
  });
  if (error) return { user: null, session: null, error: error.message };
  return { user: data.user, session: data.session, error: null };
}

export async function signIn(email: string, password: string): Promise<{ user: User | null; session: Session | null; error: string | null }> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { user: null, session: null, error: error.message };
  return { user: data.user, session: data.session, error: null };
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

export async function getCurrentUser(): Promise<User | null> {
  const { data } = await supabase.auth.getUser();
  return data.user;
}

export async function resendSignupCode(email: string): Promise<{ ok: boolean; error: string | null }> {
  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, error: null };
}

export async function verifySignupCode(email: string, code: string): Promise<{ ok: boolean; error: string | null }> {
  const { error } = await supabase.auth.verifyOtp({
    type: "signup",
    email,
    token: code,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, error: null };
}

export async function sendPasswordRecoveryCode(email: string): Promise<{ ok: boolean; error: string | null }> {
  const { error } = await supabase.auth.resetPasswordForEmail(email);
  if (error) return { ok: false, error: error.message };
  return { ok: true, error: null };
}

export async function verifyRecoveryCode(email: string, code: string): Promise<{ ok: boolean; error: string | null }> {
  const { error } = await supabase.auth.verifyOtp({
    type: "recovery",
    email,
    token: code,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, error: null };
}

export async function updateMyPassword(newPassword: string): Promise<{ ok: boolean; error: string | null }> {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return { ok: false, error: error.message };
  return { ok: true, error: null };
}

export async function resolveEmailFromUsername(username: string): Promise<{ email: string | null; error: string | null }> {
  const cleaned = (username || "").trim();
  if (!cleaned) return { email: null, error: "Missing username." };
  const { data, error } = await supabase.rpc("get_email_by_display_name", { p_display_name: cleaned });
  if (error) return { email: null, error: error.message };
  return { email: typeof data === "string" ? data : null, error: null };
}

// ===== Profile Helpers =====

export async function getProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();
  if (error) { console.error("getProfile error:", error); return null; }
  return data as Profile;
}

export async function updateProfile(
  userId: string,
  updates: Partial<Profile>,
): Promise<{ ok: boolean; error: string | null }> {
  const { data, error } = await supabase
    .from("profiles")
    .update(updates)
    .eq("id", userId)
    .select("id");

  if (error) {
    const message = error.message || "Unknown profile update error";
    console.error("updateProfile error:", error);
    return { ok: false, error: message };
  }
  if (data && data.length > 0) return { ok: true, error: null };

  // Fallback for environments where signup trigger didn't create profile row.
  // Prefer INSERT first because some RLS setups allow INSERT but reject UPSERT.
  const { error: insertError } = await supabase
    .from("profiles")
    .insert({ id: userId, ...updates });
  if (!insertError) return { ok: true, error: null };

  // If row was created concurrently, retry a plain UPDATE.
  if (insertError.code === "23505") {
    const { error: retryError } = await supabase
      .from("profiles")
      .update(updates)
      .eq("id", userId);
    if (!retryError) return { ok: true, error: null };
    const retryMessage = retryError.message || "Unknown profile retry update error";
    console.error("updateProfile retry update error:", retryError);
    return { ok: false, error: retryMessage };
  }

  const message = insertError.message || "Unknown profile insert fallback error";
  console.error("updateProfile insert fallback error:", insertError);
  return { ok: false, error: message };
}

// ===== Session Helpers =====

export async function saveSession(userId: string, successful: boolean, idleCount: number, durationSeconds: number): Promise<boolean> {
  const { error } = await supabase
    .from("sessions")
    .insert({ user_id: userId, successful, idle_count: idleCount, duration_seconds: durationSeconds });

  // Backward compatibility: older databases may still have `pauses` instead of `idle_count`.
  if (error) {
    const message = (error.message || "").toLowerCase();
    const details = (error.details || "").toLowerCase();
    const hint = (error.hint || "").toLowerCase();
    const missingIdleCount =
      message.includes("idle_count") ||
      details.includes("idle_count") ||
      hint.includes("idle_count");

    if (missingIdleCount) {
      const { error: fallbackError } = await supabase
        .from("sessions")
        .insert({ user_id: userId, successful, pauses: idleCount, duration_seconds: durationSeconds });
      if (fallbackError) {
        console.error("saveSession fallback error:", fallbackError);
        return false;
      }
      return true;
    }

    console.error("saveSession error:", error);
    return false;
  }
  return true;
}

function getPeriodRange(period: string, anchorDate?: Date): {
  start: Date;
  endExclusive: Date;
  startDate: string;
  endDate: string;
} {
  const anchor = anchorDate ? new Date(anchorDate) : new Date();
  let start: Date;
  let endExclusive: Date;

  if (period === "today") {
    start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    endExclusive = new Date(start);
    endExclusive.setDate(start.getDate() + 1);
  } else if (period === "weekly") {
    start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    start.setDate(start.getDate() - start.getDay());
    endExclusive = new Date(start);
    endExclusive.setDate(start.getDate() + 7);
  } else {
    start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    endExclusive = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
  }

  const startDate = start.toISOString().split("T")[0];
  const endInclusive = new Date(endExclusive);
  endInclusive.setDate(endInclusive.getDate() - 1);
  const endDate = endInclusive.toISOString().split("T")[0];

  return { start, endExclusive, startDate, endDate };
}

export async function getSessionStats(
  userId: string,
  period: string,
  anchorDate?: Date,
): Promise<{ successful_sessions: number; terminations: number; idle_count: number }> {
  const { start, endExclusive } = getPeriodRange(period, anchorDate);

  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .gte("created_at", start.toISOString())
    .lt("created_at", endExclusive.toISOString());

  if (error || !data) return { successful_sessions: 0, terminations: 0, idle_count: 0 };

  const records = data as SessionRecord[];
  return {
    successful_sessions: records.filter(s => s.successful).length,
    terminations: records.filter(s => !s.successful).length,
    idle_count: records.reduce((sum, s) => {
      const value = Number(s.idle_count ?? s.pauses ?? 0);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0),
  };
}

// ===== Screen Time Helpers =====

export async function updateScreenTime(userId: string, additionalSeconds: number, breakTaken: boolean): Promise<void> {
  const today = new Date().toISOString().split("T")[0];

  // Try to get existing record for today
  const { data: existing } = await supabase
    .from("screen_time_logs")
    .select("*")
    .eq("user_id", userId)
    .eq("date", today)
    .single();

  if (existing) {
    await supabase
      .from("screen_time_logs")
      .update({
        total_seconds: (existing as ScreenTimeLog).total_seconds + additionalSeconds,
        breaks_taken: (existing as ScreenTimeLog).breaks_taken + (breakTaken ? 1 : 0),
      })
      .eq("id", (existing as ScreenTimeLog).id);
  } else {
    await supabase
      .from("screen_time_logs")
      .insert({
        user_id: userId,
        date: today,
        total_seconds: additionalSeconds,
        breaks_taken: breakTaken ? 1 : 0,
      });
  }
}

export async function getScreenTimeSummary(
  userId: string,
  period: string,
  anchorDate?: Date,
): Promise<{ total_seconds: number; breaks_taken: number; days_active: number }> {
  const { startDate, endDate } = getPeriodRange(period, anchorDate);

  const { data, error } = await supabase
    .from("screen_time_logs")
    .select("*")
    .eq("user_id", userId)
    .gte("date", startDate)
    .lte("date", endDate);

  if (error || !data) return { total_seconds: 0, breaks_taken: 0, days_active: 0 };

  const logs = data as ScreenTimeLog[];
  return {
    total_seconds: logs.reduce((sum, l) => sum + l.total_seconds, 0),
    breaks_taken: logs.reduce((sum, l) => sum + l.breaks_taken, 0),
    days_active: logs.length,
  };
}

export async function updateAppUsage(
  userId: string,
  appName: string,
  windowTitle: string,
  additionalSeconds: number,
): Promise<void> {
  if (!appName || additionalSeconds <= 0) return;

  const today = new Date().toISOString().split("T")[0];
  const normalizedApp = appName.trim().slice(0, 200);
  const normalizedTitle = windowTitle.trim().slice(0, 500);

  try {
    const { data: existing } = await supabase
      .from("app_usage_logs")
      .select("*")
      .eq("user_id", userId)
      .eq("date", today)
      .eq("app_name", normalizedApp)
      .single();

    if (existing) {
      await supabase
        .from("app_usage_logs")
        .update({
          total_seconds: (existing as AppUsageLog).total_seconds + additionalSeconds,
          window_title: normalizedTitle || (existing as AppUsageLog).window_title,
        })
        .eq("id", (existing as AppUsageLog).id);
      return;
    }

    await supabase
      .from("app_usage_logs")
      .insert({
        user_id: userId,
        date: today,
        app_name: normalizedApp,
        window_title: normalizedTitle || null,
        total_seconds: additionalSeconds,
      });
  } catch (error: any) {
    console.error("updateAppUsage failed:", error);
  }
}

export async function getTopAppsForPeriod(
  userId: string,
  period: string,
  limitCount: number = 5,
  anchorDate?: Date,
): Promise<TopAppUsage[]> {
  const { startDate, endDate } = getPeriodRange(period, anchorDate);

  const { data, error } = await supabase
    .from("app_usage_logs")
    .select("app_name,total_seconds")
    .eq("user_id", userId)
    .gte("date", startDate)
    .lte("date", endDate);

  if (error || !data) return [];

  const totalsByApp = new Map<string, number>();
  for (const row of data as Array<{ app_name: string; total_seconds: number }>) {
    const key = row.app_name || "Unknown App";
    totalsByApp.set(key, (totalsByApp.get(key) || 0) + (row.total_seconds || 0));
  }

  return Array.from(totalsByApp.entries())
    .map(([app_name, total_seconds]) => ({ app_name, total_seconds }))
    .sort((a, b) => b.total_seconds - a.total_seconds)
    .slice(0, Math.max(1, limitCount));
}

// ===== Eye Care Tips =====

export async function getActiveTips(): Promise<EyeCareTip[]> {
  const { data, error } = await supabase
    .from("eye_care_tips")
    .select("*")
    .eq("is_active", true);
  if (error || !data) return [];
  return data as EyeCareTip[];
}

export async function getRandomTip(): Promise<EyeCareTip | null> {
  const tips = await getActiveTips();
  if (tips.length === 0) return null;
  return tips[Math.floor(Math.random() * tips.length)];
}

// ===== Admin Helpers =====

export async function getAllProfiles(): Promise<Profile[]> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return data as Profile[];
}

export async function getAllSessions(): Promise<SessionRecord[]> {
  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error || !data) return [];
  return data as SessionRecord[];
}

export async function getAllScreenTimeLogs(): Promise<ScreenTimeLog[]> {
  const { data, error } = await supabase
    .from("screen_time_logs")
    .select("*")
    .order("date", { ascending: false })
    .limit(200);
  if (error || !data) return [];
  return data as ScreenTimeLog[];
}

export async function getAllTips(): Promise<EyeCareTip[]> {
  const { data, error } = await supabase
    .from("eye_care_tips")
    .select("*")
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return data as EyeCareTip[];
}

export async function createTip(title: string, description: string, category: string): Promise<boolean> {
  const { error } = await supabase
    .from("eye_care_tips")
    .insert({ title, description, category });
  if (error) { console.error("createTip error:", error); return false; }
  return true;
}

export async function updateTip(id: string, updates: Partial<EyeCareTip>): Promise<boolean> {
  const { error } = await supabase
    .from("eye_care_tips")
    .update(updates)
    .eq("id", id);
  if (error) { console.error("updateTip error:", error); return false; }
  return true;
}

export async function deleteTip(id: string): Promise<boolean> {
  const { error } = await supabase
    .from("eye_care_tips")
    .delete()
    .eq("id", id);
  if (error) { console.error("deleteTip error:", error); return false; }
  return true;
}

export async function getSystemConfig(): Promise<Record<string, string | number>> {
  const { data, error } = await supabase
    .from("system_config")
    .select("*");
  if (error || !data) return {};
  const config: Record<string, string | number> = {};
  for (const row of data as SystemConfig[]) {
    config[row.key] = row.value;
  }
  return config;
}

export async function updateSystemConfig(key: string, value: string | number): Promise<boolean> {
  const { error } = await supabase
    .from("system_config")
    .upsert({ key, value: value as unknown as string, updated_at: new Date().toISOString() });
  if (error) { console.error("updateSystemConfig error:", error); return false; }
  return true;
}

export async function updateUserRole(userId: string, role: string): Promise<boolean> {
  const { error } = await supabase
    .from("profiles")
    .update({ role })
    .eq("id", userId);
  if (error) { console.error("updateUserRole error:", error); return false; }
  return true;
}

export async function syncMyAdminRole(): Promise<string | null> {
  const { data, error } = await supabase.rpc("sync_my_admin_role");
  if (error) {
    console.error("syncMyAdminRole error:", error);
    return null;
  }
  return typeof data === "string" ? data : null;
}

export async function removeUserFromApp(userId: string): Promise<boolean> {
  // Step 1: Delete all user data from the database tables
  const { error: appUsageErr } = await supabase
    .from("app_usage_logs")
    .delete()
    .eq("user_id", userId);
  if (appUsageErr) { console.error("removeUser app_usage_logs error:", appUsageErr); return false; }

  const { error: screenErr } = await supabase
    .from("screen_time_logs")
    .delete()
    .eq("user_id", userId);
  if (screenErr) { console.error("removeUser screen_time_logs error:", screenErr); return false; }

  const { error: sessionsErr } = await supabase
    .from("sessions")
    .delete()
    .eq("user_id", userId);
  if (sessionsErr) { console.error("removeUser sessions error:", sessionsErr); return false; }

  const { error: profileErr } = await supabase
    .from("profiles")
    .delete()
    .eq("id", userId);
  if (profileErr) { console.error("removeUser profile error:", profileErr); return false; }

  // Step 2: Delete the auth user via Edge Function.
  // The anon client cannot delete from auth.users — that requires the service role,
  // which lives only in the Edge Function. Without this step, the user can still
  // log back in and recreate their profile, which is why "removal" appeared broken.
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    console.error("removeUser: no active session to authenticate edge function call");
    return false;
  }

  try {
    const response = await fetch(
      `${SUPABASE_URL}/functions/v1/delete-auth-user`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ userId }),
      },
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: response.statusText }));
      console.error("removeUser auth deletion error:", err);
      return false;
    }
  } catch (e) {
    console.error("removeUser edge function fetch error:", e);
    return false;
  }

  return true;
}
