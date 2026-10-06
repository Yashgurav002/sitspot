// Prints a fresh VAPID key pair for .env. Run: pnpm --filter @sitspot/api exec tsx scripts/gen-vapid.ts
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\nVAPID_SUBJECT=mailto:you@example.com`);
