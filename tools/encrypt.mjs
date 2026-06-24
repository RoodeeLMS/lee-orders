// Generic encryptor for one file. Output is WebCrypto-compatible AES-256-GCM (base64).
// Usage:  LEE_PW='yourpassword' node tools/encrypt.mjs <input.json> <output.enc.json>
// (decrypt with the in-browser tool at /admin/encrypt.html, or see tools/decrypt.mjs)
import crypto from 'node:crypto';
import fs from 'node:fs';

const PW = process.env.LEE_PW;
const [, , inFile, outFile] = process.argv;
if (!PW || !inFile || !outFile) {
  console.error("Usage: LEE_PW='pw' node tools/encrypt.mjs <input.json> <output.enc.json>");
  process.exit(1);
}

const plaintext = fs.readFileSync(inFile, 'utf8');
JSON.parse(plaintext); // validate

const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const key = crypto.pbkdf2Sync(PW, salt, 150000, 32, 'sha256');
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
const tag = cipher.getAuthTag();
const blob = Buffer.concat([salt, iv, ct, tag]).toString('base64');

fs.writeFileSync(outFile, blob);
console.log('wrote', outFile);
