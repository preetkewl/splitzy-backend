/**
 * Google Play access validator.
 *
 * WHY: `POST /subscriptions/verify` fails CLOSED when the Play Developer API
 * credentials are missing/wrong — the exact reason a "successful" purchase never
 * grants premium (see docs/monetization-ops-runbook.md §1). Run this against the
 * downloaded service-account key BEFORE pasting it into Render, so a bad key /
 * missing Play Console permission / disabled API / the 24–48h propagation delay
 * surfaces here instead of via a failed live purchase.
 *
 * Standalone: depends only on `googleapis` (already a dependency) + Node builtins.
 * It does NOT read the app config or touch the database — it mirrors exactly what
 * src/modules/entitlement/google/google-play-client.ts does, and interprets the
 * HTTP status the same way (400/404/410 → "reachable, token just unknown";
 * 401/403 → real config problem).
 *
 * USAGE
 *   tsx scripts/verify-play-access.ts <path-to-sa.json> [purchaseToken] [--package=com.hk.settlio]
 *
 *   # or from env (mirrors prod):
 *   GOOGLE_PLAY_SERVICE_ACCOUNT_JSON='{...}' GOOGLE_PLAY_PACKAGE_NAME=com.hk.settlio \
 *     tsx scripts/verify-play-access.ts [purchaseToken]
 *
 *   • No purchaseToken  → reachability probe with a dummy token. A 400/404/410
 *     back from Google means auth + permission + package are all correct.
 *   • With a REAL token → full subscriptionsv2.get; prints state/expiry and
 *     whether the backend would treat it as ENTITLING (i.e. grant premium).
 *
 * Exit code: 0 when access looks healthy, 1 on a real config problem.
 */
import fs from 'node:fs';
import { google } from 'googleapis';

const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
// Google states the backend treats as entitling while not expired — mirrors
// ENTITLING_SUBSCRIPTION_STATES in src/modules/entitlement/constants.ts.
const ENTITLING_STATES = new Set([
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_CANCELED',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
]);
const DUMMY_TOKEN = 'validator-probe-token-not-a-real-purchase';

function fail(msg: string): never {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

function getFlag(args: string[], name: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function httpStatusOf(err: unknown): number | undefined {
  const e = err as { response?: { status?: number }; code?: number | string };
  if (typeof e?.response?.status === 'number') return e.response.status;
  if (typeof e?.code === 'number') return e.code;
  return undefined;
}

function googleErrorMessage(err: unknown): string {
  const e = err as {
    response?: { data?: { error?: { message?: string; status?: string } } };
    message?: string;
  };
  return e?.response?.data?.error?.message ?? e?.message ?? String(err);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = argv.filter((a) => a.startsWith('--'));
  const positionals = argv.filter((a) => !a.startsWith('--'));

  const pkg = getFlag(flags, 'package') ?? process.env.GOOGLE_PLAY_PACKAGE_NAME ?? 'com.hk.settlio';

  // Resolve the service-account JSON: a file-path positional wins, else env.
  let saRaw: string | undefined;
  let saOrigin = '';
  if (positionals[0] && fs.existsSync(positionals[0])) {
    saRaw = fs.readFileSync(positionals.shift() as string, 'utf8');
    saOrigin = `file (${argv[0]})`;
  } else if (process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON) {
    saRaw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
    saOrigin = 'env GOOGLE_PLAY_SERVICE_ACCOUNT_JSON';
  }
  if (!saRaw) {
    fail(
      'No service-account JSON. Pass a path:\n' +
        '   tsx scripts/verify-play-access.ts ./play-sa.json [purchaseToken]\n' +
        'or set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON in the environment.',
    );
  }

  const purchaseToken = positionals[0]; // undefined → reachability probe

  let credentials: { client_email?: string; project_id?: string; private_key?: string };
  try {
    credentials = JSON.parse(saRaw) as typeof credentials;
  } catch (err) {
    fail(`Service-account JSON is not valid JSON (${(err as Error).message}). If pasting from an env var, ensure it is the ENTIRE key on one line.`);
  }
  if (!credentials.client_email || !credentials.private_key) {
    fail('Service-account JSON is missing client_email / private_key — this is not a valid SA key file.');
  }

  console.log('── Google Play access validator ──────────────────────────────');
  console.log(`  package          : ${pkg}`);
  console.log(`  SA source        : ${saOrigin}`);
  console.log(`  SA client_email  : ${credentials.client_email}`);
  console.log(`  SA project_id    : ${credentials.project_id ?? '(none)'}`);
  console.log(`  mode             : ${purchaseToken ? 'REAL purchaseToken → full fetch' : 'reachability probe (dummy token)'}`);
  console.log('  (grant THIS client_email "View financial data, Manage orders" in Play Console)\n');

  const auth = new google.auth.GoogleAuth({ credentials, scopes: [SCOPE] });

  // 1) Prove the key can mint an access token (validates signing + clock skew).
  try {
    await auth.getAccessToken();
    console.log('✅ Auth: obtained an OAuth access token (key + scope OK).');
  } catch (err) {
    fail(`Auth FAILED minting a token — the key is invalid, revoked, or the clock is skewed.\n   ${googleErrorMessage(err)}`);
  }

  // 2) Call the exact endpoint verify uses.
  const publisher = google.androidpublisher({ version: 'v3', auth });
  try {
    const res = await publisher.purchases.subscriptionsv2.get({
      packageName: pkg,
      token: purchaseToken ?? DUMMY_TOKEN,
    });

    if (!purchaseToken) {
      // A dummy token succeeding is unexpected but harmless — access clearly works.
      console.log('✅ subscriptionsv2.get returned 200 for a dummy token (unexpected but access is fine).');
      console.log('\n🎉 VERDICT: credentials are healthy. Safe to paste into Render.');
      return;
    }

    // Real token → report the authoritative state, mirroring normalize()/isEntitling().
    const data = res.data;
    const state = data.subscriptionState ?? '(unknown)';
    let productId: string | null = null;
    let expiry: Date | null = null;
    for (const li of data.lineItems ?? []) {
      const exp = li.expiryTime ? new Date(li.expiryTime) : null;
      if (exp && (expiry === null || exp > expiry)) {
        expiry = exp;
        productId = li.productId ?? productId;
      } else if (expiry === null && li.productId) {
        productId = li.productId;
      }
    }
    const entitling = ENTITLING_STATES.has(state) && expiry !== null && expiry > new Date();

    console.log('✅ subscriptionsv2.get succeeded for the real token:\n');
    console.log(`  productId          : ${productId ?? '(none)'}`);
    console.log(`  subscriptionState  : ${state}`);
    console.log(`  expiryTime         : ${expiry?.toISOString() ?? '(none)'}`);
    console.log(`  acknowledgement    : ${data.acknowledgementState ?? '(unknown)'}`);
    console.log(`  → backend ENTITLING: ${entitling ? 'YES → premium granted' : 'NO → premium NOT granted'}`);
    if (!entitling) {
      console.log(
        '\n⚠️  Not entitling: the state is not ACTIVE/CANCELED/IN_GRACE_PERIOD or it is expired.\n' +
          '    A live test purchase should read ACTIVE — check the sub is Active in Play Console\n' +
          '    and that this token is from the current purchase.',
      );
    }
    console.log('\n🎉 VERDICT: credentials + package are healthy. Safe to paste into Render.');
    return;
  } catch (err) {
    const status = httpStatusOf(err);
    const msg = googleErrorMessage(err);

    if (status === 400 || status === 404 || status === 410) {
      if (!purchaseToken) {
        console.log(`✅ Google returned ${status} for the dummy token — it recognised our credentials and package,`);
        console.log('   it just does not know that (fake) token. This is the expected healthy result.');
        console.log('\n🎉 VERDICT: credentials + package are healthy. Safe to paste into Render.');
        return;
      }
      fail(`Google returned ${status} for this REAL token → it does not recognise the token (wrong token, or purchased on a different package). Access itself is fine.\n   ${msg}`);
    }
    if (status === 401) {
      fail(`401 Unauthorized — the service-account key is invalid/revoked or the scope is wrong.\n   ${msg}`);
    }
    if (status === 403) {
      fail(
        `403 Forbidden — access is NOT yet usable. Common causes:\n` +
          `     • SA lacks the Play Console permission "View financial data, Manage orders" (grant ${credentials.client_email})\n` +
          `     • the GCP project isn't linked under Play Console → Setup → API access\n` +
          `     • the "Google Play Android Developer API" isn't enabled in the GCP project\n` +
          `     • propagation delay — up to 24–48h after first linking/granting\n` +
          `   Google said: ${msg}`,
      );
    }
    fail(`Unexpected error (status ${status ?? 'n/a'}) from subscriptionsv2.get.\n   ${msg}`);
  }
}

main().catch((err) => fail(`Unhandled error: ${(err as Error).message}`));
