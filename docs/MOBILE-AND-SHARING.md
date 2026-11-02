# Using Clario on phones, and sharing it with friends

Clario is a Progressive Web App (PWA): it runs in the phone's browser and can be added to the home screen like an
app, with its own icon, full-screen window and an offline page. No app store is involved.

## Best way: put it on a free URL (recommended)
1. Push the project to GitHub and import it in Vercel (or run `vercel --prod`).
2. Add the environment variables from `.env.example` in Vercel -> Settings -> Environment Variables (server values
   stay server-side).
3. In Supabase -> Authentication -> URL Configuration, set **Site URL** to the Vercel URL and add it (and
   `https://*-yourteam.vercel.app` for previews) under **Redirect URLs**, otherwise confirmation emails link to localhost.
4. Send friends the link. They sign up and use it.
Supabase's built-in email sender is rate limited (a few emails per hour on the free tier). For more than a handful of
sign-ups, add free SMTP (Resend, Brevo) under Authentication -> SMTP.

## Install on the home screen
- **Android (Chrome):** open the link -> tap *Install app* (Clario shows a banner), or menu -> *Add to Home screen*.
- **iPhone / iPad (Safari only):** open the link -> Share button -> *Add to Home Screen* -> Add. Clario shows a hint for this
  because iOS has no install prompt. (Chrome on iOS can also do it through its share menu on recent versions.)

## Without deploying: temporary sharing from your computer
- **Same Wi-Fi:** `npx vite --host`, then open `http://<your-computer-ip>:5173` on the phone. Camera/install and service
  worker features need HTTPS, so this is fine for looking and testing but not for installing.
- **Anywhere, temporary HTTPS tunnel:** run the app (`npx vercel dev --listen 5173`) and in another terminal
  `npx cloudflared tunnel --url http://localhost:5173` (or `ngrok http 5173`). Share the printed `https://` link; it works
  while your computer and the command are running. Add that URL to Supabase Redirect URLs for email links to land correctly.

## Notes
- The app never asks friends for an API key; all AI calls happen on your server using your keys. Groq's free tier has
  rate limits shared by everyone, so heavy use by many friends may hit them; the usage page and per-user limits keep one person
  from using it all.
- iOS and Android behave the same; layouts use a bottom tab bar on phones and the sidebar on larger screens.
