// PoC only. Mobile-style Community auth client against the contract facade (/v1/auth/*):
// email OTP, TokenPair, rotating refresh, sign-out. dart:io only. Only the refresh token is
// persisted (0600 file, stand-in for flutter_secure_storage); the access token stays in memory.
import 'dart:convert';
import 'dart:io';
import 'dart:math';

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

String uuidV4() {
  final r = Random.secure();
  final b = List<int>.generate(16, (_) => r.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
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

  // 1. Request an email OTP (always 202 {}).
  (s, j, _) = await call('POST', '/v1/auth/otp/request', body: {'email': email});
  check('POST /v1/auth/otp/request -> 202', s == 202, s);
  final otp = await readOtp(outbox, email);
  check('OTP captured from test outbox (6 digits)', RegExp(r'^\d{6}$').hasMatch(otp));

  // 2. Sign up / sign in with the OTP -> TokenPair. device_id is generated once per install.
  final deviceId = uuidV4();
  (s, j, _) = await call('POST', '/v1/auth/otp/verify',
      body: {'email': email, 'code': otp, 'device_id': deviceId, 'device_label': 'Dart CLI'});
  var accessToken = j['access_token'] as String?;
  var refreshToken = j['refresh_token'] as String?;
  final userId = (j['account'] as Map<String, dynamic>?)?['account_id'];
  check('otp/verify -> TokenPair (account_created ${j['account_created']})',
      s == 200 && accessToken != null && (refreshToken ?? '').startsWith('wprt_'), 'user=$userId');

  // 3. ONLY the refresh token is persisted (secure-storage stand-in); the access token stays
  //    in memory (contract §3.2).
  await saveStore(store, {'refresh_token': refreshToken!, 'device_id': deviceId});
  final mode = (await store.stat()).modeString();
  check('refresh token persisted to store (mode $mode)', mode == 'rw-------');

  // 4. Authenticated calls with the in-memory access token.
  (s, j, _) = await call('GET', '/v1/community/me', bearer: accessToken);
  check('GET /v1/community/me with access token', s == 200 && j['account_id'] == userId, j);
  (s, j, _) = await call('GET', '/v1/features', bearer: accessToken);
  check('GET /v1/features (signed in)', s == 200 && j.containsKey('community_allowed'), j);

  // 5. "App restart": read the refresh token back from the store and rotate it.
  final stored = jsonDecode(await store.readAsString()) as Map<String, dynamic>;
  final oldRefresh = stored['refresh_token'] as String;
  (s, j, _) = await call('POST', '/v1/auth/refresh',
      body: {'refresh_token': oldRefresh, 'device_id': stored['device_id']});
  final newRefresh = j['refresh_token'] as String?;
  check('refresh rotates the refresh token', s == 200 && newRefresh != null && newRefresh != oldRefresh);
  accessToken = j['access_token'] as String?;
  refreshToken = newRefresh!;
  await saveStore(store, {'refresh_token': refreshToken, 'device_id': deviceId});
  (s, j, _) = await call('GET', '/v1/community/me', bearer: accessToken);
  check('authenticated call with the refreshed access token', s == 200);

  // 6. Sign out, clear the store, and prove both tokens are dead server-side.
  (s, j, _) = await call('POST', '/v1/auth/logout', bearer: accessToken, body: {'refresh_token': refreshToken});
  check('POST /v1/auth/logout -> 204', s == 204, s);
  await store.delete();
  check('token store cleared', !await store.exists());
  (s, j, _) = await call('GET', '/v1/community/me', bearer: accessToken);
  final reason = ((j['error'] as Map?)?['details'] as Map?)?['reason'];
  check('old access token rejected after sign-out (401 session_revoked)',
      s == 401 && reason == 'session_revoked', j);
  (s, j, _) = await call('POST', '/v1/auth/refresh', body: {'refresh_token': refreshToken, 'device_id': deviceId});
  check('old refresh token cannot refresh (401)', s == 401, s);

  // 7. /config is untouched by Community.
  (s, j, _) = await call('GET', '/config');
  check('GET /config still 200', s == 200 && j['version'] == '1.0');

  client.close();
  stdout.writeln(failures == 0 ? 'RESULT: ALL STEPS PASSED' : 'RESULT: $failures FAILED');
  exit(failures == 0 ? 0 : 1);
}
