# iMessage on your own Mac (Photon local mode)

For testing iMessage, including group chats, without Photon's cloud and without a dedicated line. The app runs on a Mac and
reads that Mac's Messages app directly through Photon's open-source local provider (`@spectrum-ts/imessage-local`,
already in `package.json`). No `PROJECT_ID` or `PROJECT_SECRET` needed. Verified on macOS 15.6 on 23 October 2026.

## How it works, and the one thing to decide first

The agent's identity is whichever Apple ID is signed into Messages on the Mac. Texts to that Apple ID, and groups it
is in, reach the agent; replies go out from it. So:

- **Your own account** (quickest): the agent replies *as you*. Fine for a ten-minute test with friends you warned.
  Your own messages do not trigger it (they are outgoing from the Mac's point of view), so a friend has to address it.
  Every other text you receive while it runs also gets a reply from the agent, as you. Stop it when done.
- **A second macOS user with a fresh Apple ID** (recommended): the agent is its own participant, which is how real
  users will see it. System Settings → Users & Groups → Add User; log in as that user; open Messages; sign in with the
  new Apple ID (an email address works as the iMessage handle; a phone number needs an iPhone with that SIM on the same
  Apple ID). Do the steps below inside that user.

## Setup

1. **Messages signed in** on the Mac, and at least one conversation visible, so `~/Library/Messages/chat.db` exists.
2. **Full Disk Access for the process that runs Bun.** System Settings → Privacy & Security → Full Disk Access → add
   the app you will run the command from (Terminal, iTerm, Warp, or your editor) and switch it on. Quit and reopen that
   app. Without this the log says `Failed to open database: authorization denied`. The grant is per app: a server
   started by another app (an IDE's run button, a launcher) has its own entry.
3. **Clone and configure.** `bun install`; copy `.env.example` to `.env` with at least `OPENROUTER_API_KEY`
   (and `LITEAPI_API_KEY`, `APIFY_TOKEN` if you want hotel and flight comparisons). Leave `PROJECT_ID` and
   `PROJECT_SECRET` empty.
4. **Run.**

   ```bash
   bun run imessage:local
   ```

   This is `IMESSAGE_MODE=local` with sign-in off and its own database, `data/local-im.sqlite`, listening on
   http://127.0.0.1:3300. The log must show:

   ```
   imessage: local mode, this Mac's Messages app
   ```

   `IMESSAGE_PHONE=+1…` (or the Apple ID email) in `.env` is optional; Settings shows it as the agent's number.
5. **Create the agent** in the web UI at http://127.0.0.1:3300 (or start with `SEED_DEMO=1` for a demo one). The owner
   row there is the person whose texts count as the owner. Put your phone or email on it under Settings → General so the
   app recognises you.

## Testing group chats

1. From an iPhone, start a group with the agent's handle plus at least one other person (iMessage needs three
   participants for a real group; two is a one-to-one).
2. Someone other than the Mac's own Apple ID writes "<agent name>, …" in the thread.
3. The group appears under Rooms, named after its members, with the sender as a guest served through the owner.
   The reply lands in the thread. Approvals and sign-in cards go to the person's own chat with the agent, never the group.
4. Link a texter to a signed-in web person with the six-digit code under Settings → Channels, as in production.

## Limits of local mode (from Photon's docs, and observed)

- Existing groups only: the agent cannot create a group, rename it or react to membership changes.
- No reactions, replies, edits, unsend, read receipts or typing indicators; streaming text is off.
- Attachments can be read from a message; the attachment-download call is cloud-only.
- One process per Mac per Apple ID. Do not run it alongside the production cloud channel on the same Photon project.
- Apple's terms do not cover any of this (nor Photon's cloud). Use a test Apple ID for anything beyond a quick check.

## Stopping

Ctrl-C the process. The Mac keeps the conversations; the app keeps its own history in `data/local-im.sqlite`.
