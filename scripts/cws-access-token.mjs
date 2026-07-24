// Mints a Chrome Web Store API access token from a Google service-account key,
// using the JWT-bearer (two-legged OAuth) grant. No external dependencies —
// just Node's crypto — so the release pipeline stays auditable.
//
// Reads the service-account key JSON from $CWS_SERVICE_ACCOUNT_KEY and prints
// only the access token to stdout. Everything else goes to stderr.
import { createSign } from 'node:crypto';

const raw = process.env.CWS_SERVICE_ACCOUNT_KEY;
if (!raw) {
  console.error('CWS_SERVICE_ACCOUNT_KEY is not set.');
  process.exit(1);
}

let key;
try {
  key = JSON.parse(raw);
} catch {
  console.error('CWS_SERVICE_ACCOUNT_KEY is not valid JSON — paste the whole key file.');
  process.exit(1);
}
if (!key.client_email || !key.private_key) {
  console.error('Key JSON is missing client_email / private_key.');
  process.exit(1);
}

const b64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const tokenUri = key.token_uri || 'https://oauth2.googleapis.com/token';
const now = Math.floor(Date.now() / 1000);

const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
const claims = b64url(
  JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/chromewebstore',
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  })
);

const signingInput = `${header}.${claims}`;
const signature = createSign('RSA-SHA256')
  .update(signingInput)
  .sign(key.private_key)
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');
const assertion = `${signingInput}.${signature}`;

const resp = await fetch(tokenUri, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  }),
});

const data = await resp.json().catch(() => ({}));
if (!resp.ok || !data.access_token) {
  console.error(`Token exchange failed (HTTP ${resp.status}):`, JSON.stringify(data));
  console.error(
    'Check that the service account email is added under the dashboard Account section ' +
      'and that the Chrome Web Store API is enabled in the same GCP project.'
  );
  process.exit(1);
}

process.stdout.write(data.access_token);
