// Helpers for H.264 in Annex B form (NAL units separated by 00 00 01 start codes),
// which is what Android's MediaCodec produces and scrcpy forwards.

const NAL_TYPE_MASK = 0x1f;
const NAL_TYPE_SPS = 7;
const SPS_PROFILE_BYTES = 3;

/**
 * Finds the offset of the first byte after each start code.
 * @param {Uint8Array} bytes
 * @returns {number[]}
 */
export function nalUnitOffsets(bytes) {
  const offsets = [];
  for (let i = 0; i + 2 < bytes.length; i += 1) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      offsets.push(i + 3);
      i += 2;
    }
  }
  return offsets;
}

/**
 * Builds the WebCodecs codec string ("avc1.PPCCLL") from the SPS inside a config packet.
 * PP, CC and LL are the profile, constraint flags and level bytes that follow the NAL header.
 * @param {Uint8Array} configBytes
 * @returns {string | null} null when the packet holds no complete SPS
 */
export function codecStringFromConfig(configBytes) {
  for (const offset of nalUnitOffsets(configBytes)) {
    const isSps = (configBytes[offset] & NAL_TYPE_MASK) === NAL_TYPE_SPS;
    if (!isSps || offset + SPS_PROFILE_BYTES >= configBytes.length) continue;
    const hex = [1, 2, 3].map((n) => configBytes[offset + n].toString(16).padStart(2, '0'));
    return `avc1.${hex.join('')}`;
  }
  return null;
}

/**
 * @param {Uint8Array} first
 * @param {Uint8Array} second
 * @returns {Uint8Array} a new array holding both
 */
export function concatBytes(first, second) {
  const joined = new Uint8Array(first.length + second.length);
  joined.set(first, 0);
  joined.set(second, first.length);
  return joined;
}
