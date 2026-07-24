// One-time helper to mint a Chrome Web Store API refresh token for CI.
//
//   node scripts/get-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>
//
// It opens a local server on http://localhost:8917, prints a Google consent
// URL for you to approve, catches the redirect, and exchanges the code for a
// refresh token. See PUBLISHING.md for how to create the OAuth client first.
import http from 'node:http';

const [, , CLIENT_ID, CLIENT_SECRET] = process.argv;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Usage: node scripts/get-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>');
  process.exit(1);
}

const PORT = 8917;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPE);
authUrl.searchParams.set('access_type', 'offline'); // required to receive a refresh token
authUrl.searchParams.set('prompt', 'consent'); // force a fresh refresh token every run

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  const code = url.searchParams.get('code');
  if (!code) {
    res.statusCode = 400;
    res.end('No authorization code in the request.');
    return;
  }

  res.end('Done — close this tab and return to the terminal.');
  server.close();

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    }),
  });
  const data = await resp.json();

  if (data.refresh_token) {
    console.log('\n=== Add these as GitHub repo secrets (Settings → Secrets → Actions) ===\n');
    console.log('CWS_CLIENT_ID      =', CLIENT_ID);
    console.log('CWS_CLIENT_SECRET  =', CLIENT_SECRET);
    console.log('CWS_REFRESH_TOKEN  =', data.refresh_token);
    console.log('\n(plus CWS_EXTENSION_ID from your extension in the Web Store dashboard)');
  } else {
    console.error('\nNo refresh_token in the response:');
    console.error(data);
    console.error(
      '\nIf you see invalid_grant, the code expired — just run this again. If refresh_token ' +
        'is simply absent, the OAuth client already granted one; revoke access at ' +
        'https://myaccount.google.com/permissions and retry.'
    );
    process.exitCode = 1;
  }
});

server.listen(PORT, () => {
  console.log('1. Open this URL, sign in as the extension owner, and approve:\n');
  console.log('   ' + authUrl.toString() + '\n');
  console.log(`2. Waiting for the redirect on ${REDIRECT} ...`);
  console.log('   (If Google warns the app is unverified, choose Advanced → proceed — you are the developer.)');
});
