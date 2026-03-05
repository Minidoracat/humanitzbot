# Bisect Web Hosting Bridge

These files redirect your Bisect **cPanel web hosting** domain to the **bot server's web panel**.

## Why?

Three Bisect products are relevant to running the bot:
- **Game server** — runs HumanitZ (Pterodactyl/Starbase)
- **Bot hosting** — runs Node.js (Pterodactyl/Starbase, same API key)
- **Web hosting** — cPanel shared hosting (PHP, static files — **no Node.js**)

The web panel runs on the bot server (Express.js needs Node.js), so the cPanel web hosting acts as a redirect to point your domain at the bot server's web panel port.

## Setup

1. **Find your bot server's web panel URL:**
   - Go to your bot server on `games.bisecthosting.com`
   - Navigate to **Network** tab
   - Find the allocated port for your web panel (set `WEB_MAP_PORT` in the bot's `.env`)
   - Your URL is: `http://<bot-server-ip>:<web-panel-port>`

2. **Edit `index.html`:**
   - Open it in a text editor
   - Find `var BOT_PANEL_URL = '';`
   - Set it to your bot server URL, e.g. `var BOT_PANEL_URL = 'http://123.456.789.0:25577';`

3. **Upload to cPanel:**
   - Log in to your Bisect cPanel (`webserver.bisecthosting.com:2083`)
   - Go to **File Manager** → `public_html/`
   - Upload `index.html` (and optionally `.htaccess`)
   - Your domain will now redirect visitors to the bot's web panel

## Optional: .htaccess Redirect

If your cPanel has `mod_rewrite` enabled (most do), you can use `.htaccess` for a faster server-side redirect instead of the JavaScript redirect in `index.html`. Edit the `RewriteRule` line in `.htaccess` with your bot server URL.

## OAuth Callback

For Discord login to work on the web panel, set `WEB_MAP_CALLBACK_URL` in the bot's `.env` to match the URL users access the panel from. If using the redirect, this should be the bot server's direct URL (not the cPanel domain), since the redirect happens before OAuth.
