// Site configuration.
//
// SECURITY NOTE: This repo is PUBLIC. The order data in /data is ENCRYPTED at rest,
// and the password is NOT stored here on purpose — type it to unlock. If you set
// HARDCODED_PASSWORD below to a non-empty string, the gate auto-unlocks WITHOUT asking,
// which means anyone reading this file can read the data. Leave it empty for real privacy.
const CONFIG = {
  HARDCODED_PASSWORD: '', // '' = ask for password (recommended). A string = auto-unlock (insecure on public repo).
  INDEX_FILE: 'data/index.enc.json',
  SESSION_KEY: 'lee_orders_pw'
};

export { CONFIG };
