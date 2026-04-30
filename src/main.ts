import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  supabase,
  signUp,
  signIn,
  signOut,
  getCurrentUser,
  resendSignupCode,
  verifySignupCode,
  sendPasswordRecoveryCode,
  verifyRecoveryCode,
  updateMyPassword,
  resolveEmailFromUsername,
  getProfile,
  updateProfile,
  saveSession as saveSessionToSupabase,
  getSessionStats,
  updateScreenTime,
  updateAppUsage,
  getScreenTimeSummary,
  getTopAppsForPeriod,
  getRandomTip,
  getAllProfiles,
  getAllSessions,
  getAllScreenTimeLogs,
  getAllTips,
  createTip,
  updateTip,
  deleteTip,
  getSystemConfig,
  updateSystemConfig,
  updateUserRole,
  syncMyAdminRole,
  removeUserFromApp,
  Profile,
} from "./supabase";

// ===== Types =====
interface TimerState {
  is_running: boolean;
  is_paused: boolean;
  elapsed_seconds: number;
  idle_count: number;
}

interface PendingSignupContext {
  email: string;
  password: string;
  birthday: string;
  age: number;
}

// ===== State =====
let timerInterval: ReturnType<typeof setInterval> | null = null;
let screenTimeInterval: ReturnType<typeof setInterval> | null = null;
let sentReminderMarks = new Set<number>();
let timerState: TimerState = {
  is_running: false,
  is_paused: false,
  elapsed_seconds: 0,
  idle_count: 0,
};
let currentStatsPeriod = "today";
let statsAnchorDate = new Date();
let currentUserId: string | null = null;
let currentProfile: Profile | null = null;
let pendingSignupBirthday: string | null = null;
let pendingSignupContext: PendingSignupContext | null = null;
let screenTimeAccumulator = 0;
let isSystemIdle = false;
let telemetryFlushCounter = 0;
let lastActiveAppName = "";
let activeAppAccumulator = 0;
let lastActiveWindowTitle = "";
let todayTrackedSeconds = 0;
let dailyLimitSeconds = 0;
let dailyLimitNotified = false;
let pendingRoleChanges = new Map<string, string>();
let currentAdminUserPeriod: "today" | "weekly" | "monthly" = "today";
let adminAnchorDate = new Date();
const SCREEN_WIPE_DURATION_MS = 360;
const SCREEN_WIPE_HOLD_MS = 120;
const AUTH_EMAIL_COOLDOWN_MS = 60_000;

let resendSignupCooldownUntil = 0;
let recoveryCooldownUntil = 0;
let resendSignupCooldownTimer: ReturnType<typeof setInterval> | null = null;
let recoveryCooldownTimer: ReturnType<typeof setInterval> | null = null;

// ===== Dynamic Constants (from user settings) =====
let TIMER_DURATION_SECONDS = 20 * 60;
let BREAK_DURATION_SECONDS = 20;
let NOTIFICATION_MODE = "moderate";

// ===== Storage Keys =====
const REMEMBER_ME_KEY = "eyecatcher-remember-me";

// ===== DOM Elements =====
function getEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error("Element #" + id + " not found");
  return el;
}

function getElSafe(id: string): HTMLElement | null {
  return document.getElementById(id);
}

// ===== Screen Navigation =====
function showScreen(screenId: string): void {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  getEl(screenId).classList.add("active");
}

function animateScreenEntrance(screenId: string): void {
  const screen = getElSafe(screenId);
  if (!screen) return;

  screen.classList.remove("screen-enter-from", "screen-enter-active");
  screen.classList.add("screen-enter-from");

  requestAnimationFrame(() => {
    screen.classList.add("screen-enter-active");
    screen.classList.remove("screen-enter-from");
  });

  window.setTimeout(() => {
    screen.classList.remove("screen-enter-active");
  }, 360);
}

function showScreenWithWipe(screenId: string): void {
  const overlay = getElSafe("screen-transition-overlay");
  if (!overlay) {
    showScreen(screenId);
    return;
  }

  configureRandomWipe(overlay);
  overlay.classList.remove("hidden", "is-entering", "is-leaving");
  void (overlay as HTMLElement).offsetWidth;
  overlay.classList.add("is-entering");

  window.setTimeout(() => {
    showScreen(screenId);
    animateScreenEntrance(screenId);
    overlay.classList.remove("is-entering");
    overlay.classList.add("is-leaving");
  }, SCREEN_WIPE_DURATION_MS + SCREEN_WIPE_HOLD_MS);

  window.setTimeout(() => {
    overlay.classList.remove("is-leaving");
    overlay.classList.add("hidden");
  }, SCREEN_WIPE_DURATION_MS * 2 + SCREEN_WIPE_HOLD_MS);
}

function playWipeTransition(onMidpoint: () => void): void {
  const overlay = getElSafe("screen-transition-overlay");
  if (!overlay) {
    onMidpoint();
    return;
  }

  configureRandomWipe(overlay);
  overlay.classList.remove("hidden", "is-entering", "is-leaving");
  void (overlay as HTMLElement).offsetWidth;
  overlay.classList.add("is-entering");

  window.setTimeout(() => {
    onMidpoint();
    overlay.classList.remove("is-entering");
    overlay.classList.add("is-leaving");
  }, SCREEN_WIPE_DURATION_MS + SCREEN_WIPE_HOLD_MS);

  window.setTimeout(() => {
    overlay.classList.remove("is-leaving");
    overlay.classList.add("hidden");
  }, SCREEN_WIPE_DURATION_MS * 2 + SCREEN_WIPE_HOLD_MS);
}

function configureRandomWipe(overlay: HTMLElement): void {
  const directionClasses = ["wipe-ltr", "wipe-rtl"];
  overlay.classList.remove(...directionClasses);
  const randomDirection = directionClasses[Math.floor(Math.random() * directionClasses.length)];
  overlay.classList.add(randomDirection);

  // Small chance for a dramatic slow variant.
  const dramatic = Math.random() < 0.15;
  const primaryDuration = dramatic
    ? 500 + Math.floor(Math.random() * 181) // 500-680ms
    : 390 + Math.floor(Math.random() * 121); // 390-510ms
  overlay.style.setProperty("--wipe-primary-duration", primaryDuration + "ms");
}

function isScreenActive(screenId: string): boolean {
  return getEl(screenId).classList.contains("active");
}

function showError(id: string, msg: string): void {
  const el = getElSafe(id);
  if (el) { el.textContent = msg; el.classList.remove("hidden"); }
}

function hideError(id: string): void {
  const el = getElSafe(id);
  if (el) { el.textContent = ""; el.classList.add("hidden"); }
}

function showConfirmModal(title: string, message: string): Promise<boolean> {
  const overlay = getEl("confirm-modal");
  const titleEl = getEl("confirm-modal-title");
  const messageEl = getEl("confirm-modal-message");
  const cancelBtn = getEl("confirm-modal-cancel");
  const confirmBtn = getEl("confirm-modal-confirm");

  titleEl.textContent = title;
  messageEl.textContent = message;
  overlay.classList.remove("hidden");

  return new Promise((resolve) => {
    const cleanup = () => {
      overlay.classList.add("hidden");
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      overlay.removeEventListener("click", onOverlay);
    };

    const onCancel = () => {
      cleanup();
      resolve(false);
    };
    const onConfirm = () => {
      cleanup();
      resolve(true);
    };
    const onOverlay = (e: Event) => {
      if (e.target === overlay) {
        cleanup();
        resolve(false);
      }
    };

    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
    overlay.addEventListener("click", onOverlay);
  });
}

// ===== Auth Flow =====
async function finalizeAuthenticatedUser(
  userId: string,
  remember: boolean,
  birthdayFromSignup?: string,
  ageFromSignup?: number,
  forceProfileSetup: boolean = false,
): Promise<void> {
  localStorage.setItem(REMEMBER_ME_KEY, remember ? "true" : "false");
  currentUserId = userId;
  await syncMyAdminRole();
  currentProfile = await getProfile(userId);
  await loadUserSettings();
  updateTimerWelcome();
  updateAdminButtonVisibility();
  void initDailyScreenTracker();
  startScreenTimeTracking();

  if (birthdayFromSignup && ageFromSignup !== undefined) {
    pendingSignupBirthday = birthdayFromSignup;
    const birthdayField = getElSafe("profile-birthday") as HTMLInputElement | null;
    if (birthdayField) birthdayField.value = birthdayFromSignup;
    const ageField = getElSafe("profile-age") as HTMLInputElement | null;
    if (ageField) ageField.value = String(ageFromSignup);
    updateProfileSetupUI();
  }

  if (forceProfileSetup) {
    showScreenWithWipe("profile-setup-screen");
    return;
  }
  if (currentProfile) showScreenWithWipe("timer-screen");
  else showScreenWithWipe("profile-setup-screen");
}

async function handleSignUp(): Promise<void> {
  hideError("signup-error");
  const email = (getEl("signup-email") as HTMLInputElement).value.trim();
  const password = (getEl("signup-password") as HTMLInputElement).value;
  const confirmPassword = (getEl("signup-confirm") as HTMLInputElement).value;
  const name = (getEl("signup-name") as HTMLInputElement).value.trim();
  const birthday = (getEl("signup-birthday") as HTMLInputElement).value;

  if (!email || !password || !name || !confirmPassword || !birthday) {
    showError("signup-error", "Please fill in all fields.");
    return;
  }
  if (password.length < 6) {
    showError("signup-error", "Password must be at least 6 characters.");
    return;
  }
  if (password !== confirmPassword) {
    showError("signup-error", "Passwords do not match.");
    return;
  }
  const age = computeAgeFromBirthday(birthday);
  if (age === null) {
    showError("signup-error", "Please enter a valid birthdate.");
    return;
  }

  const { user, error } = await signUp(email, password, name);
  if (error) { showError("signup-error", error); return; }
  if (!user) { showError("signup-error", "Sign up failed. Please try again."); return; }

  pendingSignupContext = { email, password, birthday, age };
  (getEl("verify-signup-email") as HTMLInputElement).value = email;
  (getEl("verify-signup-code") as HTMLInputElement).value = "";
  hideError("verify-signup-error");
  // Supabase will automatically send the signup confirmation email on sign up.
  // Avoid calling resend immediately (it can be rate-limited).
  showScreenWithWipe("verify-signup-screen");
}

async function handleSignIn(): Promise<void> {
  hideError("login-error");
  const identifier = (getEl("login-email") as HTMLInputElement).value.trim();
  const password = (getEl("login-password") as HTMLInputElement).value;
  const remember = (getEl("login-remember") as HTMLInputElement).checked;

  if (!identifier || !password) {
    showError("login-error", "Please enter email/username and password.");
    return;
  }

  const isEmail = identifier.includes("@");
  let email = identifier;
  if (!isEmail) {
    const resolved = await resolveEmailFromUsername(identifier);
    if (resolved.error) {
      showError("login-error", resolved.error);
      return;
    }
    if (!resolved.email) {
      showError("login-error", "Username not found.");
      return;
    }
    email = resolved.email;
  }

  const { user, error } = await signIn(email, password);
  if (error) { showError("login-error", error); return; }
  if (!user) { showError("login-error", "Sign in failed."); return; }
  if (!user.email_confirmed_at) {
    showError("login-error", "Please verify your email first before signing in.");
    return;
  }

  await finalizeAuthenticatedUser(user.id, remember);
}

async function handleVerifySignupCode(): Promise<void> {
  hideError("verify-signup-error");
  const email = (getEl("verify-signup-email") as HTMLInputElement).value.trim();
  const code = (getEl("verify-signup-code") as HTMLInputElement).value.trim();
  if (!email || !code) {
    showError("verify-signup-error", "Please enter email and verification code.");
    return;
  }

  const verify = await verifySignupCode(email, code);
  if (!verify.ok) {
    showError("verify-signup-error", verify.error || "Invalid verification code.");
    return;
  }

  const ctx = pendingSignupContext;
  if (!ctx || ctx.email.toLowerCase() !== email.toLowerCase()) {
    showError("verify-signup-error", "Verification succeeded. Please sign in manually.");
    showScreenWithWipe("login-screen");
    return;
  }

  const signInResult = await signIn(ctx.email, ctx.password);
  if (signInResult.error || !signInResult.user) {
    showError("verify-signup-error", signInResult.error || "Verification succeeded. Please log in.");
    showScreenWithWipe("login-screen");
    return;
  }

  if (!signInResult.user.email_confirmed_at) {
    showError("verify-signup-error", "Email is not verified yet. Check your inbox and try again.");
    return;
  }

  await finalizeAuthenticatedUser(signInResult.user.id, true, ctx.birthday, ctx.age, true);
  pendingSignupContext = null;
}

async function handleResendSignupCode(): Promise<void> {
  hideError("verify-signup-error");
  const email = (getEl("verify-signup-email") as HTMLInputElement).value.trim();
  if (!email) {
    showError("verify-signup-error", "Please enter your email first.");
    return;
  }
  if (Date.now() < resendSignupCooldownUntil) return;

  const btn = getElSafe("verify-signup-resend-btn") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  const resend = await resendSignupCode(email);
  if (!resend.ok) {
    showError("verify-signup-error", resend.error || "Failed to resend code.");
    // If Supabase returns a cooldown message, keep UI in cooldown state anyway.
    resendSignupCooldownUntil = Date.now() + AUTH_EMAIL_COOLDOWN_MS;
    startResendSignupCooldownUI();
    return;
  }
  showError("verify-signup-error", "New code sent to your email.");
  resendSignupCooldownUntil = Date.now() + AUTH_EMAIL_COOLDOWN_MS;
  startResendSignupCooldownUI();
}

async function handleSendRecoveryCode(): Promise<void> {
  hideError("forgot-error");
  const email = (getEl("forgot-email") as HTMLInputElement).value.trim();
  if (!email) {
    showError("forgot-error", "Please enter your email.");
    return;
  }
  if (Date.now() < recoveryCooldownUntil) return;

  const btn = getElSafe("forgot-send-btn") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  const sent = await sendPasswordRecoveryCode(email);
  if (!sent.ok) {
    showError("forgot-error", sent.error || "Failed to send recovery code.");
    recoveryCooldownUntil = Date.now() + AUTH_EMAIL_COOLDOWN_MS;
    startRecoveryCooldownUI();
    return;
  }

  (getEl("reset-email") as HTMLInputElement).value = email;
  (getEl("reset-code") as HTMLInputElement).value = "";
  (getEl("reset-password") as HTMLInputElement).value = "";
  (getEl("reset-password-confirm") as HTMLInputElement).value = "";
  hideError("reset-error");
  showScreenWithWipe("reset-password-screen");

  recoveryCooldownUntil = Date.now() + AUTH_EMAIL_COOLDOWN_MS;
  startRecoveryCooldownUI();
}

async function handleResetPassword(): Promise<void> {
  hideError("reset-error");
  const email = (getEl("reset-email") as HTMLInputElement).value.trim();
  const code = (getEl("reset-code") as HTMLInputElement).value.trim();
  const password = (getEl("reset-password") as HTMLInputElement).value;
  const confirm = (getEl("reset-password-confirm") as HTMLInputElement).value;

  if (!email || !code || !password || !confirm) {
    showError("reset-error", "Please fill in all fields.");
    return;
  }
  if (password.length < 6) {
    showError("reset-error", "Password must be at least 6 characters.");
    return;
  }
  if (password !== confirm) {
    showError("reset-error", "Passwords do not match.");
    return;
  }

  const verify = await verifyRecoveryCode(email, code);
  if (!verify.ok) {
    showError("reset-error", verify.error || "Invalid recovery code.");
    return;
  }
  const updated = await updateMyPassword(password);
  if (!updated.ok) {
    showError("reset-error", updated.error || "Failed to reset password.");
    return;
  }

  showScreenWithWipe("login-screen");
  window.setTimeout(() => {
    showError("login-error", "Password reset successful. Please sign in.");
  }, SCREEN_WIPE_DURATION_MS + SCREEN_WIPE_HOLD_MS + 80);
}

function startResendSignupCooldownUI(): void {
  const btn = getElSafe("verify-signup-resend-btn") as HTMLButtonElement | null;
  if (!btn) return;

  if (resendSignupCooldownTimer) clearInterval(resendSignupCooldownTimer);
  btn.disabled = true;

  const tick = () => {
    const remainingMs = Math.max(0, resendSignupCooldownUntil - Date.now());
    const remainingSec = Math.ceil(remainingMs / 1000);
    if (remainingSec <= 0) {
      btn.textContent = "Resend Code";
      btn.disabled = false;
      if (resendSignupCooldownTimer) clearInterval(resendSignupCooldownTimer);
      resendSignupCooldownTimer = null;
      return;
    }
    btn.textContent = `Resend Code (${remainingSec}s)`;
  };

  tick();
  resendSignupCooldownTimer = setInterval(tick, 250);
}

function startRecoveryCooldownUI(): void {
  const btn = getElSafe("forgot-send-btn") as HTMLButtonElement | null;
  if (!btn) return;

  if (recoveryCooldownTimer) clearInterval(recoveryCooldownTimer);
  btn.disabled = true;

  const tick = () => {
    const remainingMs = Math.max(0, recoveryCooldownUntil - Date.now());
    const remainingSec = Math.ceil(remainingMs / 1000);
    if (remainingSec <= 0) {
      btn.textContent = "Send Recovery Code";
      btn.disabled = false;
      if (recoveryCooldownTimer) clearInterval(recoveryCooldownTimer);
      recoveryCooldownTimer = null;
      return;
    }
    btn.textContent = `Send Recovery Code (${remainingSec}s)`;
  };

  tick();
  recoveryCooldownTimer = setInterval(tick, 250);
}

async function handleSignOut(): Promise<void> {
  await stopScreenTimeTracking();
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  try {
    await signOut();
  } catch (e) {
    console.error("signOut failed:", e);
  }
  // Explicitly clear remember flag so next startup does not auto-login
  localStorage.setItem(REMEMBER_ME_KEY, "false");
  currentUserId = null;
  currentProfile = null;
  updateAdminButtonVisibility();
  todayTrackedSeconds = 0;
  dailyLimitSeconds = 0;
  dailyLimitNotified = false;
  resetTimerUI();
  showScreenWithWipe("splash-screen");
}

function updateTimerWelcome(): void {
  const el = getElSafe("timer-welcome");
  if (!el) return;
  const name = currentProfile?.display_name?.trim();
  el.textContent = name ? `Welcome, ${name}` : "";
}

function updateAdminButtonVisibility(): void {
  const adminBtn = getElSafe("go-admin-btn");
  if (!adminBtn) return;
  adminBtn.classList.toggle("hidden", currentProfile?.role !== "admin");
}

function formatHhMm(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  return hours + "h " + mins + "m";
}

function computeAgeFromBirthday(birthday: string | null): number | null {
  if (!birthday) return null;
  const dob = new Date(birthday);
  if (Number.isNaN(dob.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDelta = today.getMonth() - dob.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < dob.getDate())) {
    age--;
  }
  return age >= 0 ? age : null;
}

function updateDailyLimitIndicator(): void {
  const el = getElSafe("daily-goal-remaining");
  if (!el || !currentProfile) return;

  const limitHours = currentProfile.daily_screen_hours || 0;
  dailyLimitSeconds = Math.max(0, Math.round(limitHours * 3600));

  if (!dailyLimitSeconds) {
    el.textContent = "";
    return;
  }

  const overBy = todayTrackedSeconds - dailyLimitSeconds;
  if (overBy > 0) {
    el.textContent = formatHhMm(overBy) + " over";
  } else {
    const remaining = dailyLimitSeconds - todayTrackedSeconds;
    el.textContent = formatHhMm(remaining) + " remaining";
  }
}

async function initDailyScreenTracker(): Promise<void> {
  if (!currentUserId) return;
  try {
    const summary = await getScreenTimeSummary(currentUserId, "today");
    todayTrackedSeconds = summary.total_seconds || 0;
  } catch (e) {
    console.error("Failed to init daily tracker:", e);
    todayTrackedSeconds = 0;
  }
  dailyLimitNotified = false;
  updateDailyLimitIndicator();
}

// ===== Profile Setup =====
async function handleProfileSave(): Promise<void> {
  if (!currentUserId) return;
  hideError("profile-error");
  const authUser = await getCurrentUser();
  if (!authUser || authUser.id !== currentUserId) {
    showError("profile-error", "Session expired. Please log in again.");
    showScreenWithWipe("login-screen");
    return;
  }
  const birthday = pendingSignupBirthday || (getEl("profile-birthday") as HTMLInputElement).value;
  if (!birthday) {
    showError("profile-error", "Please enter your birthday.");
    return;
  }
  const age = computeAgeFromBirthday(birthday);
  if (age === null) {
    showError("profile-error", "Please enter a valid birthday.");
    return;
  }
  const workType = (getEl("profile-work-type") as HTMLSelectElement).value;
  const habit = (getEl("profile-habit") as HTMLSelectElement).value;
  const dailyHours = parseFloat((getEl("profile-daily-screen-hours") as HTMLInputElement).value) || 8;

  const profileResult = await updateProfile(currentUserId, {
    birthday,
    age,
    daily_screen_hours: dailyHours,
    work_type: workType,
    habit,
  });
  if (!profileResult.ok) {
    showError("profile-error", profileResult.error || "Failed to save profile.");
    return;
  }
  currentProfile = await getProfile(currentUserId);
  pendingSignupBirthday = null;
  updateProfileSetupUI();
  await loadUserSettings();
  updateTimerWelcome();
  showScreen("timer-screen");
}

function updateProfileSetupUI(): void {
  const birthdayGroup = getElSafe("profile-birthday-group");
  const ageGroup = getElSafe("profile-age-group");
  const hasSignupBirthday = !!pendingSignupBirthday;
  if (birthdayGroup) birthdayGroup.classList.toggle("hidden", hasSignupBirthday);
  if (ageGroup) ageGroup.classList.toggle("hidden", hasSignupBirthday);
}

// ===== Settings =====
type TimerPreset = "202020" | "pomodoro" | "custom";

function getPresetValues(preset: TimerPreset): { intervalMinutes: number; breakSeconds: number } {
  if (preset === "pomodoro") return { intervalMinutes: 25, breakSeconds: 300 };
  // 20-20-20
  return { intervalMinutes: 20, breakSeconds: 20 };
}

function inferPresetFromProfile(): TimerPreset {
  if (!currentProfile) return "202020";
  const i = currentProfile.break_interval_minutes;
  const d = currentProfile.break_duration_seconds;
  if (i === 20 && d === 20) return "202020";
  if (i === 25 && d === 300) return "pomodoro";
  return "custom";
}

function setCustomFieldsVisibility(show: boolean): void {
  const custom = getElSafe("settings-custom-fields");
  if (!custom) return;
  custom.classList.toggle("hidden", !show);
}

function applyPresetToUI(preset: TimerPreset): void {
  const presetEl = getElSafe("settings-timer-preset") as HTMLSelectElement | null;
  if (presetEl) presetEl.value = preset;

  if (preset === "custom") {
    setCustomFieldsVisibility(true);
    return;
  }

  setCustomFieldsVisibility(false);
  const values = getPresetValues(preset);
  (getEl("settings-break-interval") as HTMLInputElement).value = String(values.intervalMinutes);
  (getEl("settings-break-duration") as HTMLInputElement).value = String(values.breakSeconds);
}

function getNotificationModeDescription(mode: string): string {
  switch (mode) {
    case "light":
      return "Light: minimal interruption (no pre-break reminder notifications).";
    case "strict":
      return "Strict: frequent reminders at 5, 4, 3, 2, and 1 minute before break.";
    default:
      return "Moderate: balanced reminders at 2 minutes and 1 minute before break.";
  }
}

function updateNotificationModeHelp(mode: string): void {
  const helpEl = getElSafe("settings-notification-mode-help");
  if (!helpEl) return;
  helpEl.textContent = getNotificationModeDescription(mode);
}

async function loadSettingsUI(): Promise<void> {
  if (!currentProfile) return;
  (getEl("settings-break-interval") as HTMLInputElement).value = String(currentProfile.break_interval_minutes);
  (getEl("settings-break-duration") as HTMLInputElement).value = String(currentProfile.break_duration_seconds);
  (getEl("settings-notification-mode") as HTMLSelectElement).value = currentProfile.notification_mode;
  (getEl("settings-daily-screen-hours") as HTMLInputElement).value = String(currentProfile.daily_screen_hours || 8);
  updateNotificationModeHelp(currentProfile.notification_mode);
  applyPresetToUI(inferPresetFromProfile());

  try {
    const enabled = await invoke<boolean>("get_autostart");
    (getEl("settings-autostart") as HTMLInputElement).checked = !!enabled;
  } catch (e) {
    console.error("get_autostart failed:", e);
  }
}

async function handleSettingsSave(): Promise<void> {
  if (!currentUserId) return;
  const preset = ((getEl("settings-timer-preset") as HTMLSelectElement).value || "202020") as TimerPreset;
  const presetValues = preset === "custom" ? null : getPresetValues(preset);

  const breakInterval = presetValues
    ? presetValues.intervalMinutes
    : (parseInt((getEl("settings-break-interval") as HTMLInputElement).value) || 20);
  const breakDuration = presetValues
    ? presetValues.breakSeconds
    : (parseInt((getEl("settings-break-duration") as HTMLInputElement).value) || 20);
  const notifMode = (getEl("settings-notification-mode") as HTMLSelectElement).value;
  const dailyHours = parseFloat((getEl("settings-daily-screen-hours") as HTMLInputElement).value) || 8;
  const autostart = (getEl("settings-autostart") as HTMLInputElement).checked;

  const settingsResult = await updateProfile(currentUserId, {
    break_interval_minutes: breakInterval,
    break_duration_seconds: breakDuration,
    notification_mode: notifMode,
    daily_screen_hours: dailyHours,
  });
  if (!settingsResult.ok) {
    console.error("Failed to save settings profile fields:", settingsResult.error);
  }
  currentProfile = await getProfile(currentUserId);
  await loadUserSettings();
  updateTimerWelcome();

  try {
    await invoke("set_autostart", { enabled: autostart });
  } catch (e) {
    console.error("set_autostart failed:", e);
  }

  const msg = getElSafe("settings-saved-msg");
  if (msg) {
    msg.classList.remove("hidden");
    setTimeout(() => msg.classList.add("hidden"), 2000);
  }
}

async function loadProfileEditUI(): Promise<void> {
  if (!currentProfile) return;
  (getEl("profile-display-name") as HTMLInputElement).value = currentProfile.display_name || "";
  (getEl("profile-birthday-edit") as HTMLInputElement).value = currentProfile.birthday || "";
  const computedAge = computeAgeFromBirthday(currentProfile.birthday);
  (getEl("profile-age-edit") as HTMLInputElement).value = computedAge !== null
    ? String(computedAge)
    : currentProfile.age ? String(currentProfile.age) : "";
  (getEl("profile-work-type-edit") as HTMLSelectElement).value = currentProfile.work_type || "student";
  (getEl("profile-habit-edit") as HTMLSelectElement).value = (currentProfile as any).habit || "other";
}

async function handleProfileEditSave(): Promise<void> {
  hideError("profile-edit-error");
  if (!currentUserId) return;
  const name = (getEl("profile-display-name") as HTMLInputElement).value.trim();
  const birthday = currentProfile?.birthday || null;
  let age = currentProfile?.age || null;
  if (birthday) age = computeAgeFromBirthday(birthday);
  const workType = (getEl("profile-work-type-edit") as HTMLSelectElement).value;
  const habit = (getEl("profile-habit-edit") as HTMLSelectElement).value;

  const profileEditResult = await updateProfile(currentUserId, {
    display_name: name,
    birthday,
    age,
    work_type: workType,
    habit,
  });
  if (!profileEditResult.ok) {
    showError("profile-edit-error", profileEditResult.error || "Failed to save profile.");
    return;
  }

  currentProfile = await getProfile(currentUserId);
  updateTimerWelcome();
  updateDailyLimitIndicator();

  const msg = getElSafe("profile-edit-saved-msg");
  if (msg) {
    msg.classList.remove("hidden");
    setTimeout(() => msg.classList.add("hidden"), 2000);
  }
}

async function loadUserSettings(): Promise<void> {
  if (!currentProfile) return;
  TIMER_DURATION_SECONDS = currentProfile.break_interval_minutes * 60;
  BREAK_DURATION_SECONDS = currentProfile.break_duration_seconds;
  NOTIFICATION_MODE = currentProfile.notification_mode;

  const countdownEl = getElSafe("countdown-number");
  if (countdownEl) countdownEl.textContent = String(currentProfile.break_interval_minutes);
  updateDailyLimitIndicator();
}

// ===== Screen Time Monitoring =====
interface ActiveWindowInfo {
  app_name: string;
  window_title: string;
}

// Runs whenever the app is open and the user is logged in.
// Tracks total screen time plus the currently active app/window at OS level.
function startScreenTimeTracking(): void {
  if (screenTimeInterval) return;
  screenTimeAccumulator = 0;
  telemetryFlushCounter = 0;
  lastActiveAppName = "";
  activeAppAccumulator = 0;
  lastActiveWindowTitle = "";
  if (currentUserId) void initDailyScreenTracker();

  screenTimeInterval = setInterval(() => {
    if (!currentUserId || isSystemIdle) return;
    void sampleSystemActivity(currentUserId);
  }, 1000);
}

async function stopScreenTimeTracking(): Promise<void> {
  if (screenTimeInterval) {
    clearInterval(screenTimeInterval);
    screenTimeInterval = null;
  }
  if (currentUserId) {
    await flushTelemetry(currentUserId, true);
  }
}

async function sampleSystemActivity(userId: string): Promise<void> {
  screenTimeAccumulator++;
  telemetryFlushCounter++;
  todayTrackedSeconds++;
  updateDailyLimitIndicator();

  if (!dailyLimitNotified && dailyLimitSeconds > 0 && todayTrackedSeconds >= dailyLimitSeconds) {
    dailyLimitNotified = true;
    invoke("send_notification", {
      title: "eyeCATCHER",
      body: "You've reached your daily screen-time goal (" + formatHhMm(dailyLimitSeconds) + "). Consider taking a longer break.",
    }).catch(console.error);
  }

  try {
    const activeWindow = await invoke<ActiveWindowInfo | null>("get_active_window_info");
    if (activeWindow && activeWindow.app_name) {
      if (!lastActiveAppName) {
        lastActiveAppName = activeWindow.app_name;
        lastActiveWindowTitle = activeWindow.window_title || "";
        activeAppAccumulator = 1;
      } else if (activeWindow.app_name === lastActiveAppName) {
        activeAppAccumulator++;
        lastActiveWindowTitle = activeWindow.window_title || lastActiveWindowTitle;
      } else {
        await updateAppUsage(userId, lastActiveAppName, lastActiveWindowTitle, activeAppAccumulator);
        lastActiveAppName = activeWindow.app_name;
        lastActiveWindowTitle = activeWindow.window_title || "";
        activeAppAccumulator = 1;
      }
    }
  } catch (e) {
    console.error("get_active_window_info failed:", e);
  }

  if (telemetryFlushCounter >= 60) {
    await flushTelemetry(userId, false);
  }
}

async function flushTelemetry(userId: string, force: boolean): Promise<void> {
  if (!force && telemetryFlushCounter < 60) return;
  if (screenTimeAccumulator > 0) {
    await updateScreenTime(userId, screenTimeAccumulator, false);
    screenTimeAccumulator = 0;
  }

  if (activeAppAccumulator > 0 && lastActiveAppName) {
    await updateAppUsage(userId, lastActiveAppName, lastActiveWindowTitle, activeAppAccumulator);
    activeAppAccumulator = 0;
  }

  telemetryFlushCounter = 0;
}

// ===== Minute Scroll Rendering =====
function renderMinuteScroll(): void {
  const container = getEl("minute-scroll-list");
  container.innerHTML = "";

  const remaining = TIMER_DURATION_SECONDS - timerState.elapsed_seconds;
  const displayTime = Math.max(0, remaining);
  const currentMinute = Math.floor(displayTime / 60);
  const currentSecond = displayTime % 60;

  for (let i = -2; i <= 2; i++) {
    const minute = currentMinute + i;
    if (minute < 0) continue;

    const item = document.createElement("div");
    const isCurrent = i === 0;

    if (isCurrent) {
      item.className = "minute-item current";
      item.innerHTML = '<span class="minute-number">' + minute + '</span><span class="second-number">' + currentSecond.toString().padStart(2, "0") + '</span>';
    } else {
      item.className = "minute-item";
      item.textContent = String(minute);
    }

    container.appendChild(item);
  }
}

// ===== Timer Logic =====
function startTimer(): void {
  timerState = {
    is_running: true,
    is_paused: false,
    elapsed_seconds: 0,
    idle_count: 0,
  };
  sentReminderMarks.clear();

  // Focus mode: hide title + welcome while timer runs
  getEl("timer-app-title").classList.add("hidden");
  getEl("timer-welcome").classList.add("hidden");

  getEl("timer-idle").classList.add("hidden");
  getEl("timer-running").classList.remove("hidden");
  getEl("terminate-btn").classList.remove("hidden");

  renderMinuteScroll();
  updateTimerDisplay();

  invoke("start_timer").catch(console.error);

  timerInterval = setInterval(() => {
    if (!timerState.is_paused && timerState.is_running) {
      timerState.elapsed_seconds++;
      updateTimerDisplay();
      checkTimerMilestones();
    }
  }, 1000);
}

function updateTimerDisplay(): void {
  renderMinuteScroll();
  const indicator = getElSafe("timer-idle-indicator");
  if (indicator) {
    if (timerState.is_running && timerState.is_paused) {
      indicator.classList.remove("hidden");
    } else {
      indicator.classList.add("hidden");
    }
  }
}

function checkTimerMilestones(): void {
  const remaining = Math.max(0, TIMER_DURATION_SECONDS - timerState.elapsed_seconds);
  processModeReminders(remaining);
  if (timerState.elapsed_seconds >= TIMER_DURATION_SECONDS) {
    triggerBlurOverlay();
  }
}

function getReminderMarksForMode(mode: string): number[] {
  // Marks are "seconds remaining" before break.
  // light: minimal interruption
  if (mode === "light") return [];
  // moderate: two reminders
  if (mode === "moderate") return [120, 60];
  // strict: frequent reminders
  return [300, 240, 180, 120, 60];
}

function processModeReminders(remainingSeconds: number): void {
  const marks = getReminderMarksForMode(NOTIFICATION_MODE);
  for (const mark of marks) {
    if (remainingSeconds <= mark && !sentReminderMarks.has(mark)) {
      sentReminderMarks.add(mark);
      showAlertNotification(mark);
    }
  }
}

function showAlertNotification(reminderMarkSeconds: number): void {
  if (NOTIFICATION_MODE === "light") return;
  const mins = Math.max(1, Math.floor(reminderMarkSeconds / 60));
  const modePrefix = NOTIFICATION_MODE === "strict" ? "[Strict] " : "";
  invoke("send_notification", {
    title: "eyeCATCHER",
    body: modePrefix + mins + " minute(s) left before eye break!",
  }).catch(console.error);
}

async function triggerBlurOverlay(): Promise<void> {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }

  if (currentUserId) {
    await updateScreenTime(currentUserId, 0, true);
  }

  const tip = await getRandomTip();
  if (tip) {
    localStorage.setItem("eyecatcher_break_tip_title", tip.title);
    localStorage.setItem("eyecatcher_break_tip_desc", tip.description);
    localStorage.setItem("eyecatcher_break_tip_cat", tip.category);
  } else {
    localStorage.removeItem("eyecatcher_break_tip_title");
    localStorage.removeItem("eyecatcher_break_tip_desc");
    localStorage.removeItem("eyecatcher_break_tip_cat");
  }
  localStorage.setItem("eyecatcher_break_duration", String(BREAK_DURATION_SECONDS));

  invoke("open_blur_overlay").catch(console.error);
}

async function onBlurComplete(): Promise<void> {
  if (currentUserId) {
    const ok = await saveSessionToSupabase(currentUserId, true, timerState.idle_count, timerState.elapsed_seconds);
    if (!ok) console.error("Failed to save successful session to Supabase.");
  }
  invoke("save_session", { successful: true, idleCount: timerState.idle_count }).catch(console.error);
  resetTimerUI();
  startTimer();
}

async function terminateTimer(): Promise<void> {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  timerState.is_running = false;

  if (currentUserId) {
    const ok = await saveSessionToSupabase(currentUserId, false, timerState.idle_count, timerState.elapsed_seconds);
    if (!ok) console.error("Failed to save terminated session to Supabase.");
  }
  invoke("save_session", { successful: false, idleCount: timerState.idle_count }).catch(console.error);
  invoke("stop_timer").catch(console.error);

  resetTimerUI();
}

function resetTimerUI(): void {
  // Exit focus mode
  getEl("timer-app-title").classList.remove("hidden");
  getEl("timer-welcome").classList.remove("hidden");

  getEl("timer-idle").classList.remove("hidden");
  getEl("timer-running").classList.add("hidden");
  getEl("terminate-btn").classList.add("hidden");

  timerState = { is_running: false, is_paused: false, elapsed_seconds: 0, idle_count: 0 };
  sentReminderMarks.clear();

  const indicator = getElSafe("timer-idle-indicator");
  if (indicator) indicator.classList.add("hidden");

  const countdownEl = getElSafe("countdown-number");
  if (countdownEl && currentProfile) {
    countdownEl.textContent = String(currentProfile.break_interval_minutes);
  }
}

function pauseTimer(): void {
  if (timerState.is_running && !timerState.is_paused) {
    timerState.is_paused = true;
    timerState.idle_count++;
    updateTimerDisplay();
    invoke("pause_timer").catch(console.error);
  }
}

function resumeTimer(): void {
  if (timerState.is_running && timerState.is_paused) {
    timerState.is_paused = false;
    updateTimerDisplay();
    invoke("resume_timer").catch(console.error);
  }
}

// ===== Statistics =====
function shiftPeriodAnchor(period: string, anchor: Date, step: number): Date {
  const next = new Date(anchor);
  if (period === "today") {
    next.setDate(next.getDate() + step);
    return next;
  }
  if (period === "weekly") {
    next.setDate(next.getDate() + step * 7);
    return next;
  }
  next.setMonth(next.getMonth() + step);
  return next;
}

function isFuturePeriod(period: string, anchor: Date): boolean {
  const now = new Date();
  if (period === "today") {
    return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())
      > new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  if (period === "weekly") {
    const anchorStart = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    anchorStart.setDate(anchorStart.getDate() - anchorStart.getDay());
    const nowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    nowStart.setDate(nowStart.getDate() - nowStart.getDay());
    return anchorStart > nowStart;
  }
  return (
    anchor.getFullYear() > now.getFullYear() ||
    (anchor.getFullYear() === now.getFullYear() && anchor.getMonth() > now.getMonth())
  );
}

function updateStatsPeriodNavButtons(): void {
  const nextBtn = getElSafe("stats-period-next") as HTMLButtonElement | null;
  if (!nextBtn) return;
  nextBtn.disabled = isFuturePeriod(currentStatsPeriod, shiftPeriodAnchor(currentStatsPeriod, statsAnchorDate, 1));
}

function switchStats(period: string, resetAnchor: boolean = false): void {
  currentStatsPeriod = period;
  if (resetAnchor) statsAnchorDate = new Date();
  void loadStats(period);
  updateStatsTabs();
  updateStatsPeriodLabel(period, statsAnchorDate);
  updateStatsPeriodNavButtons();
}

function updateStatsTabs(): void {
  const map: Record<string, string> = {
    weekly: "tab-weekly",
    today: "tab-daily",
    monthly: "tab-monthly",
  };
  document.querySelectorAll(".tab-btn").forEach((btn) => btn.classList.remove("active"));
  const activeId = map[currentStatsPeriod];
  if (activeId) getEl(activeId).classList.add("active");
}

function formatMmDd(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return mm + "-" + dd;
}

function updateStatsPeriodLabel(period: string, anchor: Date): void {
  const label = getElSafe("stats-period-label");
  if (!label) return;

  if (period === "weekly") {
    const start = new Date(anchor);
    start.setDate(start.getDate() - start.getDay());
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    label.textContent = formatMmDd(start) + " ~ " + formatMmDd(end);
    return;
  }

  if (period === "monthly") {
    label.textContent = anchor.toLocaleString("en-US", { month: "long", year: "numeric" });
    return;
  }

  label.textContent = anchor.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function getLiveIdleAdjustment(period: string): number {
  // Include idle events from the currently running (unsaved) session
  // so the stat updates immediately when auto-idle pause happens.
  if (!timerState.is_running) return 0;

  const now = new Date();
  if (period === "today") return timerState.idle_count;

  if (period === "weekly") {
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - 7);
    return now >= weekStart ? timerState.idle_count : 0;
  }

  if (period === "monthly") {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    return now >= monthStart ? timerState.idle_count : 0;
  }

  return 0;
}

async function loadStats(period: string): Promise<void> {
  if (!currentUserId) return;
  try {
    const stats = await getSessionStats(currentUserId, period, statsAnchorDate);
    getEl("stat-successful").textContent = String(stats.successful_sessions);
    getEl("stat-terminations").textContent = String(stats.terminations);
    const liveIdleAdjustment = getLiveIdleAdjustment(period);
    getEl("stat-idles").textContent = String(stats.idle_count + liveIdleAdjustment);

    const summary = await getScreenTimeSummary(currentUserId, period, statsAnchorDate);
    const hours = Math.floor(summary.total_seconds / 3600);
    const mins = Math.floor((summary.total_seconds % 3600) / 60);
    getEl("stat-screen-time").textContent = hours + "h " + mins + "m";
    await loadTopApps(currentUserId, period);
    updateStatsPeriodLabel(period, statsAnchorDate);
    updateStatsPeriodNavButtons();
  } catch (e) {
    console.error("Failed to load stats:", e);
  }
}

function formatDurationCompact(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return hours + "h " + mins + "m";
  return mins + "m";
}

async function loadTopApps(userId: string, period: string): Promise<void> {
  const listEl = getElSafe("top-apps-list");
  if (!listEl) return;

  listEl.innerHTML = "";
  const apps = await getTopAppsForPeriod(userId, period, 5, statsAnchorDate);

  if (apps.length === 0) {
    const empty = document.createElement("div");
    empty.className = "top-apps-empty";
    empty.textContent = "No app usage data yet.";
    listEl.appendChild(empty);
    return;
  }

  for (const app of apps) {
    const row = document.createElement("div");
    row.className = "top-app-row";
    row.innerHTML = '<span class="top-app-name">' + escapeHtml(app.app_name) + "</span>" +
      '<span class="top-app-time">' + formatDurationCompact(app.total_seconds) + "</span>";
    listEl.appendChild(row);
  }
}

// ===== HTML Escaping =====
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ===== Admin Panel =====
function renderOverallAnalytics(totalUsers: number, allSessionsData: Array<{ user_id: string; successful: boolean }>, allLogs: Array<{ user_id: string; total_seconds: number }>): void {
  const totalSessions = allSessionsData.length;
  const totalTerminations = allSessionsData.filter(s => !s.successful).length;
  const totalSeconds = allLogs.reduce((sum, l) => sum + l.total_seconds, 0);
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);

  getEl("analytics-total-users").textContent = String(totalUsers);
  getEl("analytics-total-sessions").textContent = String(totalSessions);
  getEl("analytics-terminations").textContent = String(totalTerminations);
  getEl("analytics-total-screen-hours").textContent = hours + "h " + mins + "m";
}

function updateAdminPeriodTabs(): void {
  const mapping: Record<string, string> = {
    today: "analytics-period-daily",
    weekly: "analytics-period-weekly",
    monthly: "analytics-period-monthly",
  };
  ["analytics-period-daily", "analytics-period-weekly", "analytics-period-monthly"]
    .forEach((id) => getEl(id).classList.remove("active"));
  getEl(mapping[currentAdminUserPeriod]).classList.add("active");
}

function updateAdminPeriodNavButtons(): void {
  const nextBtn = getElSafe("analytics-period-next") as HTMLButtonElement | null;
  if (!nextBtn) return;
  nextBtn.disabled = isFuturePeriod(
    currentAdminUserPeriod,
    shiftPeriodAnchor(currentAdminUserPeriod, adminAnchorDate, 1),
  );
}

function getAdminPeriodLabel(period: "today" | "weekly" | "monthly", anchor: Date): string {
  if (period === "today") {
    return anchor.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }
  if (period === "weekly") {
    const start = new Date(anchor);
    start.setDate(start.getDate() - start.getDay());
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return formatMmDd(start) + " ~ " + formatMmDd(end);
  }
  if (period === "monthly") {
    return anchor.toLocaleString("en-US", { month: "long", year: "numeric" });
  }
  return "";
}

async function renderSelectedUserAnalytics(userId: string): Promise<void> {
  const stats = await getSessionStats(userId, currentAdminUserPeriod, adminAnchorDate);
  const summary = await getScreenTimeSummary(userId, currentAdminUserPeriod, adminAnchorDate);
  const totalSeconds = summary.total_seconds || 0;
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);

  getEl("analytics-user-sessions").textContent = String(stats.successful_sessions + stats.terminations);
  getEl("analytics-user-terminations").textContent = String(stats.terminations);
  getEl("analytics-user-screen-hours").textContent = hours + "h " + mins + "m";
  getEl("analytics-user-breaks").textContent = String(summary.breaks_taken || 0);
  getEl("analytics-user-period-label").textContent = getAdminPeriodLabel(currentAdminUserPeriod, adminAnchorDate);
  updateAdminPeriodNavButtons();
}

async function loadAdminPanel(): Promise<void> {
  const profiles = await getAllProfiles();
  const userListEl = getEl("admin-user-list");
  userListEl.innerHTML = "";
  pendingRoleChanges.clear();
  updatePendingRoleStatus("");

  for (const p of profiles) {
    const row = document.createElement("div");
    row.className = "admin-row";
    const nameText = escapeHtml(p.display_name || "N/A");
    const userSelected = p.role === "user" ? "selected" : "";
    const adminSelected = p.role === "admin" ? "selected" : "";
    const roleLocked = p.id === currentUserId && p.role === "admin";
    const disabledAttr = roleLocked ? "disabled" : "";
    const deleteDisabledAttr = roleLocked ? "disabled" : "";
    row.innerHTML = '<span class="admin-row-name">' + nameText + "</span>" +
      '<span class="admin-row-meta">' + escapeHtml(p.work_type) + " | " + escapeHtml(p.role) + "</span>" +
      '<select class="admin-role-select" data-uid="' + escapeHtml(p.id) + '" data-current-role="' + escapeHtml(p.role) + '" ' + disabledAttr + '>' +
      '<option value="user" ' + userSelected + ">User</option>" +
      '<option value="admin" ' + adminSelected + ">Admin</option>" +
      "</select>" +
      '<button class="admin-user-remove-btn" data-uid="' + escapeHtml(p.id) + '" ' + deleteDisabledAttr + '>Remove</button>';
    userListEl.appendChild(row);
  }

  userListEl.querySelectorAll(".admin-role-select").forEach((sel) => {
    sel.addEventListener("change", async (e) => {
      const target = e.target as HTMLSelectElement;
      const uid = target.getAttribute("data-uid");
      const currentRole = target.getAttribute("data-current-role");
      if (!uid || !currentRole) return;

      if (target.value === currentRole) pendingRoleChanges.delete(uid);
      else pendingRoleChanges.set(uid, target.value);

      updatePendingRoleStatus();
    });
  });

  userListEl.querySelectorAll(".admin-user-remove-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const uid = btn.getAttribute("data-uid");
      if (!uid || uid === currentUserId) return;

      const okConfirm = await showConfirmModal(
        "Remove User",
        "Remove this user from the app? This deletes their profile and usage data."
      );
      if (!okConfirm) return;

      const ok = await removeUserFromApp(uid);
      if (!ok) {
        updatePendingRoleStatus("Failed to remove user. Check console/logs.");
        return;
      }
      await loadAdminPanel();
      updatePendingRoleStatus("User removed from app.");
    });
  });

  const allSessionsData = await getAllSessions();
  const allLogs = await getAllScreenTimeLogs();
  const totalUsers = profiles.length;
  renderOverallAnalytics(totalUsers, allSessionsData, allLogs as Array<{ user_id: string; total_seconds: number }>);

  const userSelect = getElSafe("analytics-user-select") as HTMLSelectElement | null;
  if (userSelect) {
    userSelect.innerHTML = "";
    for (const p of profiles) {
      const option = document.createElement("option");
      option.value = p.id;
      option.textContent = (p.display_name && p.display_name.trim())
        ? p.display_name + " (" + p.role + ")"
        : "Unnamed (" + p.role + ")";
      userSelect.appendChild(option);
    }

    if (profiles.length > 0) {
      await renderSelectedUserAnalytics(userSelect.value);
    } else {
      getEl("analytics-user-sessions").textContent = "0";
      getEl("analytics-user-terminations").textContent = "0";
      getEl("analytics-user-screen-hours").textContent = "0h";
      getEl("analytics-user-breaks").textContent = "0";
      getEl("analytics-user-period-label").textContent = "";
    }

    userSelect.onchange = async () => {
      await renderSelectedUserAnalytics(userSelect.value);
    };
  }

  updateAdminPeriodTabs();
  const wirePeriod = (period: "today" | "weekly" | "monthly") => async () => {
    currentAdminUserPeriod = period;
    adminAnchorDate = new Date();
    updateAdminPeriodTabs();
    const userSelect = getElSafe("analytics-user-select") as HTMLSelectElement | null;
    if (userSelect && userSelect.value) await renderSelectedUserAnalytics(userSelect.value);
  };
  getEl("analytics-period-daily").onclick = wirePeriod("today");
  getEl("analytics-period-weekly").onclick = wirePeriod("weekly");
  getEl("analytics-period-monthly").onclick = wirePeriod("monthly");

  const config = await getSystemConfig();
  (getEl("admin-break-interval") as HTMLInputElement).value = String(config["default_break_interval_minutes"] || 20);
  (getEl("admin-break-duration") as HTMLInputElement).value = String(config["default_break_duration_seconds"] || 20);
  const rawMode = config["default_notification_mode"];
  const modeStr = typeof rawMode === "string" ? rawMode.replace(/"/g, "") : "moderate";
  (getEl("admin-notification-mode") as HTMLSelectElement).value = modeStr;

  await loadAdminTips();
}

function updatePendingRoleStatus(overrideText: string = ""): void {
  const statusEl = getElSafe("admin-roles-status");
  if (!statusEl) return;

  if (overrideText) {
    statusEl.textContent = overrideText;
    statusEl.classList.remove("hidden");
    return;
  }

  const count = pendingRoleChanges.size;
  if (count <= 0) {
    statusEl.textContent = "";
    statusEl.classList.add("hidden");
    return;
  }

  statusEl.textContent = count + " pending role change(s). Click Apply Changes to save.";
  statusEl.classList.remove("hidden");
}

async function handleApplyRoleChanges(): Promise<void> {
  if (pendingRoleChanges.size === 0) {
    updatePendingRoleStatus("No pending role changes.");
    return;
  }

  let success = 0;
  for (const [uid, role] of pendingRoleChanges.entries()) {
    const ok = await updateUserRole(uid, role);
    if (ok) success++;
  }

  pendingRoleChanges.clear();
  await loadAdminPanel();
  updatePendingRoleStatus("Applied " + success + " role change(s).");
}

async function loadAdminTips(): Promise<void> {
  const tips = await getAllTips();
  const tipsListEl = getEl("admin-tips-list");
  tipsListEl.innerHTML = "";
  for (const tip of tips) {
    const row = document.createElement("div");
    row.className = "admin-tip-row";
    const toggleLabel = tip.is_active ? "Deactivate" : "Activate";
    row.innerHTML = '<div class="admin-tip-info">' +
      "<strong>" + escapeHtml(tip.title) + "</strong>" +
      '<span class="admin-tip-cat">' + escapeHtml(tip.category) + "</span>" +
      "<p>" + escapeHtml(tip.description) + "</p>" +
      "</div>" +
      '<div class="admin-tip-actions">' +
      '<button class="admin-tip-toggle" data-id="' + escapeHtml(tip.id) + '" data-active="' + tip.is_active + '">' + toggleLabel + "</button>" +
      '<button class="admin-tip-remove" data-id="' + escapeHtml(tip.id) + '">Remove</button>' +
      "</div>";
    tipsListEl.appendChild(row);
  }

  tipsListEl.querySelectorAll(".admin-tip-toggle").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id")!;
      const isActive = btn.getAttribute("data-active") === "true";
      await updateTip(id, { is_active: !isActive });
      await loadAdminTips();
    });
  });

  tipsListEl.querySelectorAll(".admin-tip-remove").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id")!;
      await deleteTip(id);
      await loadAdminTips();
    });
  });
}

async function handleAdminConfigSave(): Promise<void> {
  const interval = parseInt((getEl("admin-break-interval") as HTMLInputElement).value) || 20;
  const duration = parseInt((getEl("admin-break-duration") as HTMLInputElement).value) || 20;
  const mode = (getEl("admin-notification-mode") as HTMLSelectElement).value;

  await updateSystemConfig("default_break_interval_minutes", interval);
  await updateSystemConfig("default_break_duration_seconds", duration);
  await updateSystemConfig("default_notification_mode", '"' + mode + '"');

  const msg = getElSafe("admin-config-saved");
  if (msg) { msg.classList.remove("hidden"); setTimeout(() => msg.classList.add("hidden"), 2000); }
}

async function handleAddTip(): Promise<void> {
  const title = (getEl("new-tip-title") as HTMLInputElement).value.trim();
  const desc = (getEl("new-tip-desc") as HTMLTextAreaElement).value.trim();
  const cat = (getEl("new-tip-category") as HTMLSelectElement).value;
  if (!title || !desc) return;

  await createTip(title, desc, cat);
  (getEl("new-tip-title") as HTMLInputElement).value = "";
  (getEl("new-tip-desc") as HTMLTextAreaElement).value = "";
  await loadAdminTips();
}

function showAdminTab(tabId: string): void {
  document.querySelectorAll(".admin-tab-content").forEach(t => t.classList.add("hidden"));
  document.querySelectorAll(".admin-tab-btn").forEach(b => b.classList.remove("active"));
  getEl(tabId).classList.remove("hidden");
  const btn = document.querySelector('[data-admin-tab="' + tabId + '"]');
  if (btn) btn.classList.add("active");
}

// ===== Event Listeners from Rust Backend =====
async function setupBackendListeners(): Promise<void> {
  await listen("user-idle", () => {
    isSystemIdle = true;
    if (timerState.is_running && !timerState.is_paused) {
      invoke("send_notification", {
        title: "eyeCATCHER",
        body: "You were idle for 2 minutes. Timer is paused and Idle Count +1.",
      }).catch(console.error);
      pauseTimer();
      if (isScreenActive("stats-screen")) {
        void loadStats(currentStatsPeriod);
      }
    }
  });

  await listen("user-active", () => {
    isSystemIdle = false;
    if (timerState.is_running && timerState.is_paused) {
      resumeTimer();
      if (isScreenActive("stats-screen")) {
        void loadStats(currentStatsPeriod);
      }
    }
  });

  await listen("blur-complete", () => {
    onBlurComplete();
  });
}

// ===== Initialization =====
window.addEventListener("DOMContentLoaded", async () => {
  // --- Navigation between splash / login / signup ---
  getEl("splash-login-btn").addEventListener("click", () => {
    hideError("login-error");
    showScreenWithWipe("login-screen");
  });
  getEl("splash-signup-btn").addEventListener("click", () => {
    hideError("signup-error");
    pendingSignupBirthday = null;
    updateProfileSetupUI();
    showScreenWithWipe("signup-screen");
  });
  getEl("login-to-signup").addEventListener("click", () => {
    hideError("signup-error");
    pendingSignupBirthday = null;
    updateProfileSetupUI();
    showScreenWithWipe("signup-screen");
  });
  getEl("signup-to-login").addEventListener("click", () => {
    hideError("login-error");
    showScreenWithWipe("login-screen");
  });
  document.querySelectorAll(".front-back-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-back-to") || "splash-screen";
      hideError("login-error");
      hideError("signup-error");
      showScreen(target);
    });
  });

  getElSafe("login-forgot")?.addEventListener("click", () => {
    (getEl("forgot-email") as HTMLInputElement).value =
      (getEl("login-email") as HTMLInputElement).value.trim();
    hideError("forgot-error");
    showScreenWithWipe("forgot-screen");
  });

  // --- Check persisted session, honoring Remember Me ---
  let user = null;
  try {
    const remember = localStorage.getItem(REMEMBER_ME_KEY) !== "false";
    if (!remember) {
      // User previously opted out of persistence — clear any stale session.
      try { await signOut(); } catch {}
    } else {
      user = await getCurrentUser();
    }
  } catch (e) {
    console.error("Failed to check auth status:", e);
  }

  if (user) {
    currentUserId = user.id;
    await syncMyAdminRole();
    try {
      currentProfile = await getProfile(user.id);
    } catch (e) {
      console.error("Failed to load profile:", e);
    }
    if (currentProfile) {
      await loadUserSettings();
      updateTimerWelcome();
      updateAdminButtonVisibility();
      startScreenTimeTracking();
      showScreenWithWipe("timer-screen");
    } else {
      startScreenTimeTracking();
      showScreenWithWipe("profile-setup-screen");
    }
  }

  // --- Auth form submissions ---
  getEl("login-submit-btn").addEventListener("click", handleSignIn);
  getEl("signup-submit-btn").addEventListener("click", handleSignUp);
  getEl("verify-signup-submit-btn").addEventListener("click", handleVerifySignupCode);
  getEl("verify-signup-resend-btn").addEventListener("click", handleResendSignupCode);
  getEl("verify-signup-back-btn").addEventListener("click", () => {
    hideError("verify-signup-error");
    showScreenWithWipe("signup-screen");
  });
  getEl("forgot-send-btn").addEventListener("click", handleSendRecoveryCode);
  getEl("forgot-back-btn").addEventListener("click", () => {
    hideError("forgot-error");
    showScreenWithWipe("login-screen");
  });
  getEl("reset-password-submit-btn").addEventListener("click", handleResetPassword);
  getEl("reset-password-back-btn").addEventListener("click", () => {
    hideError("reset-error");
    showScreenWithWipe("forgot-screen");
  });

  getEl("login-password").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") handleSignIn();
  });
  getEl("signup-confirm").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") handleSignUp();
  });
  getEl("verify-signup-code").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") handleVerifySignupCode();
  });
  getEl("forgot-email").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") handleSendRecoveryCode();
  });
  getEl("reset-password-confirm").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") handleResetPassword();
  });

  getEl("profile-save-btn").addEventListener("click", handleProfileSave);
  getElSafe("profile-birthday")?.addEventListener("change", () => {
    const birthday = (getEl("profile-birthday") as HTMLInputElement).value;
    const age = computeAgeFromBirthday(birthday);
    const ageField = getElSafe("profile-age") as HTMLInputElement | null;
    if (ageField) ageField.value = age !== null ? String(age) : "";
  });
  getElSafe("profile-birthday-edit")?.addEventListener("change", () => {
    const birthday = (getEl("profile-birthday-edit") as HTMLInputElement).value;
    const age = computeAgeFromBirthday(birthday);
    const ageField = getElSafe("profile-age-edit") as HTMLInputElement | null;
    if (ageField) ageField.value = age !== null ? String(age) : "";
  });
  getEl("start-timer-btn").addEventListener("click", () => {
    playWipeTransition(() => { startTimer(); });
  });
  getEl("terminate-btn").addEventListener("click", () => { terminateTimer(); });

  getEl("go-stats-btn").addEventListener("click", () => {
    switchStats(currentStatsPeriod, false);
    showScreen("stats-screen");
  });

  getEl("go-timer-btn").addEventListener("click", () => { showScreenWithWipe("timer-screen"); });

  getEl("go-settings-btn").addEventListener("click", () => {
    loadSettingsUI();
    showScreen("settings-screen");
  });
  getEl("go-admin-btn").addEventListener("click", async () => {
    if (currentProfile?.role !== "admin") return;
    await loadAdminPanel();
    showScreen("admin-screen");
  });
  getEl("settings-save-btn").addEventListener("click", handleSettingsSave);
  getEl("settings-notification-mode").addEventListener("change", (e) => {
    updateNotificationModeHelp((e.target as HTMLSelectElement).value);
  });
  getEl("settings-notification-mode").addEventListener("mouseover", () => {
    updateNotificationModeHelp((getEl("settings-notification-mode") as HTMLSelectElement).value);
  });
  getEl("settings-notification-mode").addEventListener("focus", () => {
    updateNotificationModeHelp((getEl("settings-notification-mode") as HTMLSelectElement).value);
  });
  getEl("settings-timer-preset").addEventListener("change", (e) => {
    const preset = (e.target as HTMLSelectElement).value as TimerPreset;
    applyPresetToUI(preset);
  });
  getEl("go-profile-btn").addEventListener("click", () => {
    loadProfileEditUI();
    showScreen("profile-screen");
  });
  getEl("settings-back-btn").addEventListener("click", () => { showScreenWithWipe("timer-screen"); });
  getEl("settings-logout-btn").addEventListener("click", handleSignOut);
  getEl("profile-edit-save-btn").addEventListener("click", handleProfileEditSave);
  getEl("profile-back-btn").addEventListener("click", () => { showScreen("settings-screen"); });

  getEl("tab-weekly").addEventListener("click", () => { switchStats("weekly", true); });
  getEl("tab-daily").addEventListener("click", () => { switchStats("today", true); });
  getEl("tab-monthly").addEventListener("click", () => { switchStats("monthly", true); });
  getEl("stats-period-prev").addEventListener("click", () => {
    statsAnchorDate = shiftPeriodAnchor(currentStatsPeriod, statsAnchorDate, -1);
    void loadStats(currentStatsPeriod);
  });
  getEl("stats-period-next").addEventListener("click", () => {
    const next = shiftPeriodAnchor(currentStatsPeriod, statsAnchorDate, 1);
    if (isFuturePeriod(currentStatsPeriod, next)) return;
    statsAnchorDate = next;
    void loadStats(currentStatsPeriod);
  });

  document.querySelectorAll(".admin-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.getAttribute("data-admin-tab");
      if (tabId) showAdminTab(tabId);
    });
  });

  getElSafe("admin-config-save-btn")?.addEventListener("click", handleAdminConfigSave);
  getElSafe("admin-add-tip-btn")?.addEventListener("click", handleAddTip);
  getElSafe("admin-apply-roles-btn")?.addEventListener("click", handleApplyRoleChanges);
  getElSafe("admin-back-btn")?.addEventListener("click", () => { showScreenWithWipe("timer-screen"); });
  getElSafe("analytics-period-prev")?.addEventListener("click", async () => {
    adminAnchorDate = shiftPeriodAnchor(currentAdminUserPeriod, adminAnchorDate, -1);
    const userSelect = getElSafe("analytics-user-select") as HTMLSelectElement | null;
    if (userSelect && userSelect.value) await renderSelectedUserAnalytics(userSelect.value);
  });
  getElSafe("analytics-period-next")?.addEventListener("click", async () => {
    const next = shiftPeriodAnchor(currentAdminUserPeriod, adminAnchorDate, 1);
    if (isFuturePeriod(currentAdminUserPeriod, next)) return;
    adminAnchorDate = next;
    const userSelect = getElSafe("analytics-user-select") as HTMLSelectElement | null;
    if (userSelect && userSelect.value) await renderSelectedUserAnalytics(userSelect.value);
  });

  // Theme toggle
  getEl("theme-toggle-btn").addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("eyecatcher-theme", next);
  });

  setupBackendListeners().catch((e) => console.error("Backend listeners failed:", e));

  // Forward local UI activity to Rust so the system-idle monitor stays responsive
  // even when only the app window has focus.
  const reportActivity = () => { invoke("report_activity").catch(() => {}); };
  document.addEventListener("mousemove", reportActivity);
  document.addEventListener("keydown", reportActivity);
  document.addEventListener("click", reportActivity);
  document.addEventListener("scroll", reportActivity);

  supabase.auth.onAuthStateChange(async (_event, session) => {
    if (_event === "SIGNED_OUT") {
      currentUserId = null;
      currentProfile = null;
      updateAdminButtonVisibility();
    } else if (session?.user) {
      currentUserId = session.user.id;
      await syncMyAdminRole();
      currentProfile = await getProfile(session.user.id);
      updateTimerWelcome();
      updateAdminButtonVisibility();
    }
  });
});
