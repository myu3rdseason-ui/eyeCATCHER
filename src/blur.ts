import { invoke } from "@tauri-apps/api/core";

// Read break duration from localStorage (set by main window before opening overlay)
const storedDuration = localStorage.getItem("eyecatcher_break_duration");
const BLUR_DURATION_SECONDS = storedDuration ? parseInt(storedDuration) : 20;

window.addEventListener("DOMContentLoaded", () => {
  let countdown = BLUR_DURATION_SECONDS;
  const countdownEl = document.getElementById("blur-countdown-number");
  if (!countdownEl) return;

  countdownEl.textContent = String(countdown);

  // Display eye care tip if available
  const tipTitle = localStorage.getItem("eyecatcher_break_tip_title");
  const tipDesc = localStorage.getItem("eyecatcher_break_tip_desc");
  const tipTitleEl = document.getElementById("blur-tip-title");
  const tipDescEl = document.getElementById("blur-tip-desc");
  const tipContainer = document.getElementById("blur-tip-container");

  if (tipTitle && tipDesc && tipTitleEl && tipDescEl && tipContainer) {
    tipTitleEl.textContent = tipTitle;
    tipDescEl.textContent = tipDesc;
    tipContainer.style.display = "block";
  }

  const interval = setInterval(() => {
    countdown--;
    countdownEl.textContent = String(countdown);

    if (countdown <= 0) {
      clearInterval(interval);
      invoke("close_blur_overlay").catch(console.error);
    }
  }, 1000);
});
