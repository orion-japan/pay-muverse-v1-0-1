// src/lib/firebase/admin.ts
import fs from "fs";
import admin from "firebase-admin";

function loadServiceAccount(): any {
  // 1) FILE ＞ 2) BASE64 ＞ 3) JSON文字列
  if (process.env.FIREBASE_SERVICE_ACCOUNT_FILE) {
    const p = process.env.FIREBASE_SERVICE_ACCOUNT_FILE!;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  if (process.env.FIREBASE_ADMIN_KEY_BASE64) {
    const json = Buffer.from(process.env.FIREBASE_ADMIN_KEY_BASE64!, "base64").toString("utf8");
    return JSON.parse(json);
  }
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY!);
  }
  throw new Error("No service account: set FILE or ADMIN_KEY_BASE64 or SERVICE_ACCOUNT_KEY");
}

export function initFirebaseAdmin(): admin.app.App {
  if (admin.apps.length) return admin.app();

  const sa = loadServiceAccount();
  if (sa?.private_key?.includes("\\n")) {
    sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  }
  if (!sa?.client_email || !sa?.private_key?.startsWith("-----BEGIN ")) {
    throw new Error("Invalid service account fields (client_email/private_key)");
  }

  return admin.initializeApp({
    credential: admin.credential.cert(sa as admin.ServiceAccount),
  });
}

