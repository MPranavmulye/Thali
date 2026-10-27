# Thali — phone app (free, no server)

This is the same Thali calorie tracker as the one in Claude, packaged as an app you install on your phone.

- **Your log** is saved on your phone, and stays there even when you're offline.
- **AI** calls go straight from your phone to free providers (Gemini, then Groq, then OpenRouter) using your own keys.
- **Hosting** is a free GitHub Pages site. It holds only the app's code, never your keys or your data.

## Step 1 — Put it online (one time, about 5 minutes, on a computer)

1. Create a free account at **github.com**.
2. Click **+** (top right), then **New repository**.
   - Name it `thali`.
   - Choose **Public**. Free GitHub Pages needs this, and only the code is public.
   - Click **Create repository**.
3. On the new repository page, click **"uploading an existing file"**.
   - Drag in **every file in this folder**: `index.html`, `shim.js`, `sw.js`, `manifest.webmanifest`, the three `.png` icons, `app.html`, `build.py` and this README.
   - Click **Commit changes**.
4. Go to **Settings → Pages**. Under *Build and deployment*, set *Source* to **Deploy from a branch**, the branch to **main**, and the folder to **/ (root)**. Click **Save**.
5. Wait 1–2 minutes and refresh that page. It shows your app's address: **`https://<your-username>.github.io/thali/`**

## Step 2 — Install it on your phone

**Android (Chrome):**
1. Open the address above.
2. Tap **⋮ → Install app** (or **Add to Home screen**).
3. Thali now has its own icon and opens full screen, like any app.

**iPhone (Safari):**
1. Open the address.
2. Tap **Share → Add to Home Screen**.

## Step 3 — First launch

1. The **AI keys** screen opens. Paste at least one free key, then tap **Test keys**. You should see ✓ Working. Then tap **Save**.
   - Gemini: https://aistudio.google.com/apikey
   - Groq: https://console.groq.com/keys
   - OpenRouter: https://openrouter.ai/settings/keys
2. Fill in your profile. This sets your daily calorie and macro targets.
3. Start logging. Type what you ate, or tap the 📷 button to photograph your plate.

You can change keys any time from **☰ → AI keys**. The same screen shows which provider answered last.

## Moving your existing log in

1. In the Claude version, go to **☰ → Backup & restore → Download backup**.
2. Send that file to your phone, for example by WhatsApp to yourself or through Google Drive.
3. In the phone app, go to **☰ → Backup & restore**, choose the file, and tap **Restore** twice.

## Keep your data safe

Your log lives only on this phone.
- **Clearing Chrome's site data or uninstalling the app deletes it.**
- **Changing phones** means restoring from a backup.

So once a week, tap **☰ → Backup & restore → Download backup** and keep the file somewhere safe, such as Google Drive.

## Updating the app later

If you get a new `app.html`:
1. Replace it in this folder.
2. Run `python build.py`, which rebuilds `index.html`.
3. Upload the new `index.html` to your GitHub repository (Add file → Upload files).

The phone picks up the update the next time you open the app online. Your data isn't touched.

## Notes

- **Free tiers:** providers may use what you send, including meal text and photos, to improve their models.
- **If one provider fails** (key rejected, model retired, or blocked from the browser), the app skips it and tries the next. **Test keys** shows the exact reason.
- **Model names** can be changed under **AI keys → Advanced** if a provider retires one.
- **Without internet**, you can still open the app, view your log and add entries manually. AI estimates need a connection.
