# BOKKO Site — Setup Guide

You have two files:

- **index.html** — the public site
- **admin.html** — your private upload page (photos/videos/case studies)

Both are self-contained (no separate JS/CSS files to keep track of).

The site works right now with placeholder gradients instead of real photos. Once you complete the steps below, `admin.html` becomes a real upload panel and `index.html` shows whatever you upload — no code editing after that.

---

## Step 1 — Create a free Firebase project (5 min)

1. Go to https://console.firebase.google.com and sign in with a Google account.
2. Click **Add project** → name it something like `bokko-site` → continue through the prompts (Google Analytics is optional, skip it) → **Create project**.

## Step 2 — Register a web app

1. On your new project's home screen, click the **`</>`** (web) icon.
2. Nickname it `bokko-web` → **Register app**.
3. Firebase shows you a `firebaseConfig` object like:
   ```js
   const firebaseConfig = {
     apiKey: "AIzaSy...",
     authDomain: "bokko-site.firebaseapp.com",
     projectId: "bokko-site",
     storageBucket: "bokko-site.appspot.com",
     messagingSenderId: "123456789",
     appId: "1:123456789:web:abcdef"
   };
   ```
4. Copy that whole block. You'll paste its values into **two** places:
   - `index.html` — find `const FIREBASE_CONFIG = {` near the bottom and replace the placeholder values
   - `admin.html` — same thing, near the top of its script

## Step 3 — Turn on Authentication (this is your admin login)

1. In the Firebase console sidebar: **Build → Authentication → Get started**.
2. Under **Sign-in method**, enable **Email/Password**.
3. Go to the **Users** tab → **Add user** → enter your own email and a password. This is what you'll log into `admin.html` with.

## Step 4 — Turn on Firestore (stores your case study text)

1. Sidebar: **Build → Firestore Database → Create database**.
2. Choose **Start in production mode** → pick a region close to Thailand (e.g. `asia-southeast1`) → **Enable**.
3. Go to the **Rules** tab and replace the contents with:
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /projects/{projectId} {
         allow read: if true;
         allow write: if request.auth != null;
       }
       match /content/{docId} {
         allow read: if true;
         allow write: if request.auth != null;
       }
     }
   }
   ```
   This means: anyone can *view* your case studies, logos and testimonials (needed for the public site), but only someone logged in through `admin.html` can *edit* them. The `content` collection is where client logos and testimonials are stored.
4. Click **Publish**.

## Step 5 — Turn on Storage (stores your photos/videos)

1. Sidebar: **Build → Storage → Get started** → keep the default settings → **Done**.
2. Go to the **Rules** tab and replace the contents with:
   ```
   rules_version = '2';
   service firebase.storage {
     match /b/{bucket}/o {
       match /{allPaths=**} {
         allow read: if true;
         allow write: if request.auth != null;
       }
     }
   }
   ```
   This covers project photos/videos, logo images, and testimonial photos in one rule — anyone can view, only a logged-in admin can upload.
3. Click **Publish**.

That's the entire backend — no servers, no monthly cost at this scale (Firebase's free tier covers a small agency site comfortably).

## Step 6 — Add your Instagram feed (@bokko_th)

The site has a "Follow BOKKO" section with a live spot for your Instagram feed. The handle is already set to **@bokko_th** in the code — you only need to add the actual embed widget. Until you do, it shows a clean placeholder grid linking straight to your profile, so it's safe to deploy before this step too.

1. Go to https://snapwidget.com (free — no BOKKO account needed, just to generate the widget).
2. Click **Create a Widget** → **Instagram Feed** → connect the **@bokko_th** Instagram account.
3. Pick a layout (grid works well here), then click **Get Widget** — it gives you a small `<iframe>` snippet.
4. Open `index.html`, find this exact line (search for `igEmbed`):
   ```html
   <div id="igEmbed"></div>
   ```
5. Paste the iframe snippet *inside* that div, so it looks like:
   ```html
   <div id="igEmbed"><iframe src="https://snapwidget.com/embed/..." ...></iframe></div>
   ```
6. Save and re-deploy. The placeholder grid disappears automatically the moment real embed code is present — no other changes needed.

*(SnapWidget's free plan shows a small "powered by" badge and refreshes periodically rather than instantly. If you'd rather have zero branding, Elfsight and LightWidget work the same way but are paid after a trial.)*

### Per-client Instagram feed (different from the above)

Separately, each case study now has its own **Instagram Feed** screenshot — this is a static image (not a live embed) showing the optimised feed BOKKO built for *that specific client*, shown when someone taps "View Work" on a card. Upload it in `admin.html` under the new **Instagram Feed** card for each project — just a screenshot image, optionally linked to that client's real profile.

## Step 7 — Deploy to Netlify

1. Go to https://app.netlify.com → drag the folder containing **all five files** — `index.html`, `admin.html`, `robots.txt`, `sitemap.xml`, `llms.txt` — onto the deploy area together (or connect it to a GitHub repo if you'd rather). Dropping only some of them will remove the others from the live site, since each Netlify drag-and-drop deploy replaces everything.
2. Once live, your public site is at your Netlify URL (or bokko.co once your domain's connected), and the admin panel is at `yoursite.com/admin.html`.
3. **Bookmark `/admin.html` somewhere private** — it's not linked from the public site, so no one finds it unless they know the address, and it's also protected by the login from Step 3.

The contact form on the site is already wired to **Netlify Forms** — no setup needed. Submissions will show up under your Netlify dashboard → **Forms**, and Netlify can email you when someone applies.

## SEO & getting picked up by AI search (ChatGPT, Perplexity, Google AI Overviews, etc.)

Three plain-text files handle the technical side, already built and included above:

- **robots.txt** — explicitly allows search engines *and* AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, and others) to read the site. Without this, some of them may skip it by default.
- **sitemap.xml** — tells crawlers what pages exist. Simple since this is a one-page site.
- **llms.txt** — an emerging, not-yet-universal convention where some AI crawlers check for a clean plain-text summary of what a business does, instead of parsing the full page. Low effort, can't hurt, may help as more platforms adopt it.

`index.html`'s `<head>` also already has: a proper title and meta description, Open Graph and Twitter Card tags (control how the site looks when shared as a link), and **JSON-LD structured data** — a machine-readable block describing BOKKO as a business (services, service area, contact info, Instagram) that both Google and AI answer engines parse directly.

**One honest limitation worth knowing:** this site loads its client work, testimonials, and Instagram feed dynamically with JavaScript after the page loads. Google's crawler generally handles that fine, but several AI crawlers (including some of the ones above) only read the raw HTML and don't run JavaScript — meaning they may only see the hero section, services, and pricing, not the individual case studies or testimonials. The structured data in `<head>` covers the core facts about the business regardless, but if getting *individual case studies* picked up by AI search matters to you specifically, that would need a different technical approach (server-rendered pages) — let me know if that's worth exploring later.

Beyond the technical setup, the things that most influence whether AI platforms surface and recommend a business: being mentioned/linked from other real sites (press, directories like Google Business Profile, industry listings), having consistent business info everywhere (name, address, phone match exactly across the web), and having genuinely specific, citable facts on the page — which this site already leans into (60.3x ROAS, ฿6m sold in 24 hours, etc., are exactly the kind of concrete numbers these tools like to cite).

Once your domain is finalized, update the placeholder `https://bokko.co/` URLs in `index.html`'s `<head>`, `robots.txt`, `sitemap.xml`, and `llms.txt` if it ends up different from that.

## Using admin.html day to day

admin.html is now organised into four tabs across the top: **Client Work**, **Testimonials**, **Client Logos**, and **Branding**.

### Client Work tab

1. Go to `yoursite.com/admin.html`, sign in.
2. The first time you log in, it automatically copies the four existing case studies (Opera, Mandarin Oriental, Thai Airways, Pi Samui) into your database so you're not starting from scratch.
3. **Project order** — drag the **⠿** handle on any project name in the row at the top to set the priority order they appear in on the site. Saves automatically the moment you drop it, no separate save button.
4. Click a project to edit it, or **+ New project** for a new client campaign.
5. **Instagram Feed** card — upload a screenshot of the optimised feed BOKKO built for this client, and optionally link it to their real profile. Shows when a visitor taps "View Work."
6. **Media** card — photos and videos live together in one list now, in the order they'll appear on the site. Drag the **⠿** handle on any row to reorder — mix photos and videos freely, whatever's on top shows first. **+ Add photo** / **+ Add video** to upload; a real thumbnail frame is auto-captured for videos, with **Choose thumbnail** / **Reset to auto** if you want a different frame.
7. Click **Save changes**. Live on the public site within a few seconds.

### Testimonials tab

Upload testimonial **images** — screenshots of reviews, DMs, whatever you have — rather than typing out quotes. Drag to reorder, remove any, then **Save testimonials**. These aren't tied to any one client; they show as a scrollable carousel on the main page.

### Client Logos tab

One image upload — a single PNG/graphic containing all your client logos combined, shown as the "Trusted by" strip near the top of the site. Replace it any time; **Save logos** when you're happy with it.

### Branding tab

Upload BOKKO's own logo here — shown top-left of the site next to the site name. **Save logo** to publish.

### Page Content tab

Every static block of marketing copy on the page is editable here, in one place:
- **Stats bar** — the four numbers under the hero (e.g. "80+ / Clients")
- **Services section** — the heading, subtext, and all five service cards
- **Pricing** — the main package (price, included features list, button text) and the add-ons list (add or remove add-ons freely)
- **Follow BOKKO section** — its heading and subtext

One **Save page content** button publishes everything on this tab together. Until you save anything here, the site shows the same copy it launched with.

⚠️ **If you already completed Steps 4–5 before today**, your Firestore/Storage rules only cover the `projects` collection — the newer tabs write to a `content` collection and various Storage paths, so make sure your rules match the versions in Steps 4–5 above (they're written generically enough to already cover all of this — you don't need to update them again if you copied them after this guide's most recent version).

## How client cards work now

Each card on the Work section is intentionally compact — thumbnail row, name, headline result, and a **View Work** button. Tapping it opens a full-screen detail view with the Instagram Feed screenshot, a **Creative Reels** section (all videos, auto-playing muted previews — tap one to watch full-size with sound), a **Photography** section (all photos, tap to enlarge), the three metrics, and the accomplishment write-up. This keeps the swipeable card list clean while still giving each client a full case-study page on demand.

## If something looks wrong

The public site is built to never break: if Firebase isn't configured yet, or a request fails, it just falls back to the built-in placeholder gradients instead of showing errors or blank sections. So it's safe to deploy `index.html` before finishing the Firebase setup — you can complete Steps 1–5 whenever you're ready, and the site upgrades itself automatically the moment `FIREBASE_CONFIG` is filled in correctly. The same applies to logos and testimonials — no logos saved yet shows real client names as text, no testimonials yet shows an honest "check back soon" placeholder card, never a blank or broken section.

## What was changed from your original file

- Removed the "Revenue Check" iceberg calculator entirely — section, nav links (desktop + mobile), and its JS.
- Removed the leftover "paste into Wix HTML Embed" preview note (no longer applicable).
- Contact form now has proper `name` attributes and is wired to Netlify Forms instead of a placeholder alert.
- Fixed a small existing bug: the page used to auto-scroll to the Work section on every load; it now only scrolls when you actually click a project or tab.
- All code was reformatted from a minified single line into readable, commented code, so it's easier for you (or anyone else) to edit later.
