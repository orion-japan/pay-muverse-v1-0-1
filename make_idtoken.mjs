import fs from "node:fs";
import admin from "firebase-admin";

const SA_PATH = process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;
if (!SA_PATH) throw new Error("FIREBASE_SERVICE_ACCOUNT_FILE is not set");
if (!WEB_API_KEY) throw new Error("FIREBASE_WEB_API_KEY is not set");

const sa = JSON.parse(fs.readFileSync(SA_PATH, "utf8"));
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(sa) });
}

const uid = "cli-test-uid";
const claims = {
  claim_role: "admin",
  claim_user_code: "669933",
  provider: "custom",
};

const customToken = await admin.auth().createCustomToken(uid, claims);

const res = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${WEB_API_KEY}`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  }
);
if (!res.ok) {
  const text = await res.text();
  throw new Error(`signInWithCustomToken failed: ${res.status} ${text}`);
}
const json = await res.json();
process.stdout.write(json.idToken);
