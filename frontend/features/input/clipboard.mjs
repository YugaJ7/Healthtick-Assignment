// Device to computer: text copied on the device goes straight to this computer's
// clipboard. Browsers allow that only on HTTPS and only for the page in front, so the
// outcome is always said. (Computer to device is the paste handler in input.mjs.)

/**
 * @param {string} text what the device copied
 * @param {(text: string) => void} notice shows one line to the visitor
 */
export async function copyToThisComputer(text, notice) {
  try {
    await navigator.clipboard.writeText(text);
    notice('Copied from the device to this computer.');
  } catch {
    notice('The device copied some text, but this browser blocked putting it on your clipboard. Click the screen and press Ctrl+C again.');
  }
}
