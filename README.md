# Piper_Approves

Local dev app for connecting to Etsy's API (OAuth 2.0 with PKCE) and syncing/managing shop listings.

## Setup

1. In the [Etsy Developer portal](https://www.etsy.com/developers/your-apps), open your app and set its
   **Redirect URI** to `http://localhost:3000/etsy-callback` (must match exactly, including port).
2. Copy `.env.example` to `.env` and fill in `ETSY_KEYSTRING` (your app's Keystring/API key).
3. Install dependencies and start the server:

   ```
   npm install
   npm start
   ```

4. Open `http://localhost:3000` and click "Connect to Etsy" to complete the OAuth flow. Tokens are saved
   locally to `tokens.json` (gitignored, not committed).
5. Visit `http://localhost:3000/listings` to see your shop's active listings.
