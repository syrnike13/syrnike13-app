# syrnike13 Flutter

Native Flutter client for iOS, Android, and macOS.

## Current foundation

- Material 3 app shell with adaptive mobile/macOS navigation.
- Production backend defaults matching `apps/web`.
- Login through `POST /auth/session/login`.
- Session persistence through platform secure storage.
- Restored-session checks through `/onboard/hello` and `/users/@me`.
- Native camera/microphone permission declarations.
- LiveKit client dependency and a small connection service entry point.

## Commands

```bash
flutter pub get
flutter analyze
flutter test
flutter build apk --debug
```

## Runtime config

Use Dart defines to point the app at a local backend:

```bash
flutter run \
  --dart-define=SYRNIKE_API_URL=http://127.0.0.1:8000/api \
  --dart-define=SYRNIKE_WS_URL=ws://127.0.0.1:8000/ws
```
