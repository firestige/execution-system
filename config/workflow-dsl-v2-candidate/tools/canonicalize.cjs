#!/usr/bin/env node
const { createHash } = require('node:crypto');

function assertUnicodeScalars(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('canonical JSON strings must contain Unicode scalar values');
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError('canonical JSON strings must contain Unicode scalar values');
    }
  }
}

function canonicalize(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    assertUnicodeScalars(value);
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers');
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    for (const key of keys) assertUnicodeScalars(key);
    return `{${keys.sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new TypeError(`canonical JSON rejects ${typeof value}`);
}

function canonicalDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
}

module.exports = { canonicalize, canonicalDigest };
