# Demi’s Calendar

A personal hangout calendar with a GitHub Pages booking screen and a Supabase backend. Guests see bookable time slots and can save a confirmed hangout to their own calendar. The host sets weekly hours and can add one-off busy blocks.

**Booking page** [Demi’s Calendar](https://ignatius5k.github.io/demis-calendar/)

## Link Apple Calendar

1. Open **Host settings** and enter the private host key provided with this installation.
2. In your [Apple Account](https://account.apple.com/), go to **Sign-In and Security → App-Specific Passwords**. Generate a password for Demi’s Calendar. Apple requires two-factor authentication for app-specific passwords. [Apple’s instructions](https://support.apple.com/en-us/102654)
3. Enter your Apple Account email and the generated password under **Connect Apple Calendar**. Choose where hangouts and time blocks should go, and which iCloud calendars should determine busy times.
4. Set your **Weekly hours** under **Availability**, save them, and use **Copy booking link**.

The guest page uses sample availability before you connect iCloud. Live bookings use Singapore time, open up to 45 days ahead, and require at least 15 minutes’ notice. Choose **Reconnect** to refresh the list of iCloud calendars or replace a revoked app-specific password. To remove access, revoke the app-specific password under Apple Account.

## Notifications

In **Host settings → Notifications**, choose **Enable alerts** on each device you want to notify. A background check runs every five minutes and delivers alerts for new bookings and for tracked slots that become free in the next seven days. Updates also appear in **Recent activity**. On iPhone or iPad, add the site to your Home Screen and enable alerts from the installed web app. [Apple Web Push support](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

## Development

Serve the static frontend with `python3 -m http.server 8947 --directory site`. CI deploys `site/` to GitHub Pages. The booking endpoint is set in `site/config.js`.

The backend is in `supabase/functions/demi-calendar`. The SQL migration creates a private schema and an overlap constraint for reservations. Supabase Vault stores the iCloud credential, push signing key, and background-job key. Host routes require the private host key. Public availability returns open slot timestamps and hangout length.

To install a separate instance, create a Supabase project, apply the migration, and deploy the Edge Function with Supabase CLI. Set the booking endpoint in `site/config.js` and the permitted site origin and path in the function. Provision the host key hash and the VAPID public key in `demi.settings`, the VAPID private key as `demi_vapid_key` in Vault, and the function’s cron URL as `demi_endpoint` in Vault. Run `supabase/schedule.sql` to enable background checks. Keep runtime credentials outside the repository.

Run the calendar tests with:

    deno test --config supabase/functions/demi-calendar/deno.json supabase/functions/demi-calendar/calendar_test.ts

The artwork was created with ImageGen. Nunito is distributed under its bundled SIL Open Font License.

## Artwork

The hero uses `site/assets/companions.webp`, generated with the built-in ImageGen tool.

> Original transparent cutout hero artwork for a dark avant-garde fashion-editorial booking site. A pair of sculptural, slightly adorable imaginary creatures, side by side and leaning gently into one another: the left is a plush-round blob with two short rounded antenna ears, modeled in polished mirror chrome with soft pink highlights; the right is pearl-white molded porcelain like a two-horned bunny pebble with two tiny dark pin-dot eyes. The silver creature also has two refined little eye holes, a deeply rounded friendly silhouette. They are tactile designer-art objects, about the same size, not animals or costumed people. One small mercury sphere sits at the front, a barely-there mauve tint in the reflections. Lit with large soft studio sources so edges are well defined and the silver has both dark and bright reflections. Editorial product-photography realism and sophisticated slightly surreal sculpture; minimal palette of metallic silver, ivory, charcoal reflections, and a whisper of ballet-slipper pink. Wide landscape tight crop with full shapes inside the canvas, figures close and glossy, utterly minimal. Transparent background with real alpha, no set, no floor, no rings of glow, no busy accessories, no logos, no text, no watermark.
