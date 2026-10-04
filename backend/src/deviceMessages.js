'use strict';

// Parses what scrcpy-server sends back on the control socket.
// Format: scrcpy v4.1 DeviceMessageWriter.java. One type byte, then:
//   0 clipboard      u32 length + UTF-8 text (the device's clipboard changed)
//   1 ack clipboard  u64 sequence
//   2 UHID output    u16 id, u16 size, data

const TYPE_CLIPBOARD = 0;
const TYPE_ACK_CLIPBOARD = 1;
const TYPE_UHID_OUTPUT = 2;
const MAX_CLIPBOARD_BYTES = 1 << 18; // scrcpy's own message limit

// Returns the total size of the message at `offset`, or null if its header is incomplete.
function messageSize(buffer, offset) {
  const available = buffer.length - offset;
  const type = buffer[offset];
  if (type === TYPE_CLIPBOARD) {
    if (available < 5) return null;
    const length = buffer.readUInt32BE(offset + 1);
    if (length > MAX_CLIPBOARD_BYTES) throw new Error(`device clipboard of ${length} bytes exceeds the limit`);
    return 5 + length;
  }
  if (type === TYPE_ACK_CLIPBOARD) return 9;
  if (type === TYPE_UHID_OUTPUT) return available < 5 ? null : 5 + buffer.readUInt16BE(offset + 3);
  throw new Error(`unknown device message type ${type}`);
}

// Returns a parser whose push(chunk) gives back the clipboard events completed by that
// chunk. Other message kinds are skipped. Incomplete data is kept for the next chunk.
function createDeviceMessageParser() {
  let pending = Buffer.alloc(0);

  function push(chunk) {
    pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    const events = [];
    let offset = 0;
    while (offset < pending.length) {
      const size = messageSize(pending, offset);
      if (size === null || pending.length - offset < size) break;
      if (pending[offset] === TYPE_CLIPBOARD) {
        events.push({ type: 'clipboard', text: pending.toString('utf8', offset + 5, offset + size) });
      }
      offset += size;
    }
    pending = pending.subarray(offset);
    return events;
  }

  return { push };
}

module.exports = { createDeviceMessageParser, MAX_CLIPBOARD_BYTES };
