# PropertyBuddy (v1: England & Wales)
`npm install && npm start`, then open http://localhost:3000 (Node 18+). Search by full UK postcode.

Live: postcodes.io geocoding, HM Land Registry Price Paid (comps), data.police.uk (crime).
Still mock: Condition tab, cushion calculator, auth/tiers, specs, street rates, schools/demographics.
TODO next: EPC (new "Get energy performance of buildings data" service), House Price Index, address autocomplete.

## Auth and billing
Copy `.env.example` to `.env` (Node 18+; run `npm install`). Accounts live in SQLite (`propertybuddy.db`); passwords use scrypt; sessions are signed httpOnly cookies.
Basic = anonymous or signed-in free; Subscribed unlocks the Condition and Demographics tabs. Crime data is withheld by the server for Basic users.
Stripe: set STRIPE_SECRET_KEY, STRIPE_PRICE_ID (a recurring GBP price) and STRIPE_WEBHOOK_SECRET, and point a webhook at /api/stripe/webhook for checkout.session.completed and customer.subscription.updated/deleted.
With Stripe unset, the plan buttons switch your tier locally for testing; that route is disabled in production or once Stripe is configured.

## EPC
Needs EPC_API_TOKEN (see .env.example). The search path and field names are assumptions until checked against the service's API guidance; run with EPC_DEBUG=1 to see a raw row, then adjust EPC_SEARCH_PATH or the field mapping in server.js. Read the data's licence terms before charging for EPC-derived features.

## Deploy (Render)
Push to GitHub, then Render: New -> Blueprint, select the repo (uses render.yaml). Fill in APP_URL, EPC_API_TOKEN and the Stripe values when prompted; SESSION_SECRET is generated. After the first deploy, set APP_URL to the real address and redeploy.
