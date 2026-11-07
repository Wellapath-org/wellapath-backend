// PoC only. Mobile-style Community auth client (email OTP, bearer tokens, refresh, sign-out).
// dart:io only. Tokens are persisted to a 0600 file as a stand-in for flutter_secure_storage.
import 'dart:convert';
import 'dart:io';

late Uri base;
final client = HttpClient();
var failures = 0;

Future<(int, Map<String, dynamic>, HttpHeaders)> call(String method, String path,
    {String? bearer, Map<String, dynamic>? body}) async {
  final req = await client.openUrl(method, base.resolve(path));
  if (bearer != null) req.headers.set('authorization', 'Bearer $bearer');
  if (body != null) {
    req.headers.contentType = ContentType.json;
    req.write(jsonEncode(body));
  }
  final res = await req.close();
  final text = await res.transform(utf8.decoder).join();
  Map<String, dynamic> json = {};
  if (text.isNotEmpty) {
    final decoded = jsonDecode(text);
    if (decoded is Map<String, dynamic>) json = decoded;
  }
  return (res.statusCode, json, res.headers);
}

void check(String step, bool ok, [Object? detail]) {
  stdout.writeln('${ok ? 'PASS' : 'FAIL'}  $step${detail == null ? '' : '  ->  $detail'}');
  if (!ok) failures++;
}

String arg(List<String> args, String name) {
  final i = args.indexOf('--$name');
  if (i < 0 || i + 1 >= args.length) throw ArgumentError('missing --$name');
  return args[i + 1];
}

Future<String> readOtp(String outboxPath, String email) async {
  for (var i = 0; i < 20; i++) {
    final file = File(outboxPath);
    if (await file.exists()) {
      final lines = (await file.readAsLines()).reversed;
      for (final line in lines) {
        final m = jsonDecode(line) as Map<String, dynamic>;
        if (m['to'] == email.toLowerCase()) return m['otp'] as String;
      }
    }
    await Future<void>.delayed(const Duration(milliseconds: 100));
  }
  throw StateError('no OTP in outbox for $email');
}

Future<void> saveStore(File store, Map<String, String> tokens) async {
  await store.writeAsString(jsonEncode(tokens));
  await Process.run('chmod', ['600', store.path]);
}

Future<void> main(List<String> args) async {
  base = Uri.parse(arg(args, 'base'));
  final outbox = arg(args, 'outbox');
  final store = File(arg(args, 'store'));
  final email = arg(args, 'email');

  // 0. Feature flag before sign-in.
  var (s, j, _) = await call('GET', '/v1/features');
  check('GET /v1/features (signed out)', s == 200 && j['community_allowed'] == false, j);

  // 1. Request an email OTP.
  (s, j, _) = await call('POST', '/v1/auth/email-otp/send-verification-otp',
      body: {'email': email, 'type': 'sign-in'});
  check('request email OTP', s == 200, s);
  final otp = await readOtp(outbox, email);
  check('OTP captured from test outbox (6 digits)', RegExp(r'^\d{6}$').hasMatch(otp));

  // 2. Sign up / sign in with the OTP.
  (s, j, _) = await call('POST', '/v1/auth/sign-in/email-otp', body: {'email': email, 'otp': otp});
  final sessionToken = j['token'] as String?;
  final userId = (j['user'] as Map<String, dynamic>?)?['id'];
  check('sign in with OTP -> session token', s == 200 && sessionToken != null, 'user=$userId');

  // 3. Mint a short-lived access token and store both.
  (s, j, _) = await call('GET', '/v1/auth/token', bearer: sessionToken);
  var accessToken = j['token'] as String?;
  check('mint access token (JWT)', s == 200 && accessToken != null);
  await saveStore(store, {'session_token': sessionToken!, 'access_token': accessToken!});
  final mode = (await store.stat()).modeString();
  check('tokens persisted to store (mode $mode)', mode == 'rw-------');

  // 4. Authenticated calls, reading the token back from the store like an app restart would.
  final stored = jsonDecode(await store.readAsString()) as Map<String, dynamic>;
  (s, j, _) = await call('GET', '/v1/community/me', bearer: stored['access_token'] as String);
  check('GET /v1/community/me with stored access token', s == 200 && j['id'] == userId, j);
  (s, j, _) = await call('GET', '/v1/features', bearer: accessToken);
  check('GET /v1/features (signed in)', s == 200 && j.containsKey('community_allowed'), j);

  // 5. Refresh: new access token from the session token.
  await Future<void>.delayed(const Duration(milliseconds: 1100));
  (s, j, _) = await call('GET', '/v1/auth/token', bearer: sessionToken);
  final refreshed = j['token'] as String?;
  check('refresh access token', s == 200 && refreshed != null && refreshed != accessToken);
  accessToken = refreshed!;
  await saveStore(store, {'session_token': sessionToken, 'access_token': accessToken});
  (s, j, _) = await call('GET', '/v1/community/me', bearer: accessToken);
  check('authenticated call with refreshed token', s == 200);

  // 6. Sign out, clear the store, and prove the old access token is dead server-side.
  (s, j, _) = await call('POST', '/v1/auth/sign-out', bearer: sessionToken, body: {});
  check('sign out', s == 200, j);
  await store.delete();
  check('token store cleared', !await store.exists());
  (s, j, _) = await call('GET', '/v1/community/me', bearer: accessToken);
  check('old access token rejected after sign-out (401 session_revoked)',
      s == 401 && (j['error'] as Map?)?['code'] == 'session_revoked', j);
  (s, j, _) = await call('GET', '/v1/auth/token', bearer: sessionToken);
  check('old session token cannot refresh (401)', s == 401, s);

  // 7. /config is untouched by Community.
  (s, j, _) = await call('GET', '/config');
  check('GET /config still 200', s == 200 && j['version'] == '1.0');

  client.close();
  stdout.writeln(failures == 0 ? 'RESULT: ALL STEPS PASSED' : 'RESULT: $failures FAILED');
  exit(failures == 0 ? 0 : 1);
}
