# Updating the existing Render service safely

1. Keep the current Render service and its URL. Do not delete it.
2. Back up the current GitHub repository or create a branch before replacing application source files.
3. Upload the contents of this ZIP to the root of the GitHub repository currently connected to Render. Keep the repository root layout (`server.js`, `package.json`, `public/`, `render.yaml`).
4. Render settings: Runtime Node, Build `npm install`, Start `npm start`, Root Directory blank, branch `main` (or the branch actually used by your repository).
5. Keep existing `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `GEMINI_API_KEY`, and `GEMINI_MODEL` environment variables.
6. For the in-app **Push to GitHub** button only, add `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, and `GITHUB_BRANCH` in Render Environment. The token must have Contents: Read and write permission for the target repository. Save/redeploy after adding them.
7. Open Diagnostics. Confirm Gemini, admin, session and workspace checks pass. GitHub should pass only after its four variables are set.
8. Test: login; import a ZIP containing a small HTML/CSS/JS test; select HTML; preview; edit CSS; save; click Refresh and verify the editor reloads; preview again; export ZIP; then test GitHub push only after GitHub is configured.

Important: Render's GitHub connection deploys this application from the repository. The in-app Push to GitHub button publishes files from the app's workspace. They are two separate functions.


## Admin login compatibility update
The server now includes a fallback to the existing ADVEYRA admin username and bcrypt password hash if the Render variables are absent. For reliable production login, set these exact Render Environment values as well:
- ADMIN_USERNAME: adveyraadmin
- ADMIN_PASSWORD_HASH: the bcrypt hash supplied for the existing installation
Do not replace the hash with the plain-text password. The original plain-text password cannot be recovered from a bcrypt hash. If Render already has different values, those environment values take precedence and must be updated to match. Do not change SESSION_SECRET as part of this login fix.
