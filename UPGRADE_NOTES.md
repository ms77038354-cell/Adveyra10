# ADVEYRA AI STUDIO – Agent & Preview Upgrade

## Included
- Fullscreen preview now shows a persistent **Back to Normal View** control. Escape also exits fullscreen.
- Added guided starter actions: analyse project, build CRM, add backend, and find/fix issues.
- Improved the coding agent instructions so it understands natural Hindi/English requests, inspects before editing, asks only essential questions, preserves existing features, and reports unverified steps honestly.
- Expanded the tool loop and added safe project-folder creation.
- Added a Backend API Tester for GET/POST/PUT/PATCH/DELETE requests, JSON headers/body, response status, latency and response body.
- Increased JSON payload allowance for multimodal image messages.

## Important limitations
- API Tester calls an already-running backend URL from the browser. The backend must permit CORS from this app. It does not provision a database or start arbitrary server processes on Render.
- The AI agent can edit workspace files but does not have unrestricted shell access, npm install, or a secure isolated runtime in this build. Backend projects still need deployment on a connected host (for example Render) and a database provider (for example Supabase).
- Voice transcription depends on browser speech-recognition support.
- GitHub push still requires `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, and optionally `GITHUB_BRANCH` in the hosting environment. Render must separately be connected to the same repository with Auto-Deploy enabled.

## Deployment safety
1. Export a fresh backup of your current workspace before replacing files.
2. Replace the app source from this ZIP in your repository. Do not delete your Render service or database.
3. Keep all existing Render environment variables. Do not commit `.env` or tokens.
4. Push to GitHub and check Render's deployment logs.
5. Sign in, open Diagnostics, test fullscreen exit, and test the API Tester against a non-production health endpoint first.


## Multi-provider AI upgrade
- Added Gemini/OpenAI provider selection and model selection in the authenticated AI Settings panel.
- Added encrypted server-side storage for provider API keys and optional project key/value variables. Encryption uses SESSION_SECRET; keep it stable or saved settings cannot be decrypted.
- Added provider connection checks (OpenAI authentication and Gemini selected-model reachability).
- Added OpenAI Responses API agent loop with project file tools (list/read/create folder/write with backup), plus image input.
- Added assistant response Copy and browser text-to-speech controls.
- Gemini remains selectable and existing Gemini function-calling path is retained.
- OpenAI API usage is billed separately from ChatGPT subscription. No free unlimited OpenAI API tier is assumed.
- Environment variables saved in the settings panel are encrypted but are not injected into a live app runtime yet. Backend process execution/database provisioning is not included.
- On Render Free, local encrypted settings may be lost on restart/redeploy. For production, use Render environment variables or attach persistent storage before relying on in-app key storage.
- No real API key was supplied, so provider calls were not end-to-end tested.
