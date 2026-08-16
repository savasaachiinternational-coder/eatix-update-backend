# App Store Review Notes (Eatwaze)

Paste the **Review Notes** section into App Store Connect when submitting the new app listing.  
Confirm the demo accounts below work on production **before** submitting.

## Prerequisites

1. Create a **new** App Store Connect app (do not resubmit the locked listing).
2. Privacy Policy URL: `https://eatwaze.com/privacy`
3. Terms URL: `https://eatwaze.com/terms`
4. Support URL / website: `https://eatwaze.com`
5. Verify demo logins on production (see below).

## App Store demo accounts (production)

| Role | Email | Password |
|------|-------|----------|
| Customer | `mahamud@gmail.com` | `123456` |
| Restaurant | `info@grandmillon.co.uk` | `123456` |

Restaurant channel for review: **Grand Millon** (Oldham). If asked for a browse area / postcode, use **OL9 6HN** (or the restaurant’s postcode).

### Optional: seed extra London demo data

On a machine that can reach the production Postgres database:

```bash
cd eatix-backend
export DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/DATABASE'
npm run seed:app-review
```

Or put `DATABASE_URL` in `eatix-backend/.env` and run `npm run seed:app-review`.

The seed script is optional when using the real accounts above; it creates extra London demo restaurants if needed.

---

## Review Notes (copy into App Store Connect)

```
Thank you for reviewing Eatwaze.

Eatwaze is a UK food discovery app: nearby restaurants, short-form food videos, menus, and promotions.

DEMO ACCOUNTS (password for both: 123456)

Customer (browse / shorts / order flow):
Email: mahamud@gmail.com
Password: 123456

Restaurant owner (channel / menu / promos):
Email: info@grandmillon.co.uk
Password: 123456

HOW TO REVIEW
1. Sign in with the customer account (mahamud@gmail.com).
2. If asked for a browse area / postcode, use: OL9 6HN (Oldham) so nearby content includes Grand Millon.
3. Open Home / Shorts — browse food videos and nearby restaurants.
4. Open restaurant channel Grand Millon — profile, menu items, and promotions load from the live API.
5. Settings → Privacy Policy / Terms / Website open https://eatwaze.com (and /privacy, /terms).
6. Help / Contact uses support@eatwaze.com.

APPLE PAY (PassKit)
Apple Pay is integrated via Stripe Payment Sheet during restaurant checkout. It is not a separate menu item and does not appear on Home / Shorts.

How to locate Apple Pay:
1. Sign in as mahamud@gmail.com / 123456
2. Set browse postcode to OL9 6HN
3. Open Grand Millon → add a menu item → proceed to checkout / place order
4. On the order screen, payment shows “Card / Apple Pay”
5. Tap place order — Stripe Payment Sheet opens; Apple Pay appears there when the device has Apple Pay / Wallet set up

Merchant ID: merchant.com.eatwaze.app (UK / GB). PassKit is linked because checkout uses @stripe/stripe-react-native with Apple Pay enabled.

Owner path (optional): sign out, sign in as info@grandmillon.co.uk to view the restaurant channel tools.

Legal
• Privacy Policy: https://eatwaze.com/privacy
• Terms of Use: https://eatwaze.com/terms
• Website: https://eatwaze.com

Core discovery (Home / Shorts / restaurant channel) does not require payment. Apple Pay is only in the paid checkout flow above.
```

---

## App Privacy (nutrition labels) — checklist

In App Store Connect → App Privacy, declare only what the app actually collects (align with `https://eatwaze.com/privacy`):

- Contact info (email, name) — Account
- Location (precise / coarse) — for nearby restaurants (user-provided or device)
- User content (photos, videos, posts) — if users upload
- Identifiers / usage data — analytics / crash if used
- Purchases — only if IAP or order payments are live for this binary

Link Privacy Policy URL to `https://eatwaze.com/privacy` on the new listing.
