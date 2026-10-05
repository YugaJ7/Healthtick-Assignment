// The full-screen layer shown while a session starts, and when it could not start:
// the percentage, its line of text, the error message and the access-code form.

const LOADING_TIMEOUT_MS = 120_000; // no new stage for this long means the start has failed

/**
 * @param {object} options
 * @param {() => boolean} options.isLoading whether the page is in its loading state
 * @param {() => void} options.onTimeout no progress for too long
 * @param {(code: string) => void} options.onCodeSubmitted the visitor typed an access code
 */
export function createLoadingScreen({ isLoading, onTimeout, onCodeSubmitted }) {
  const percentEl = document.getElementById('percent');
  const bar = document.getElementById('bar');
  const barFill = document.getElementById('bar-fill');
  const statusEl = document.getElementById('loading-status');
  const errorText = document.getElementById('error-text');
  const codeForm = document.getElementById('code-form');
  const codeInput = document.getElementById('code-input');
  let percent = 0;
  let timer = null;

  /**
   * @param {number} value 0 to 100; a lower value than the one showing is ignored, because
   *   a reconnect replays earlier stages and the number must not go backwards
   * @param {string} [label]
   */
  function set(value, label) {
    percent = Math.max(percent, value);
    percentEl.textContent = `${percent}%`;
    barFill.style.width = `${percent}%`;
    bar.setAttribute('aria-valuenow', String(percent));
    if (label) statusEl.textContent = label;
    clearTimeout(timer);
    if (isLoading()) timer = setTimeout(onTimeout, LOADING_TIMEOUT_MS);
  }

  function reset() {
    percent = 0;
    set(0, 'Connecting');
  }

  function showError(message) {
    clearTimeout(timer);
    errorText.textContent = message;
  }

  codeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = codeInput.value.trim();
    codeInput.value = '';
    onCodeSubmitted(code);
  });

  return {
    set,
    reset,
    showError,
    status: (text) => { statusEl.textContent = text; },
    isComplete: () => percent >= 100,
    stopTimer: () => clearTimeout(timer),
    askForCode: () => {
      codeForm.hidden = false;
      codeInput.focus();
    },
    hideCodeForm: () => { codeForm.hidden = true; },
  };
}
