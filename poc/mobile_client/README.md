# Community auth PoC — Dart CLI client

Stands in for the Flutter app (same HTTP calls `Dio` would make) to prove the mobile flow
against a locally running backend. **PoC only; not shipped.** No real email is sent: the OTP is
read from the server's test-only outbox file.

```sh
dart run bin/client.dart --base http://127.0.0.1:3100 \
  --outbox /path/to/outbox.jsonl --store /path/to/token-store.json --email you@example.test
```

Steps: request OTP -> read OTP from outbox -> sign in -> store tokens (file, mode 0600, standing
in for `flutter_secure_storage`) -> mint access token -> call `/v1/community/me` and
`/v1/features` -> refresh access token -> sign out -> prove the old access token is rejected.
Exit code 0 only if every step behaves as expected.
