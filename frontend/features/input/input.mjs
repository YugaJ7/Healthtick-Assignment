import { clientToVideoPoint } from './pointerMap.mjs';

const MAX_POINTERS = 10;
const MOUSE_BUTTON_PRIMARY = 0;
const MOUSE_BUTTON_SECONDARY = 2;

// Browser key names (KeyboardEvent.key) to the key names the server accepts.
const SPECIAL_KEYS = new Map([
  ['Enter', 'Enter'], ['Backspace', 'Backspace'], ['Delete', 'Delete'], ['Tab', 'Tab'], ['Escape', 'Back'],
  ['ArrowUp', 'ArrowUp'], ['ArrowDown', 'ArrowDown'], ['ArrowLeft', 'ArrowLeft'], ['ArrowRight', 'ArrowRight'],
  ['Home', 'MoveHome'], ['End', 'MoveEnd'],
]);

/**
 * What was typed between two states of a text field: how many characters were removed
 * from the end, and what was added. On-screen keyboards rewrite the word being typed as
 * they predict and correct, so comparing the whole field is the only reliable reading.
 * @param {string} before
 * @param {string} after
 * @returns {{ backspaces: number, text: string }}
 */
export function diffTyping(before, after) {
  const a = [...before];
  const b = [...after];
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same += 1;
  return { backspaces: a.length - same, text: b.slice(same).join('') };
}

const MAX_KEYBOARD_BUFFER = 200;

/**
 * Sends what is typed into `field` with a phone's on-screen keyboard to the device.
 * @param {HTMLTextAreaElement} field an invisible text field; focusing it opens the keyboard
 * @param {(message: object) => void} send
 */
export function attachSoftKeyboard(field, send) {
  let previous = '';
  const press = (key) => {
    send({ t: 'key', a: 'down', key });
    send({ t: 'key', a: 'up', key });
  };
  const reset = () => {
    field.value = '';
    previous = '';
  };
  field.addEventListener('input', () => {
    const { backspaces, text } = diffTyping(previous, field.value);
    for (let i = 0; i < backspaces; i += 1) press('Backspace');
    // A line break in the field is the keyboard's Enter key.
    text.split('\n').forEach((part, index) => {
      if (index > 0) press('Enter');
      if (part !== '') send({ t: 'text', text: part });
    });
    previous = field.value;
    // The field only exists to be compared with itself. Start afresh after Enter (a later
    // Backspace must not "delete the line break"), and between words once it has grown long.
    if (text.includes('\n') || (previous.length > MAX_KEYBOARD_BUFFER && /\s$/.test(previous))) reset();
  });
  // Backspace in an empty field changes nothing, so no input event comes; catch the key itself.
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Backspace' && field.value === '') press('Backspace');
  });
  field.addEventListener('blur', reset);
}

/**
 * Wires pointer, wheel and keyboard events on the canvas to input messages.
 * @param {HTMLCanvasElement} canvas
 * @param {(message: object) => void} send delivers one message to the server
 */
export function attachInput(canvas, send) {
  // Browser pointer ids can be any number; the device gets small slot numbers (0-9).
  const slots = new Map();

  function pointOf(event) {
    return clientToVideoPoint(event.clientX, event.clientY, canvas.getBoundingClientRect(), canvas.width, canvas.height);
  }

  function sendTouch(action, event) {
    const id = slots.get(event.pointerId);
    const point = pointOf(event);
    if (id === undefined || point === null) return;
    send({ t: 'touch', a: action, id, x: point.x, y: point.y });
  }

  function freeSlot() {
    const used = new Set(slots.values());
    for (let id = 0; id < MAX_POINTERS; id += 1) if (!used.has(id)) return id;
    return null;
  }

  function sendKeyPress(key) {
    send({ t: 'key', a: 'down', key });
    send({ t: 'key', a: 'up', key });
  }

  canvas.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    canvas.focus();
    if (event.pointerType === 'mouse' && event.button === MOUSE_BUTTON_SECONDARY) return sendKeyPress('Back');
    if (event.pointerType === 'mouse' && event.button !== MOUSE_BUTTON_PRIMARY) return;
    const id = freeSlot();
    if (id === null) return;
    slots.set(event.pointerId, id);
    // Keeps the drag alive when the pointer leaves the canvas. Capture is refused for
    // pointers the browser no longer tracks (and for scripted test events); the touch
    // still works without it, so that failure is not an error.
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch (err) {
      if (err.name !== 'NotFoundError') throw err;
    }
    sendTouch('down', event);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (slots.has(event.pointerId)) sendTouch('move', event);
  });

  function endTouch(action, event) {
    if (!slots.has(event.pointerId)) return;
    sendTouch(action, event);
    slots.delete(event.pointerId);
  }
  canvas.addEventListener('pointerup', (event) => endTouch('up', event));
  canvas.addEventListener('pointercancel', (event) => endTouch('cancel', event));
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const point = pointOf(event);
    if (point === null) return;
    // Wheel down (positive deltaY) means "show what is below", which Android calls a negative scroll.
    send({ t: 'scroll', x: point.x, y: point.y, dx: Math.sign(event.deltaX), dy: -Math.sign(event.deltaY) });
  }, { passive: false });

  canvas.addEventListener('keydown', (event) => {
    // Ctrl+C copies the device's selection; the device then reports its clipboard.
    // Ctrl+V is left to the browser, which fires the paste event handled below.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') send({ t: 'copy' });
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    const special = SPECIAL_KEYS.get(event.key);
    if (special) {
      event.preventDefault();
      return send({ t: 'key', a: 'down', key: special });
    }
    // A single character is something to type; names like "Shift" or "F5" are longer.
    if ([...event.key].length === 1) {
      event.preventDefault();
      send({ t: 'text', text: event.key });
    }
  });

  canvas.addEventListener('paste', (event) => {
    const text = event.clipboardData ? event.clipboardData.getData('text') : '';
    if (text === '') return;
    event.preventDefault();
    send({ t: 'paste', text });
  });

  canvas.addEventListener('keyup', (event) => {
    const special = SPECIAL_KEYS.get(event.key);
    if (special) send({ t: 'key', a: 'up', key: special });
  });

  // If the stream drops mid-touch, forget the fingers so they are not stuck down after reconnecting.
  return { reset: () => slots.clear(), sendKeyPress };
}
