# Hey Love — Content Dashboard

A live dashboard that reads from Notion (stats, events, tasks, SMS, emails, video index) and Google Drive (video embeds).

## Deploy (one time, ~10 minutes)

1. **GitHub**: go to github.com/new → name it `hey-love-dashboard` → Create repository → click "uploading an existing file" → drag in everything inside this folder (`index.html`, `README.md`, and the `api` folder) → Commit.
2. **Vercel**: vercel.com → Add New → Project → Import `hey-love-dashboard`.
3. Before clicking Deploy, open **Environment Variables** and add:
   - `NOTION_TOKEN` — your Notion integration token (starts with `ntn_`)
   - `META_TOKEN` — your Meta system-user token (starts with `EAA...`) — optional
   - `META_AD_ACCOUNT` — `act_10152267649979326` — optional
   - `META_PAGE_ID` — your Facebook Page ID — optional (auto-detected if omitted)
   - `KLAVIYO_API_KEY` — private key (`pk_...`), read-only Campaigns/Templates scopes — optional
4. Click **Deploy**. Done — Vercel gives you a URL like `hey-love-dashboard.vercel.app`.

## How data flows

| Dashboard section | Source in Notion |
|---|---|
| Meta Ads Performance + Account Growth | Live from the Meta API when `META_TOKEN` is set; any missing value falls back to the "Meta Stats — Monthly" database (one row per month) |
| Upcoming Events | FY26 MKT Calendar (shows today onward) |
| Tasks In Progress | Task database (hides Done tasks) |
| Social Videos | "Social Videos" database (paste Google Drive file links) |
| Text Messages | Live from Klaviyo when `KLAVIYO_API_KEY` is set (real sent SMS copy); otherwise Notion SMS CAMPAIGNS |
| Email Designs | Live from Klaviyo when `KLAVIYO_API_KEY` is set (real email HTML previews); otherwise Notion EMAIL CAMPAIGNS |

Data refreshes automatically (cached ~5 minutes).

## Video links

For videos to play inline, use a Drive **file** link (right-click the video file → Share → Copy link, "Anyone with the link"). Folder links show as a clickable card instead.

## Optional later

- Password-protect the page (Vercel setting, paid) or keep the URL private.
- Automate Meta stats via Meta API or Windsor.ai — replaces manual monthly entry.
