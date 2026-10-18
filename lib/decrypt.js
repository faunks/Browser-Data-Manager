const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

let cachedKey = null; // raw AES key bytes, cached per-process

/**
 * Windows: Chrome's AES key lives in "Local State" JSON (os_crypt.encrypted_key),
 * base64-encoded with a leading "DPAPI" tag that must be stripped before
 * calling CryptUnprotectData. We shell out to PowerShell to use .NET's
 * ProtectedData class rather than pulling in a native addon.
 */
function getWindowsKey(userDataRoot) {
  const localStatePath = path.join(userDataRoot, 'Local State');
  const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  const encKeyB64 = localState.os_crypt && localState.os_crypt.encrypted_key;
  if (!encKeyB64) throw new Error('No os_crypt.encrypted_key in Local State');
  const encKeyBuf = Buffer.from(encKeyB64, 'base64').subarray(5); // strip "DPAPI" prefix

  const b64 = encKeyBuf.toString('base64');
  const psScript = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$bytes = [System.Convert]::FromBase64String("${b64}")
$raw = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[System.Convert]::ToBase64String($raw)
`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
    encoding: 'utf8'
  }).trim();
  return Buffer.from(out, 'base64');
}

/**
 * macOS: the AES key is derived via PBKDF2 from the "Chrome Safe Storage"
 * (or "Chromium Safe Storage" / "Brave Safe Storage" / "Microsoft Edge Safe Storage")
 * password stored in the login Keychain.
 */
function getMacKey(serviceName) {
  const password = execFileSync('security', ['find-generic-password', '-w', '-s', serviceName], {
    encoding: 'utf8'
  }).trim();
  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

/**
 * Linux: without a keyring unlocked, Chromium falls back to a fixed
 * password ("peanuts") run through the same PBKDF2 derivation.
 * If the user's keyring is used instead, decryption below will fail
 * gracefully and we surface the value as [encrypted].
 */
function getLinuxKey() {
  return crypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
}

function getKey(platform, userDataRoot, safeStorageServiceName) {
  if (cachedKey) return cachedKey;
  if (platform === 'win32') cachedKey = getWindowsKey(userDataRoot);
  else if (platform === 'darwin') cachedKey = getMacKey(safeStorageServiceName);
  else cachedKey = getLinuxKey();
  return cachedKey;
}

/**
 * Decrypts a Chromium `encrypted_value` blob.
 * v10/v11 prefix => AES encrypted. Windows uses AES-256-GCM with a
 * DPAPI-protected key; macOS/Linux use AES-128-CBC with a fixed IV of
 * 16 spaces and a PBKDF2-derived key.
 */
function decryptChromiumValue(buf, platform, userDataRoot, safeStorageServiceName) {
  if (!buf || buf.length === 0) return '';
  const prefix = buf.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10' && prefix !== 'v11') {
    // Unencrypted / legacy plain value
    return buf.toString('utf8');
  }
  try {
    const key = getKey(platform, userDataRoot, safeStorageServiceName);
    if (platform === 'win32') {
      const nonce = buf.subarray(3, 15);
      const ciphertext = buf.subarray(15, buf.length - 16);
      const tag = buf.subarray(buf.length - 16);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAuthTag(tag);
      const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return out.toString('utf8');
    } else {
      const iv = Buffer.alloc(16, ' ');
      const ciphertext = buf.subarray(3);
      const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
      decipher.setAutoPadding(true);
      const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return out.toString('utf8');
    }
  } catch (err) {
    return '[encrypted - could not decrypt: ' + err.message + ']';
  }
}

function encryptChromiumValue(plain, platform, userDataRoot, safeStorageServiceName) {
  const key = getKey(platform, userDataRoot, safeStorageServiceName);
  if (platform === 'win32') {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from('v10', 'latin1'), nonce, ciphertext, tag]);
  }
  const iv = Buffer.alloc(16, ' ');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('v10', 'latin1'), ciphertext]);
}

function safeStorageServiceNameFor(browserId) {
  switch (browserId) {
    case 'chrome': return 'Chrome Safe Storage';
    case 'edge': return 'Microsoft Edge Safe Storage';
    case 'brave': return 'Brave Safe Storage';
    case 'chromium': return 'Chromium Safe Storage';
    default: return 'Chrome Safe Storage';
  }
}

function resetKeyCache() {
  cachedKey = null;
}

module.exports = {
  decryptChromiumValue,
  encryptChromiumValue,
  safeStorageServiceNameFor,
  resetKeyCache
};
