# Camera face login

The app now uses its front-camera screen for both registration and login. It
captures images automatically and follows server-issued head-position prompts.
There is no second OS biometric dialog. Fingerprint authentication still uses
the phone's fingerprint prompt.

## Deploy

Deploy the mobile and backend changes together. Before restarting the API:

```sh
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
```

The migration adds `FaceLoginDevice` and `FaceLoginAttempt`. It has been generated
but has **not** been applied to a running database by this change.

Nest copies `face-engine.worker.cjs` to `dist/src/face-login` alongside the compiled
service. Keep production dependencies, including Human's `models` directory and
TensorFlow's WASM files, in the deployment. Recognition runs locally on the API
server in a worker thread; it does not call a third-party recognition API or
require a paid recognition account. Use HTTPS between the app and the API.

`FACE_LOGIN_ENCRYPTION_KEY` can be set to a stable, independently generated secret.
When omitted, encryption derives a purpose-specific key from the existing
`JWT_SECRET`. Changing the effective key makes existing face templates unreadable
and requires re-enrollment. Do not log camera uploads, descriptors, device secrets,
or the `x-face-session` header.

After deploying, sign in normally, open profile Security, enable Face login, and
follow the camera instructions to register. Existing OS Face ID / face-unlock
settings do not register a face for this new flow. If the old biometric setting is
already enabled, disable it and enable Face again to register.

## Verification and storage

- Enrollment requires an authenticated account and a live camera sequence.
- Login requires this device's enrollment secret plus a matching live sequence.
- Each attempt expires after two minutes, accepts at most 24 frames, and completes
  only once. The server chooses the order of left/right turns.
- Every accepted frame must contain one clear face, pass the liveness/anti-spoof
  checks, match the requested pose, and match the preceding accepted identity.
- Login also matches every accepted frame against encrypted enrollment templates.
  Tokens are returned only after the final accepted frame and account checks.
- Verification starts are limited to five per device per 15 minutes. Enrollment
  starts are limited to five per account per 15 minutes. Add normal edge/API rate
  limits for internet traffic as part of deployment.
- AES-256-GCM protects server templates. Device enrollment secrets are stored in
  Keychain/Keystore; the server stores their hashes. Camera files are deleted after
  each upload, and the server does not store raw images. Expired attempts are
  cleaned when a new attempt starts. Account deletion cascades to its templates.
- Disabling camera face login revokes the local device registration. The existing
  account biometric flag also prevents verification when disabled.

## Validation and limits

The tests cover real model loading/embedding extraction, blank and malformed
images, matching/mismatch decisions, pose and liveness checks, rate limits,
expiration, replay, cancellation, and camera UI completion. Run:

```sh
npm test -- --runInBand face-login
```

These are RGB camera models, not hardware-backed Face ID or a certified
anti-spoofing service. The default match (0.8) and liveness/anti-spoof (0.9)
thresholds are conservative starting values, **not measured security guarantees**.
Before production use, validate genuine-user acceptance, impostors, printed
photos, screen/video replay, lighting, and pose direction on the supported phones.
Do not lower thresholds merely to make one sample pass. Keep password login
available. Real-device accuracy and spoof resistance have not been validated in
this development environment.

Model/runtime references: [Human](https://github.com/vladmandic/human),
[models and provenance](https://github.com/vladmandic/human/wiki/Models).
