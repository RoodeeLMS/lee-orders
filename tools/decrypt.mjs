// Decrypt one .enc.json back to plaintext JSON (for editing).
// Usage:  LEE_PW='yourpassword' node tools/decrypt.mjs <input.enc.json> [output.json]
import crypto from 'node:crypto';
import fs from 'node:fs';

const PW = process.env.LEE_PW;
const [, , inFile, outFile] = process.argv;
if (!PW || !inFile) {
  console.error("Usage: LEE_PW='pw' node tools/decrypt.mjs <input.enc.json> [output.json]");
  process.exit(1);
}

const raw = Buffer.from(fs.readFileSync(inFile, 'utf8').trim(), 'base64');
const salt = raw.subarray(0, 16);
const iv = raw.subarray(16, 28);
const tag = raw.subarray(raw.length - 16);
const ct = raw.subarray(28, raw.length - 16);
const key = crypto.pbkdf2Sync(PW, salt, 150000, 32, 'sha256');
const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
decipher.setAuthTag(tag);
const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
const pretty = JSON.stringify(JSON.parse(pt), null, 2);

if (outFile) { fs.writeFileSync(outFile, pretty); console.log('wrote', outFile); }
else console.log(pretty);
