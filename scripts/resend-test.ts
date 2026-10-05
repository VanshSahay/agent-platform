// Send Resend's "first email" check with the key from .env.local: bun --env-file=.env.local scripts/resend-test.ts you@example.com
// (Uses the same REST call the platform's email channel uses — no SDK needed.)
const to = process.argv[2];
if (!to || !process.env.RESEND_API_KEY) throw new Error("usage: bun --env-file=.env.local scripts/resend-test.ts <your-email>  (RESEND_API_KEY must be set)");
const r = await fetch("https://api.resend.com/emails", {
  method: "POST", headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ from: process.env.RESEND_FROM ?? "onboarding@resend.dev", to, subject: "Hello World", html: "<p>Congrats on sending your <strong>first email</strong>!</p>" }),
});
console.log(r.status, await r.text());
